/* =============================================
   DrawingEditorView — Editor in tab Obsidian
   Apre il canvas in una tab dedicata, fuori dal
   DOM di CodeMirror → nessun conflitto
   handwriting Android.
   ============================================= */

import { ItemView, WorkspaceLeaf, TFile, Notice, Platform, Modal, App, MarkdownView, setIcon, ViewStateResult } from 'obsidian';
import type HandwritingPlugin from './main';
import { BackgroundPattern, DrawingCanvas, Stroke, TextElement } from './drawing-canvas';
import { strokesToSvg, parseSvgBackground, parseSvgStrokes, parseSvgText, SvgBackground } from './svg-utils';
import { getEffectiveBgColor, getEffectiveLineColor, getQuickPalette, remapStrokeColor, resolveIsDark, BgMode } from './settings';
import { t, type I18nKey } from './i18n';

export const VIEW_TYPE_HANDWRITING = 'inline-handwriting-editor';

/* =============================================
   Utilità condivise tra DrawingEditorView e DrawingModal
   ============================================= */

// Regex per trovare ![[svgPath]] nel file .md (nuovo formato wiki)
function wikiEmbedRegex(svgPath: string): RegExp {
	const esc = svgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp(`\\n?!\\[\\[${esc}\\]\\]\\n?`);
}

// Regex per trovare il code block legacy con l'id specifico
function codeBlockRegex(embedId: string): RegExp {
	const esc = embedId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
	return new RegExp('\\n?```inline-handwriting\\n.*?"id"\\s*:\\s*"' + esc + '".*?\\n```\\n?', 's');
}

// Applica una sostituzione sul file .md.
// Prova prima il formato wiki ![[svg]], poi il code block legacy come fallback.
export async function replaceInMdFile(
	mdPath: string,
	svgPath: string,
	embedId: string,
	replacement: string,
	plugin: HandwritingPlugin
): Promise<void> {
	const mdFile = plugin.app.vault.getAbstractFileByPath(mdPath);
	if (!(mdFile instanceof TFile)) { new Notice(t('error_file_not_found')); return; }
	const content = await plugin.app.vault.read(mdFile);
	let updated = content.replace(wikiEmbedRegex(svgPath), replacement);
	if (updated === content) updated = content.replace(codeBlockRegex(embedId), replacement);
	if (updated !== content) await plugin.app.vault.modify(mdFile, updated);
}

// Carica i tratti da un file SVG nel vault. Restituisce anche le dimensioni del viewBox.
async function loadStrokesFromSvg(
	svgPath: string,
	plugin: HandwritingPlugin
): Promise<{ strokes: Stroke[]; texts: TextElement[]; canvasWidth: number | null; canvasHeight: number | null; background: SvgBackground | null }> {
	const file = plugin.app.vault.getAbstractFileByPath(svgPath);
	if (file instanceof TFile) {
		const content = await plugin.app.vault.read(file);
		const m = content.match(/viewBox="0 0 (\d+) (\d+)"/);
		return {
			strokes: parseSvgStrokes(content),
			texts: parseSvgText(content),
			canvasWidth:  m ? parseInt(m[1] ?? '0') : null,
			canvasHeight: m ? parseInt(m[2] ?? '0') : null,
			background: content.includes('class="hwm-background"') ? parseSvgBackground(content) : null,
		};
	}
	return { strokes: [], texts: [], canvasWidth: null, canvasHeight: null, background: null };
}

// Salva il contenuto SVG del canvas su disco e aggiorna la preview inline.
export async function saveSvgToDisk(
	canvas: DrawingCanvas,
	svgPath: string,
	embedId: string,
	plugin: HandwritingPlugin
): Promise<void> {
	const svg = strokesToSvg(
		canvas.getStrokes(), canvas.getWidth(), canvas.getHeight(),
		canvas.getBgColor(), canvas.getLineColor(), canvas.getBackgroundPattern(), canvas.getLineSpacing(), canvas.getTextElements()
	);
	const folder = svgPath.substring(0, svgPath.lastIndexOf('/'));
	if (folder && !plugin.app.vault.getAbstractFileByPath(folder)) {
		await plugin.app.vault.createFolder(folder);
	}
	const existing = plugin.app.vault.getAbstractFileByPath(svgPath);
	if (existing instanceof TFile) {
		await plugin.app.vault.modify(existing, svg);
	} else {
		await plugin.app.vault.create(svgPath, svg);
	}
	plugin.refreshPreview(embedId, svg);
}

// Crea un bottone con icona Lucide via setIcon.
// Funzione standalone (non metodo) — usata da entrambe le classi editor.
function mkBtn(parent: HTMLElement, icon: string, key: I18nKey): HTMLElement {
	const label = t(key);
	const btn = parent.createEl('button', { cls: 'hwm_btn', attr: { title: label } });
	btn.setAttribute('data-hwm-key', key);
	btn.setAttribute('data-hwm-tooltip', label);
	let pressTimer: number | null = null;
	let showedHelp = false;
	const clearHelp = () => {
		if (pressTimer !== null) window.clearTimeout(pressTimer);
		pressTimer = null;
		if (!showedHelp) return;
		window.setTimeout(() => btn.classList.remove('hwm_show-tooltip'), 1400);
		showedHelp = false;
	};
	btn.addEventListener('pointerdown', () => {
		showedHelp = false;
		pressTimer = window.setTimeout(() => { btn.classList.add('hwm_show-tooltip'); showedHelp = true; }, 550);
	});
	btn.addEventListener('pointerup', clearHelp);
	btn.addEventListener('pointercancel', clearHelp);
	btn.addEventListener('pointerleave', clearHelp);
	// setIcon: inserisce l'SVG in modo sicuro (no innerHTML)
	setIcon(btn, icon);
	return btn;
}

function setButtonHelp(btn: HTMLElement, label: string) {
	btn.title = label;
	btn.setAttribute('data-hwm-tooltip', label);
}

/* =============================================
   buildEditorUI — Costruisce la toolbar e il canvas
   condivisi tra DrawingEditorView e DrawingModal.

   Accetta callback per i comportamenti specifici:
   - onClose: cosa fare quando si clicca X
   - afterCanvas: setup post-canvas (ResizeObserver su Android,
     requestAnimationFrame su Desktop)
   Restituisce { canvas, bgModeListener } per consentire
   alla classe chiamante di fare cleanup in onClose().
   ============================================= */
export async function buildEditorUI(opts: {
	el: HTMLElement;
	plugin: HandwritingPlugin;
	svgPath: string;
	embedId: string;
	sourcePath: string;
	onClose: () => void | Promise<void>;
	afterCanvas: (canvas: DrawingCanvas, scrollWrap: HTMLElement, canvasWidth: number) => void;
	doSave: () => Promise<void>;
	doDelete: () => Promise<void>;
}): Promise<{ canvas: DrawingCanvas; bgModeListener: (bgMode: string) => void }> {
	const { el, plugin } = opts;
	const isMobile = Platform.isMobile;
	const isDark   = resolveIsDark(plugin.settings.bgMode);
	const bgColor  = getEffectiveBgColor(plugin.settings);
	const lineColor = getEffectiveLineColor(plugin.settings);
	// Sfondo via CSS var: background-color: var(--hwm-bg) in .hwm_editor-view
	el.setCssProps({ '--hwm-bg': bgColor });

	// --- Top bar: contiene la toolbar centrata e il bottone X ---
	const topbar = el.createDiv({ cls: 'hwm_editor-topbar hwm_editor-topbar--modal' });
	if (isDark) topbar.classList.add('hwm_editor-topbar--dark');

	const toolbar = topbar.createDiv({ cls: 'hwm_toolbar hwm_editor-toolbar' });
	if (isDark) toolbar.classList.add('hwm_toolbar--dark');

	// Penna / Gomma
	const penBtn    = mkBtn(toolbar, 'pencil', 'btn_pen');
	penBtn.classList.add('hwm_active', 'hwm_pen-btn');
	const eraserBtn = mkBtn(toolbar, 'eraser', 'btn_eraser');
	eraserBtn.classList.add('hwm_eraser-btn');
	const highlighterBtn = mkBtn(toolbar, 'highlighter', 'btn_pen');
	setButtonHelp(highlighterBtn, 'Highlighter');
	highlighterBtn.classList.add('hwm_highlighter-btn');
	const textBtn = mkBtn(toolbar, 'text-cursor-input', 'btn_pen');
	setButtonHelp(textBtn, 'Type text');
	textBtn.classList.add('hwm_text-btn');
	const strokeSize = toolbar.createDiv({ cls: 'hwm_toolbar-group hwm_stroke-size' });
	const strokeSizeValue = strokeSize.createEl('span', { cls: 'hwm_stroke-size-value', text: '2 Px' });
	const strokeSizeInput = strokeSize.createEl('input', {
		cls: 'hwm_stroke-size-range', attr: { type: 'range', min: '1', max: '24', value: '2', title: 'Pen size', 'aria-label': 'Pen size' }
	});
	toolbar.createDiv({ cls: 'hwm_separator' });

	// Palette colori — valori importati da settings.ts (unica fonte di verità).
	// let (non const) perché il bgModeListener aggiorna la palette al cambio tema.
	let colors = getQuickPalette(plugin.settings, isDark);
	let activeColorIdx = 0; // indice del pallino attivo, usato per aggiornare setColor al cambio tema
	const colorWrap = toolbar.createDiv({ cls: 'hwm_colors' });
	const colorBtns: HTMLElement[] = [];
	const addColorButton = (c: string): HTMLElement => {
		const btn = colorWrap.createEl('button', {
			cls: 'hwm_color-btn',
			attr: { type: 'button', title: c, 'aria-label': `Quick colour ${c}` }
		});
		// Colore via CSS var: background-color: var(--hwm-btn-color) in .hwm_color-btn
		// Le dimensioni forzate sono ora nel CSS con !important (no più stili inline)
		btn.setCssProps({ '--hwm-btn-color': c });
		colorBtns.push(btn);
		return btn;
	};
	for (const c of colors) addColorButton(c);
	colorBtns[0]?.classList.add('hwm_active');
	const paletteBtn = mkBtn(toolbar, 'palette', 'btn_pen');
	setButtonHelp(paletteBtn, 'Add quick colour');
	paletteBtn.classList.add('hwm_palette-btn');

	// Appearance controls deliberately live in the same visual toolbar as the tools.
	const appearanceControls = toolbar.createDiv({ cls: 'hwm_toolbar-group hwm_appearance-controls' });
	const backgroundPicker = appearanceControls.createEl('input', {
		cls: 'hwm_background-picker', attr: { type: 'color', title: 'Background colour' }
	});
	const patternSelect = appearanceControls.createEl('select', {
		cls: 'hwm_pattern-select', attr: { title: 'Paper style', 'aria-label': 'Paper style' }
	});
	const spacingInput = appearanceControls.createEl('input', {
		cls: 'hwm_spacing-input', attr: { type: 'number', min: '12', max: '120', step: '1', title: 'Line spacing', 'aria-label': 'Line spacing' }
	});
	spacingInput.placeholder = 'Px';
	(['ruled', 'grid', 'dots', 'blank'] as BackgroundPattern[]).forEach(pattern => {
		const labels: Record<BackgroundPattern, string> = { ruled: 'Lines', grid: 'Grid', dots: 'Dots', blank: 'Blank' };
		patternSelect.createEl('option', { value: pattern, text: labels[pattern] });
	});
	toolbar.createDiv({ cls: 'hwm_separator' });

	// Undo / Redo / Clear
	const undoBtn  = mkBtn(toolbar, 'rotate-ccw', 'btn_undo');
	undoBtn.classList.add('hwm_undo-btn', 'hwm_action-btn');
	undoBtn.createEl('span', { cls: 'hwm_btn-label', text: 'Undo' });
	const redoBtn  = mkBtn(toolbar, 'rotate-cw', 'btn_redo');
	redoBtn.classList.add('hwm_redo-btn', 'hwm_action-btn');
	redoBtn.createEl('span', { cls: 'hwm_btn-label', text: 'Redo' });
	const clearBtn = mkBtn(toolbar, 'trash', 'btn_clear');
	clearBtn.classList.add('hwm_clear-btn', 'hwm_action-btn');
	clearBtn.createEl('span', { cls: 'hwm_btn-label', text: 'Clear' });
	toolbar.createDiv({ cls: 'hwm_separator' });

	// Salva / Elimina
	const saveBtn    = mkBtn(toolbar, 'save', 'btn_save');
	saveBtn.classList.add('hwm_save-btn', 'hwm_action-btn');
	saveBtn.createEl('span', { cls: 'hwm_btn-label', text: 'Save' });
	const deleteBtn  = mkBtn(toolbar, 'file-x', 'btn_delete');
	deleteBtn.classList.add('hwm_delete-btn', 'hwm_action-btn');
	deleteBtn.createEl('span', { cls: 'hwm_btn-label', text: 'Delete' });

	// Bottone chiudi (X): posizionato a destra via CSS absolute
	const closeBtn = mkBtn(topbar, 'x', 'btn_close');
	closeBtn.classList.add('hwm_close-btn');
	closeBtn.addEventListener('click', () => { void opts.onClose(); });
	// Uses the same native colour input as the paper-background control.
	const quickColorPicker = topbar.createEl('input', { cls: 'hwm_quick-colour-picker', attr: { type: 'color', 'aria-label': 'Quick pen colour' } });

	// --- Scroll container e canvas ---
	const scrollWrap  = el.createDiv({ cls: 'hwm_editor-scroll' });
	const canvasWrap  = scrollWrap.createDiv({ cls: 'hwm_canvas-wrap' });

	// Carica i tratti dal file SVG
	const { strokes, texts, canvasWidth: savedW, canvasHeight: savedH, background } = await loadStrokesFromSvg(opts.svgPath, plugin);
	const { canvasWidth, canvasHeight } = plugin.settings;
	// Usa le dimensioni salvate nel viewBox per preservare i tratti di sessioni precedenti più larghe
	const w = savedW ?? canvasWidth;
	const h = savedH ?? canvasHeight;
	const debugFn = plugin.settings.debugMode ? (msg: string) => new Notice(msg, 3000) : null;

	const canvas = new DrawingCanvas(canvasWrap, w, h, canvasHeight, isMobile, debugFn);
	canvas.setBackground(
		background?.color ?? bgColor,
		background?.lineColor ?? lineColor,
		background?.pattern ?? 'ruled',
		background?.spacing,
	);
	canvas.setColor(colors[0]!);
	// Su mobile: dito = scroll manuale dell'area che scorre davvero. For an
	// inline editor this is the Obsidian note itself, not the drawing widget.
	if (isMobile) {
		let scrollTarget: HTMLElement = scrollWrap;
		let parent = el.parentElement;
		while (parent) {
			const overflowY = getComputedStyle(parent).overflowY;
			if ((overflowY === 'auto' || overflowY === 'scroll') && parent.scrollHeight > parent.clientHeight) {
				scrollTarget = parent;
				break;
			}
			parent = parent.parentElement;
		}
		canvas.allowFingerScroll(scrollTarget);
	}

	// Carica i tratti con remapping colori al tema corrente
	if (strokes.length > 0) {
		const remapped = strokes.map(s => ({
			...s, color: remapStrokeColor(s.color, plugin.settings.bgMode)
		}));
		canvas.loadStrokes(remapped, texts);
	}

	// Setup specifico della classe chiamante (ResizeObserver su Android, rAF su Desktop)
	opts.afterCanvas(canvas, scrollWrap, canvasWidth);

	// Resize handle (visibile ma non interattivo)
	const handle = scrollWrap.createDiv({ cls: 'hwm_resize-handle hwm_resize-handle--disabled' });
	handle.createEl('span', { text: '⋯' });
	handle.classList.toggle('hwm_resize-handle--dark', isDark);

	// Listener bgMode: aggiorna toolbar, pallini colore e sfondo canvas al cambio tema.
	// Registrato da buildEditorUI e restituito alla classe per poterlo rimuovere in onClose().
	const bgModeListener = (bgMode: string) => {
		const dark = resolveIsDark(bgMode);
		topbar.classList.toggle('hwm_editor-topbar--dark', dark);
		toolbar.classList.toggle('hwm_toolbar--dark', dark);
		handle.classList.toggle('hwm_resize-handle--dark', dark);
		// Sfondo via CSS var (no stile inline)
		el.setCssProps({ '--hwm-bg': getEffectiveBgColor(plugin.settings) });
		// Aggiorna palette e colore attivo al nuovo tema
		const newColors = getQuickPalette(plugin.settings, dark);
		colors = [...newColors]; // aggiorna il riferimento usato dai click handler
		colorBtns.forEach((btn, i) => {
			btn.setCssProps({ '--hwm-btn-color': newColors[i] ?? '' });
			btn.setAttribute('title', newColors[i] ?? '');
		});
		canvas.setColor(colors[activeColorIdx]!); // aggiorna colore penna attivo
		// Aggiorna sfondo e righe nel canvas
		canvas.setBackground(canvas.getBgColor(), canvas.getLineColor(), canvas.getBackgroundPattern(), canvas.getLineSpacing());
		// Remap colori tratti al nuovo tema (dark ↔ light)
		canvas.remapStrokeColors(c => remapStrokeColor(c, bgMode as BgMode));
	};
	plugin.bgModeListeners.add(bgModeListener);

	// Auto-scroll quando il canvas si espande, ma solo se non si sta disegnando.
	// Durante il disegno, lo scroll sposterebbe il canvas e le coordinate salterebbero.
	canvas.onResize(() => {
		if (!canvas.isPointerDown()) scrollWrap.scrollTop = scrollWrap.scrollHeight;
	});

	// --- Event handlers ---
	const cv = canvas;

	const updateToolButtons = (mode: 'pen' | 'eraser' | 'highlighter' | 'text') => {
		penBtn.classList.toggle('hwm_active', mode === 'pen');
		eraserBtn.classList.toggle('hwm_active', mode === 'eraser');
		highlighterBtn.classList.toggle('hwm_active', mode === 'highlighter');
		textBtn.classList.toggle('hwm_active', mode === 'text');
	};
	penBtn.addEventListener('click', () => { cv.setMode('pen'); });
	eraserBtn.addEventListener('click', () => { cv.setMode('eraser'); });
	highlighterBtn.addEventListener('click', () => { cv.setMode('highlighter'); });
	textBtn.addEventListener('click', () => { cv.setMode('text'); });
	strokeSizeInput.addEventListener('input', () => {
		strokeSizeValue.setText(`${strokeSizeInput.value} Px`);
		cv.setLineWidth(Number(strokeSizeInput.value));
	});
	cv.onModeChange(updateToolButtons);
	const selectColor = (index: number) => {
		colorBtns.forEach(b => b.classList.remove('hwm_active'));
		colorBtns[index]?.classList.add('hwm_active');
		activeColorIdx = index;
		cv.setColor(colors[index]!);
	};
	const applyQuickColor = (index: number, color: string) => {
		if (index < 5) {
			const defaults = colors.slice(0, 5);
			defaults[index] = color;
			plugin.settings.defaultPalette = defaults;
		} else {
			plugin.settings.customPalette[index - 5] = color;
		}
		colors[index] = color;
		colorBtns[index]?.setCssProps({ '--hwm-btn-color': color });
		colorBtns[index]?.setAttribute('title', color);
		selectColor(index);
		void plugin.saveSettings();
	};
	let quickPickerTarget: number | null = null;
	const openQuickColourPicker = (index: number | null) => {
		quickPickerTarget = index;
		quickColorPicker.value = index === null ? '#f59e0b' : colors[index]!;
		// showPicker is the native, user-gesture-aware path used by Chromium/WebView.
		// Old Obsidian WebViews fall back to the same click behaviour as the paper picker.
		try { quickColorPicker.showPicker(); } catch { quickColorPicker.click(); }
	};
	quickColorPicker.addEventListener('change', () => {
		const color = quickColorPicker.value;
		const index = quickPickerTarget;
		quickPickerTarget = null;
		if (index !== null) { applyQuickColor(index, color); return; }
		if (colors.includes(color)) { new Notice('This colour is already in the quick palette.'); return; }
		if (plugin.settings.customPalette.length >= 5) { new Notice('Quick colour palette is limited to five extra colours.'); return; }
		plugin.settings.customPalette.push(color);
		colors.push(color);
		const btn = addColorButton(color);
		bindColorButton(btn);
		selectColor(colors.length - 1);
		void plugin.saveSettings();
	});
	const editQuickColor = (index: number) => openQuickColourPicker(index);
	let lastColourTap: { button: HTMLElement; at: number } | null = null;
	const bindColorButton = (btn: HTMLElement) => {
		btn.addEventListener('click', () => selectColor(colorBtns.indexOf(btn)));
		btn.addEventListener('dblclick', event => {
			event.preventDefault();
			event.stopPropagation();
			editQuickColor(colorBtns.indexOf(btn));
		});
		// Android WebView does not consistently emit dblclick for a touch/pen tap.
		// Detect a second tap here while the event still counts as a user gesture.
		btn.addEventListener('pointerup', event => {
			if (event.pointerType === 'mouse') return;
			const now = Date.now();
			if (lastColourTap?.button === btn && now - lastColourTap.at < 500) {
				event.preventDefault();
				event.stopPropagation();
				lastColourTap = null;
				editQuickColor(colorBtns.indexOf(btn));
				return;
			}
			lastColourTap = { button: btn, at: now };
		});
	};
	colorBtns.forEach(bindColorButton);
	paletteBtn.addEventListener('click', () => openQuickColourPicker(null));

	backgroundPicker.value = canvas.getBgColor();
	patternSelect.value = canvas.getBackgroundPattern();
	spacingInput.value = String(canvas.getLineSpacing());
	const applyAppearance = () => canvas.setBackground(
		backgroundPicker.value, canvas.getLineColor(), patternSelect.value as BackgroundPattern, Number(spacingInput.value),
	);
	backgroundPicker.addEventListener('input', applyAppearance);
	patternSelect.addEventListener('change', applyAppearance);
	spacingInput.addEventListener('change', applyAppearance);
	undoBtn.addEventListener('click', () => cv.undo());
	redoBtn.addEventListener('click', () => cv.redo());
	clearBtn.addEventListener('click', () => cv.clear());
	saveBtn.addEventListener('click', () => { void opts.doSave().then(() => new Notice(t('notice_saved'))); });
	deleteBtn.addEventListener('click', () => { void opts.doDelete(); });

	return { canvas, bgModeListener };
}

/* =============================================
   DrawingEditorView — Tab dedicata (Android)
   ============================================= */

export class DrawingEditorView extends ItemView {
	plugin: HandwritingPlugin;
	private canvas: DrawingCanvas | null = null;
	private embedId = '';
	private svgPath = '';
	private sourcePath = '';
	private saveTimer: number | null = null;
	// Listener per aggiornare la classe dark al cambio bgMode
	private bgModeListener: ((bgMode: string) => void) | null = null;
	// ResizeObserver per adattare il canvas al layout reale (inclusa rotazione schermo)
	private displayRo: ResizeObserver | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: HandwritingPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() { return VIEW_TYPE_HANDWRITING; }
	getDisplayText() { return 'Handwriting editor'; }
	getIcon() { return 'pencil'; }
	getEmbedId() { return this.embedId; }

	async setState(state: unknown, result: ViewStateResult) {
		// Cast a un tipo strutturato per accedere ai campi in modo type-safe
		const s = state as { id?: string; svg?: string; sourcePath?: string } | null;
		if (s?.id) this.embedId = s.id;
		if (s?.svg) this.svgPath = s.svg;
		if (s?.sourcePath) this.sourcePath = s.sourcePath;
		// Costruisci la UI solo quando abbiamo i dati
		if (this.embedId && this.svgPath) await this.buildEditor();
		await super.setState(state, result);
	}

	getState() {
		return { id: this.embedId, svg: this.svgPath, sourcePath: this.sourcePath };
	}

	async onOpen() { /* UI costruita in setState */ }

	async onClose() {
		if (this.canvas) {
			await this.saveSvg();
			this.canvas.destroy();
			this.canvas = null;
		}
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		// Deregistra il listener bgMode
		if (this.bgModeListener) {
			this.plugin.bgModeListeners.delete(this.bgModeListener);
			this.bgModeListener = null;
		}
		// Ferma l'osservatore di resize (orientamento schermo)
		this.displayRo?.disconnect();
		this.displayRo = null;
	}

	private async buildEditor() {
		const el = this.contentEl;
		el.empty();
		el.classList.add('hwm_editor-view');

		const { canvas, bgModeListener } = await buildEditorUI({
			el,
			plugin: this.plugin,
			svgPath: this.svgPath,
			embedId: this.embedId,
			sourcePath: this.sourcePath,
			// Chiude la tab dopo aver salvato
			onClose: async () => { await this.saveSvg(); this.leaf.detach(); },
			// Adatta il canvas alla larghezza reale e la mantiene sincronizzata
			// ad ogni cambio orientamento (portrait ↔ landscape).
			// expandWorld=false: la larghezza logica del mondo resta canvasWidth
			// → il viewBox dell'SVG salvato non cresce con la larghezza del tablet,
			//   evitando che la preview inline si accorci e mostri sfondo nero sotto.
			afterCanvas: (cv, scrollWrap) => {
				this.displayRo = new ResizeObserver(() => {
					const displayW = scrollWrap.clientWidth || el.clientWidth;
					if (displayW === 0) return;
					cv.setDisplayWidth(displayW, false);
				});
				this.displayRo.observe(scrollWrap);
				this.displayRo.observe(el);
			},
			doSave: () => this.saveSvg(),
			doDelete: () => this.doDelete(),
		});

		this.canvas = canvas;
		this.bgModeListener = bgModeListener;

		// Auto-save debounced (2s dopo l'ultimo cambiamento)
		canvas.onChange(() => {
			if (this.saveTimer) window.clearTimeout(this.saveTimer);
			this.saveTimer = window.setTimeout(() => { void this.saveSvg(); }, 2000);
		});
	}

	private async saveSvg() {
		if (!this.canvas) return;
		await saveSvgToDisk(this.canvas, this.svgPath, this.embedId, this.plugin);
	}

	// Overlay di conferma inline (come DrawingModal) — evita window.confirm() che
	// non funziona in Electron e ruba il focus dalla finestra principale.
	private showDeleteConfirm(): Promise<boolean> {
		return new Promise(resolve => {
			const overlay = this.contentEl.createDiv({ cls: 'hwm_confirm-overlay' });
			overlay.createEl('span', { text: t('confirm_delete'), cls: 'hwm_confirm-msg' });
			const okBtn     = overlay.createEl('button', { text: t('confirm_ok'), cls: 'mod-warning' });
			const cancelBtn = overlay.createEl('button', { text: t('confirm_cancel') });
			okBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });
			cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
			okBtn.focus();
		});
	}

	private async doDelete() {
		if (!await this.showDeleteConfirm()) return;
		if (this.canvas) { this.canvas.destroy(); this.canvas = null; }
		await replaceInMdFile(this.sourcePath, this.svgPath, this.embedId, '\n', this.plugin);
		const svgFile = this.plugin.app.vault.getAbstractFileByPath(this.svgPath);
		if (svgFile instanceof TFile) await this.plugin.app.fileManager.trashFile(svgFile);
		this.leaf.detach();
		new Notice(t('notice_deleted'));
	}
}

/* =============================================
   DrawingModal — Editor disegno come Modal overlay.
   Aperto tramite bottone portale (document.body)
   per evitare tap su widget CM6.
   ============================================= */

export class DrawingModal extends Modal {
	private plugin: HandwritingPlugin;
	private embedId: string;
	private svgPath: string;
	private sourcePath: string;
	private canvas: DrawingCanvas | null = null;
	private saveTimer: number | null = null;
	// Listener per aggiornare la classe dark al cambio bgMode
	private bgModeListener: ((bgMode: string) => void) | null = null;
	// Chiude il modal al resize finestra (evita bug canvas su Windows)
	private resizeHandler: (() => void) | null = null;
	// Callback invocato alla chiusura del modal (usato per nascondere/mostrare il bottone matita)
	onClosed?: () => void;

	constructor(app: App, plugin: HandwritingPlugin, embedId: string, svgPath: string, sourcePath: string) {
		super(app);
		this.plugin = plugin;
		this.embedId = embedId;
		this.svgPath = svgPath;
		this.sourcePath = sourcePath;
		this.modalEl.addClass('hwm_modal');
	}

	async onOpen() {
		this.contentEl.addClass('hwm_editor-view');
		await this.buildEditor();

		// RAF evita falso positivo: il resize iniziale generato dall'apertura del modal stesso
		window.requestAnimationFrame(() => {
			this.resizeHandler = () => this.close();
			window.addEventListener('resize', this.resizeHandler);
		});
	}

	onClose() {
		// Rimuove listener resize prima del cleanup principale
		if (this.resizeHandler) {
			window.removeEventListener('resize', this.resizeHandler);
			this.resizeHandler = null;
		}
		void (async () => {
			if (this.canvas) {
				await this.saveSvg();
				this.canvas.destroy();
				this.canvas = null;
			}
			if (this.saveTimer) window.clearTimeout(this.saveTimer);
			// Deregistra il listener bgMode
			if (this.bgModeListener) {
				this.plugin.bgModeListeners.delete(this.bgModeListener);
				this.bgModeListener = null;
			}
			// Notifica il chiamante che il modal è stato chiuso
			this.onClosed?.();
		})();
	}

	private async buildEditor() {
		const el = this.contentEl;

		const { canvas, bgModeListener } = await buildEditorUI({
			el,
			plugin: this.plugin,
			svgPath: this.svgPath,
			embedId: this.embedId,
			sourcePath: this.sourcePath,
			// Chiude il modal (Obsidian gestisce il cleanup via onClose)
			onClose: () => this.close(),
			// Espande il canvas a tutta la larghezza del modal eliminando le bande laterali.
			// requestAnimationFrame garantisce che il layout del modal sia pronto prima di misurarlo.
			afterCanvas: (cv, scrollWrap, canvasWidth) => {
				window.requestAnimationFrame(() => {
					const displayW = scrollWrap.clientWidth;
					if (displayW > canvasWidth) cv.setDisplayWidth(displayW);
				});
			},
			doSave: () => this.saveSvg(),
			doDelete: () => this.doDelete(),
		});

		this.canvas = canvas;
		this.bgModeListener = bgModeListener;

		// Auto-save debounced (2s dopo l'ultimo cambiamento)
		canvas.onChange(() => {
			if (this.saveTimer) window.clearTimeout(this.saveTimer);
			this.saveTimer = window.setTimeout(() => { void this.saveSvg(); }, 2000);
		});
	}

	private async saveSvg() {
		if (!this.canvas) return;
		await saveSvgToDisk(this.canvas, this.svgPath, this.embedId, this.plugin);
	}

	// Overlay di conferma inline: nessun Modal annidato → nessun furto di focus
	private showDeleteConfirm(): Promise<boolean> {
		return new Promise(resolve => {
			const overlay = this.contentEl.createDiv({ cls: 'hwm_confirm-overlay' });
			overlay.createEl('span', { text: t('confirm_delete'), cls: 'hwm_confirm-msg' });
			const okBtn = overlay.createEl('button', { text: t('confirm_ok'), cls: 'mod-warning' });
			const cancelBtn = overlay.createEl('button', { text: t('confirm_cancel') });
			okBtn.addEventListener('click', () => { overlay.remove(); resolve(true); });
			cancelBtn.addEventListener('click', () => { overlay.remove(); resolve(false); });
			okBtn.focus();
		});
	}

	private async doDelete() {
		if (!await this.showDeleteConfirm()) return;
		if (this.canvas) { this.canvas.destroy(); this.canvas = null; }

		const srcPath = this.sourcePath;
		const ws = this.app.workspace;
		let focusDone = false;

		// Funzione di focus: aspetta 300ms dopo che vault.modify ha sparato,
		// in modo da dare all'editor il tempo di completare il re-render del documento.
		const doFocus = () => {
			if (focusDone) return;
			focusDone = true;
			window.setTimeout(() => {
				let mdView = ws.getActiveViewOfType(MarkdownView);
				if (!mdView || mdView.file?.path !== srcPath) {
					const leaf = ws.getLeavesOfType('markdown')
						.find(l => (l.view as MarkdownView).file?.path === srcPath);
					if (leaf) ws.setActiveLeaf(leaf, { focus: true });
					mdView = ws.getActiveViewOfType(MarkdownView);
				}
				// Focus diretto sul contenteditable CM6
				const cm = mdView?.contentEl.querySelector<HTMLElement>('.cm-content');
				cm?.focus();
			}, 300);
		};

		// Registra il listener PRIMA di modificare il file, così non perdiamo l'evento.
		const ref = this.app.vault.on('modify', (file) => {
			if (file.path === srcPath) {
				this.app.vault.offref(ref);
				doFocus();
			}
		});

		await replaceInMdFile(srcPath, this.svgPath, this.embedId, '\n', this.plugin);
		const svgFile = this.app.vault.getAbstractFileByPath(this.svgPath);
		if (svgFile instanceof TFile) await this.app.fileManager.trashFile(svgFile);

		// Fallback: se vault.modify non spara entro 3s (caso anomalo), forza comunque il focus
		window.setTimeout(() => { this.app.vault.offref(ref); doFocus(); }, 3000);

		this.close();
		new Notice(t('notice_deleted'));
	}
}

/* =============================================
   DrawingEditorView — Editor in tab Obsidian
   Apre il canvas in una tab dedicata, fuori dal
   DOM di CodeMirror → nessun conflitto
   handwriting Android.
   ============================================= */

import { ItemView, WorkspaceLeaf, TFile, Notice, Platform, Modal, App, MarkdownView, setIcon, ViewStateResult } from 'obsidian';
import type HandwritingPlugin from './main';
import { BackgroundPattern, DrawingCanvas, Stroke, TextElement, ImageElement } from './drawing-canvas';
import { strokesToSvg, parseSvgBackground, parseSvgStrokes, parseSvgText, parseSvgImages, SvgBackground } from './svg-utils';
import { getEffectiveBgColor, getEffectiveLineColor, getQuickPalette, remapStrokeColor, resolveIsDark, BgMode } from './settings';
import { t, type I18nKey } from './i18n';

export const VIEW_TYPE_HANDWRITING = 'inline-handwriting-editor';

// Serialize writes per SVG. Without this, a delayed save from the editor that
// Obsidian just unmounted can finish after a newer editor save and overwrite it.
const svgSaveQueues = new Map<string, Promise<void>>();

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
): Promise<{ strokes: Stroke[]; texts: TextElement[]; images: ImageElement[]; canvasWidth: number | null; canvasHeight: number | null; background: SvgBackground | null }> {
	const file = plugin.app.vault.getAbstractFileByPath(svgPath);
	if (file instanceof TFile) {
		const content = plugin.getSvgSnapshot(svgPath) ?? await plugin.app.vault.read(file);
		const m = content.match(/viewBox="0 0 (\d+) (\d+)"/);
		return {
			strokes: parseSvgStrokes(content),
			texts: parseSvgText(content),
			images: parseSvgImages(content),
			canvasWidth:  m ? parseInt(m[1] ?? '0') : null,
			canvasHeight: m ? parseInt(m[2] ?? '0') : null,
			background: content.includes('class="hwm-background"') ? parseSvgBackground(content) : null,
		};
	}
	return { strokes: [], texts: [], images: [], canvasWidth: null, canvasHeight: null, background: null };
}

export function drawingCanvasToSvg(canvas: DrawingCanvas): string {
	return strokesToSvg(
		canvas.getStrokes(), canvas.getWidth(), canvas.getHeight(),
		canvas.getBgColor(), canvas.getLineColor(), canvas.getBackgroundPattern(),
		canvas.getLineSpacing(), canvas.getTextElements(), canvas.getImageElements(),
	);
}

// Salva il contenuto SVG del canvas su disco e aggiorna la preview inline.
export async function saveSvgToDisk(
	canvas: DrawingCanvas,
	svgPath: string,
	embedId: string,
	plugin: HandwritingPlugin
): Promise<void> {
	const svg = drawingCanvasToSvg(canvas);
	// Cache synchronously, before the first await, so an editor mounted during a
	// Reading/Edit mode switch loads these exact strokes immediately.
	plugin.cacheSvgSnapshot(svgPath, svg);
	const previousSave = svgSaveQueues.get(svgPath) ?? Promise.resolve();
	const currentSave = previousSave.catch(() => undefined).then(async () => {
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
	});
	svgSaveQueues.set(svgPath, currentSave);
	try {
		await currentSave;
	} finally {
		if (svgSaveQueues.get(svgPath) === currentSave) svgSaveQueues.delete(svgPath);
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
	const isInlineEditor = el.classList.contains('hwm_inline-editor');
	const bgColor  = getEffectiveBgColor(plugin.settings);
	const lineColor = getEffectiveLineColor(plugin.settings);
	
	el.setCssProps({ '--hwm-bg': bgColor });

	// --- 2. FLOATING TOOL BELT ---
	// Inline mode needs a full-width sticky positioning context: centring a wide
	// menu against the narrow belt itself can push it outside the tablet viewport.
	const toolBeltHost = isInlineEditor
		? el.createDiv({ cls: 'hwm_tool-belt-host' })
		: el;
	const toolBelt = toolBeltHost.createDiv({ cls: 'hwm_tool-belt' });

	// History Capsule
	const historyCap = toolBelt.createDiv({ cls: 'hwm_capsule' });
	const undoBtn = mkBtn(historyCap, 'rotate-ccw', 'btn_undo');
	undoBtn.classList.add('hwm_tool-btn');
	const redoBtn = mkBtn(historyCap, 'rotate-cw', 'btn_redo');
	redoBtn.classList.add('hwm_tool-btn');

	toolBelt.createDiv({ cls: 'hwm_belt-separator' });

	// Colors Capsule
	let colors = getQuickPalette(plugin.settings, isDark);
	let activeColorIdx = 0;
	const colorsCap = toolBelt.createDiv({ cls: 'hwm_capsule hwm_capsule--colors' });
	const colorBtns: HTMLInputElement[] = [];
	const addColorButton = (c: string): HTMLInputElement => {
		const btn = colorsCap.createEl('input', {
			cls: 'hwm_color-swatch',
			attr: { type: 'color', title: c, 'aria-label': `Quick colour ${c}` }
		});
		btn.value = c;
		colorBtns.push(btn);
		return btn;
	};
	for (const c of colors) addColorButton(c);
	colorBtns[0]?.classList.add('hwm_active');
	
	
	toolBelt.createDiv({ cls: 'hwm_belt-separator' });

	// Tools Capsule
	const toolsCap = toolBelt.createDiv({ cls: 'hwm_capsule' });
	const penBtn = mkBtn(toolsCap, 'pencil', 'btn_pen');
	penBtn.classList.add('hwm_tool-btn', 'hwm_active');
	
	const lassoBtn = mkBtn(toolsCap, 'mouse-pointer-2', 'btn_pen');
	setButtonHelp(lassoBtn, 'Select & Move');
	lassoBtn.classList.add('hwm_tool-btn');
	
	const highlighterBtn = mkBtn(toolsCap, 'highlighter', 'btn_pen');
	setButtonHelp(highlighterBtn, 'Highlighter');
	highlighterBtn.classList.add('hwm_tool-btn');
	
	const eraserBtn = mkBtn(toolsCap, 'eraser', 'btn_eraser');
	eraserBtn.classList.add('hwm_tool-btn');
	
	const textBtn = mkBtn(toolsCap, 'type', 'btn_pen');
	setButtonHelp(textBtn, 'Type text');
	textBtn.classList.add('hwm_tool-btn');
	const imageBtn = mkBtn(toolsCap, 'image-plus', 'btn_pen');
	setButtonHelp(imageBtn, 'Add image');
	imageBtn.classList.add('hwm_tool-btn');

	const moreBtn = mkBtn(toolsCap, 'more-horizontal', 'btn_pen');
	setButtonHelp(moreBtn, 'More Actions');
	moreBtn.classList.add('hwm_tool-btn');

	// In an inline editor the menu belongs to the sticky tool belt itself. This
	// avoids viewport-coordinate calculations (which are unreliable below
	// transformed Obsidian containers) and makes the menu follow the belt by CSS.
	const overlay = (isInlineEditor ? toolBeltHost : el).createDiv({ cls: 'hwm_more-overlay' });
	const sheet = overlay.createDiv({ cls: 'hwm_more-sheet' });
	sheet.createDiv({ cls: 'hwm_sheet-drag-handle' });

	// --- 3. CANVAS AREA ---
	const canvasWrap = el.createDiv({ cls: 'hwm_main-canvas-area' });
	const scrollWrap = canvasWrap.createDiv({ cls: 'hwm_editor-scroll' });
	const canvasInnerWrap = scrollWrap.createDiv({ cls: 'hwm_canvas-wrap' });

	const { strokes, texts, images, canvasWidth: savedW, canvasHeight: savedH, background } = await loadStrokesFromSvg(opts.svgPath, plugin);
	const { canvasWidth, canvasHeight } = plugin.settings;
	const w = savedW ?? canvasWidth;
	const h = savedH ?? canvasHeight;
	const debugFn = plugin.settings.debugMode ? (msg: string) => new Notice(msg, 3000) : null;

	const canvas = new DrawingCanvas(canvasInnerWrap, w, h, canvasHeight, isMobile, debugFn);
	// New images (including clipboard images) are inserted into the visible paper area.
	const updateImageInsertionPoint = () => canvas.setImageInsertionY(scrollWrap.scrollTop + 32);
	updateImageInsertionPoint();
	scrollWrap.addEventListener('scroll', updateImageInsertionPoint, { passive: true });
	canvas.setBackground(
		background?.color ?? bgColor,
		background?.lineColor ?? lineColor,
		background?.pattern ?? 'ruled',
		background?.spacing,
	);
	canvas.setColor(colors[0]!);

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

	// A handwriting block may contain only typed text. Load it even when there
	// are no pen strokes, otherwise reopening it from the other Obsidian mode
	// produces an apparently empty canvas.
	if (strokes.length > 0 || texts.length > 0 || images.length > 0) {
		const remapped = strokes.map(s => ({
			...s, color: remapStrokeColor(s.color, plugin.settings.bgMode)
		}));
	canvas.loadStrokes(remapped, texts, images);
	}

	opts.afterCanvas(canvas, scrollWrap, canvasWidth);

	const handle = scrollWrap.createDiv({ cls: 'hwm_resize-handle hwm_resize-handle--disabled' });
	handle.createEl('span', { text: '⋯' });
	handle.classList.toggle('hwm_resize-handle--dark', isDark);

	// Line Thickness
	const thickSec = sheet.createDiv({ cls: 'hwm_sheet-section' });
	const thickHeader = thickSec.createDiv({ cls: 'hwm_sheet-header' });
	thickHeader.createSpan({ text: 'Pen Thickness', cls: 'hwm_sheet-title' });
	const strokeSizeValue = thickHeader.createSpan({ text: '2', cls: 'hwm_sheet-value' });
	
	const thickBox = thickSec.createDiv({ cls: 'hwm_sheet-control-box' });
	const decThick = thickBox.createEl('button', { cls: 'hwm_sheet-stepper' }); setIcon(decThick, 'minus');
	const strokeSizeInput = thickBox.createEl('input', { cls: 'hwm_sheet-range', attr: { type: 'range', min: '1', max: '24', value: '2' } });
	const incThick = thickBox.createEl('button', { cls: 'hwm_sheet-stepper' }); setIcon(incThick, 'plus');
	
	decThick.addEventListener('click', () => {
		strokeSizeInput.value = Math.max(1, parseInt(strokeSizeInput.value) - 1).toString();
		strokeSizeInput.dispatchEvent(new Event('input'));
	});
	strokeSizeInput.addEventListener('input', () => { strokeSizeValue.textContent = strokeSizeInput.value; });
	incThick.addEventListener('click', () => {
		strokeSizeInput.value = Math.min(24, parseInt(strokeSizeInput.value) + 1).toString();
		strokeSizeInput.dispatchEvent(new Event('input'));
	});
	strokeSizeInput.addEventListener('input', () => { strokeSizeValue.textContent = strokeSizeInput.value; });

		const applyAppearance = () => canvas.setBackground(
		currentBgColor, canvas.getLineColor(), currentPattern, Number(spacingInput.value)
	);

	// Canvas Pattern
	const patSec = sheet.createDiv({ cls: 'hwm_sheet-section' });
	const patHeader = patSec.createDiv({ cls: 'hwm_sheet-header' });
	patHeader.createSpan({ text: 'Canvas Pattern', cls: 'hwm_sheet-title' });
	const patGrid = patSec.createDiv({ cls: 'hwm_pattern-grid' });
	const patternBtns: Record<BackgroundPattern, HTMLElement> = {
		ruled: patGrid.createEl('button', { cls: 'hwm_pattern-btn', text: 'Lined' }),
		grid: patGrid.createEl('button', { cls: 'hwm_pattern-btn', text: 'Grid' }),
		dots: patGrid.createEl('button', { cls: 'hwm_pattern-btn', text: 'Dots' }),
		blank: patGrid.createEl('button', { cls: 'hwm_pattern-btn', text: 'Plain' })
	};
	let currentPattern = canvas.getBackgroundPattern();
	if(patternBtns[currentPattern]) patternBtns[currentPattern].classList.add('hwm_active');

		// Pattern Spacing
	const bgSpaceSec = sheet.createDiv({ cls: 'hwm_sheet-section' });
	const spaceHeader = bgSpaceSec.createDiv({ cls: 'hwm_sheet-header' });
	spaceHeader.createSpan({ text: 'Pattern Spacing', cls: 'hwm_sheet-title' });
	const spacingValue = spaceHeader.createSpan({ text: `${canvas.getLineSpacing()}px`, cls: 'hwm_sheet-value-text' });
	
	const spaceBox = bgSpaceSec.createDiv({ cls: 'hwm_sheet-control-box' });
	const decSpace = spaceBox.createEl('button', { cls: 'hwm_sheet-stepper' }); setIcon(decSpace, 'minus');
	const spacingInput = spaceBox.createEl('input', { cls: 'hwm_sheet-range', attr: { type: 'range', min: '12', max: '120', step: '4', value: String(canvas.getLineSpacing()) } });
	const incSpace = spaceBox.createEl('button', { cls: 'hwm_sheet-stepper' }); setIcon(incSpace, 'plus');

	decSpace.addEventListener('click', () => {
		spacingInput.value = Math.max(12, parseInt(spacingInput.value) - 4).toString();
		spacingInput.dispatchEvent(new Event('input'));
	});
	spacingInput.addEventListener('input', () => { spacingValue.textContent = `${spacingInput.value}px`; });
	incSpace.addEventListener('click', () => {
		spacingInput.value = Math.min(120, parseInt(spacingInput.value) + 4).toString();
		spacingInput.dispatchEvent(new Event('input'));
	});
	spacingInput.addEventListener('input', () => { spacingValue.textContent = `${spacingInput.value}px`; });

	// Background Color
	const bgSec = sheet.createDiv({ cls: 'hwm_sheet-section' });
	const bgHeader = bgSec.createDiv({ cls: 'hwm_sheet-header' });
	bgHeader.createSpan({ text: 'Background Color', cls: 'hwm_sheet-title' });
	const bgBox = bgSec.createDiv({ cls: 'hwm_sheet-control-box' });
	
		let currentBgColor = canvas.getBgColor();
	// Glass/Transparent special button
	const glassBgBtn = bgBox.createEl('button', { cls: 'hwm_color-swatch hwm_color-swatch--glass' });
	glassBgBtn.title = 'Transparent';
	
	const solidBgColors = ['#1e1e1e', '#ffffff', '#f4ecd8', '#f0f0f0'];
	const bgBtns: (HTMLInputElement | HTMLButtonElement)[] = [glassBgBtn];
	
	glassBgBtn.addEventListener('click', () => {
		bgBtns.forEach(b => b.classList.remove('hwm_active'));
		glassBgBtn.classList.add('hwm_active');
		currentBgColor = 'rgba(0,0,0,0)';
		applyAppearance();
	});
	
	solidBgColors.forEach(c => {
		const btn = bgBox.createEl('input', { cls: 'hwm_color-swatch', attr: { type: 'color' } });
		btn.value = c;
		btn.addEventListener('click', (e) => {
			if (!btn.classList.contains('hwm_active')) {
				e.preventDefault();
				bgBtns.forEach(b => b.classList.remove('hwm_active'));
				btn.classList.add('hwm_active');
				currentBgColor = btn.value;
				applyAppearance();
			} else {
				try { btn.showPicker(); } catch { /* Browser has no programmatic picker. */ }
			}
		});
		btn.addEventListener('touchend', (e) => {
			if (btn.classList.contains('hwm_active')) {
				try { btn.showPicker(); } catch { /* Browser has no programmatic picker. */ }
			}
		});
		btn.addEventListener('input', () => {
			currentBgColor = btn.value;
			applyAppearance();
		});
		bgBtns.push(btn);
	});
	
	// Mark current bg btn active
	const currentBg = canvas.getBgColor();
	if (currentBg === 'rgba(0,0,0,0)' || currentBg === 'transparent') {
		glassBgBtn.classList.add('hwm_active');
	} else {
		const matchingBtn = bgBtns.find(b => b instanceof HTMLInputElement && b.value.toLowerCase() === currentBg.toLowerCase());
		if (matchingBtn) matchingBtn.classList.add('hwm_active');
	}

	sheet.createDiv({ cls: 'hwm_sheet-divider', attr: { style: 'margin: 16px 0;' } });

	const bottomRow = sheet.createDiv({ cls: 'hwm_sheet-grid-3' });
	
	const closeSheetBtn = bottomRow.createEl('button', { cls: 'hwm_sheet-btn hwm_sheet-btn--secondary' });
	const closeIcon = closeSheetBtn.createSpan(); setIcon(closeIcon, 'chevron-down');
	closeSheetBtn.createSpan({ text: 'Close' });

	const clearBtn = bottomRow.createEl('button', { cls: 'hwm_sheet-btn hwm_sheet-btn--secondary' });
	const clearIcon = clearBtn.createSpan(); setIcon(clearIcon, 'eraser');
	clearBtn.createSpan({ text: 'Clear' });

	const deleteBtn = bottomRow.createEl('button', { cls: 'hwm_sheet-btn hwm_sheet-btn--danger' });
	const delIcon = deleteBtn.createSpan(); setIcon(delIcon, 'trash-2');
	deleteBtn.createSpan({ text: 'Delete' });

	const closeMoreSheet = () => overlay.classList.remove('hwm_visible');
	const openMoreSheet = () => overlay.classList.add('hwm_visible');

	closeSheetBtn.addEventListener('click', closeMoreSheet);
	clearBtn.addEventListener('click', () => canvas.clear());
	deleteBtn.addEventListener('click', () => { void opts.doDelete(); });
	
	moreBtn.addEventListener('click', openMoreSheet);
	overlay.addEventListener('click', (e) => { if(e.target === overlay) closeMoreSheet(); });
	// With the inline sheet anchored to the belt there is deliberately no
	// full-screen overlay. A tap elsewhere in this editor closes it instead.
	el.addEventListener('pointerdown', event => {
		if (!overlay.classList.contains('hwm_visible')) return;
		if (event.target instanceof Node && (sheet.contains(event.target) || moreBtn.contains(event.target))) return;
		closeMoreSheet();
	}, { capture: true });

	const bgModeListener = (bgMode: string) => {
		const dark = resolveIsDark(bgMode);
		el.setCssProps({ '--hwm-bg': getEffectiveBgColor(plugin.settings) });
		const newColors = getQuickPalette(plugin.settings, dark);
		colors = [...newColors];
		colorBtns.forEach((btn, i) => {
			btn.value = newColors[i] ?? '';
			btn.setAttribute('title', newColors[i] ?? '');
		});
		canvas.setColor(colors[activeColorIdx]!);
		canvas.setBackground(canvas.getBgColor(), canvas.getLineColor(), canvas.getBackgroundPattern(), canvas.getLineSpacing());
		canvas.remapStrokeColors(c => remapStrokeColor(c, bgMode as BgMode));
	};
	plugin.bgModeListeners.add(bgModeListener);

	canvas.onResize(() => {
		if (!canvas.isPointerDown()) scrollWrap.scrollTop = scrollWrap.scrollHeight;
	});

	const updateToolButtons = (mode: 'pen' | 'eraser' | 'highlighter' | 'text' | 'lasso') => {
		penBtn.classList.toggle('hwm_active', mode === 'pen');
		eraserBtn.classList.toggle('hwm_active', mode === 'eraser');
		highlighterBtn.classList.toggle('hwm_active', mode === 'highlighter');
		textBtn.classList.toggle('hwm_active', mode === 'text');
		lassoBtn.classList.toggle('hwm_active', mode === 'lasso');
	};
	penBtn.addEventListener('click', () => { canvas.selectMode('pen'); });
	eraserBtn.addEventListener('click', () => { canvas.selectMode('eraser'); });
	highlighterBtn.addEventListener('click', () => { canvas.selectMode('highlighter'); });
	textBtn.addEventListener('click', () => { canvas.selectMode('text'); });
	lassoBtn.addEventListener('click', () => { canvas.selectMode('lasso'); });
	imageBtn.addEventListener('click', () => {
		updateImageInsertionPoint();
		const picker = activeDocument.createElement('input');
		picker.type = 'file'; picker.accept = 'image/*';
		// Android/iOS WebViews may ignore click() on a detached file input.
		picker.classList.add('hwm_file-picker');
		activeDocument.body.appendChild(picker);
		picker.addEventListener('change', () => {
			const file = picker.files?.[0];
			if (file) void canvas.insertImage(file);
			picker.remove();
		}, { once: true });
		picker.click();
	});

	strokeSizeInput.addEventListener('input', () => {
		strokeSizeValue.setText(strokeSizeInput.value);
		canvas.setLineWidth(Number(strokeSizeInput.value));
	});
	canvas.onModeChange(updateToolButtons);

	const selectColor = (index: number) => {
		colorBtns.forEach(b => b.classList.remove('hwm_active'));
		colorBtns[index]?.classList.add('hwm_active');
		activeColorIdx = index;
		canvas.setColor(colors[index]!);
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
		if (colorBtns[index]) colorBtns[index].style.backgroundColor = color;
		colorBtns[index]?.setAttribute('title', color);
		selectColor(index);
		void plugin.saveSettings();
	};
		const bindColorButton = (inputBtn: HTMLInputElement) => {
		const btn = inputBtn;
		inputBtn.addEventListener('click', (e) => {
			const index = colorBtns.indexOf(btn);
			if (!btn.classList.contains('hwm_active')) {
				e.preventDefault();
				selectColor(index);
			} else {
				try { inputBtn.showPicker(); } catch { /* Browser has no programmatic picker. */ }
			}
		});
		// Mobile Safari / iOS touch event support for opening color picker
		inputBtn.addEventListener('touchend', (e) => {
			if (btn.classList.contains('hwm_active')) {
				try { inputBtn.showPicker(); } catch { /* Browser has no programmatic picker. */ }
			}
		});
		inputBtn.addEventListener('input', () => {
			const index = colorBtns.indexOf(btn);
			applyQuickColor(index, inputBtn.value);
		});
	};
	colorBtns.forEach(bindColorButton);

		spacingInput.addEventListener('input', () => {
		spacingValue.setText(spacingInput.value);
		applyAppearance();
	});
	
	Object.entries(patternBtns).forEach(([pat, btn]) => {
		btn.addEventListener('click', () => {
			Object.values(patternBtns).forEach(b => b.classList.remove('hwm_active'));
			btn.classList.add('hwm_active');
			currentPattern = pat as BackgroundPattern;
			applyAppearance();
		});
	});

	undoBtn.addEventListener('click', () => canvas.undo());
	redoBtn.addEventListener('click', () => canvas.redo());
		
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
			const svg = drawingCanvasToSvg(canvas);
			this.plugin.cacheSvgSnapshot(this.svgPath, svg);
			this.plugin.refreshPreview(this.embedId, svg);
			if (this.saveTimer) window.clearTimeout(this.saveTimer);
			this.saveTimer = window.setTimeout(() => { void this.saveSvg(); }, 2000);
		});
		canvas.onImageChange(() => { void this.saveSvg(); });
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
			const svg = drawingCanvasToSvg(canvas);
			this.plugin.cacheSvgSnapshot(this.svgPath, svg);
			this.plugin.refreshPreview(this.embedId, svg);
			if (this.saveTimer) window.clearTimeout(this.saveTimer);
			this.saveTimer = window.setTimeout(() => { void this.saveSvg(); }, 2000);
		});
		canvas.onImageChange(() => { void this.saveSvg(); });
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

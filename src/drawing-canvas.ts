/* =============================================
   DrawingCanvas — Motore di disegno su Canvas API
   Usa curve di Bézier quadratiche (midpoint) per
   tratti fluidi. Supporta penna e gomma parziale.
   Undo/redo basato su history di stati completi
   (funziona sia per disegno che per gomma).
   ============================================= */

export interface Point {
	x: number;
	y: number;
	pressure: number;
}

export interface Stroke {
	points: Point[];
	color: string;
	width: number;
	opacity?: number;
}

export interface TextElement {
	id: string;
	x: number;
	y: number;
	text: string;
	color: string;
	fontSize: number;
}

export type DrawMode = 'pen' | 'eraser' | 'highlighter' | 'text';
export type BackgroundPattern = 'ruled' | 'grid' | 'dots' | 'blank';

// Spaziatura righe orizzontali — costante condivisa con svg-utils.ts
export const LINE_SPACING = 32;

// Deep copy di un array di Stroke
function cloneStrokes(strokes: Stroke[]): Stroke[] {
	return strokes.map(s => ({
		points: s.points.map(p => ({ ...p })),
		color: s.color,
		width: s.width,
		opacity: s.opacity,
	}));
}

function cloneTextElements(texts: TextElement[]): TextElement[] {
	return texts.map(text => ({ ...text }));
}

interface CanvasState {
	strokes: Stroke[];
	texts: TextElement[];
}

export class DrawingCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private strokes: Stroke[] = [];
	private texts: TextElement[] = [];
	private currentStroke: Stroke | null = null;
	private mode: DrawMode = 'pen';
	private color = '#000000';
	private lineWidth = 2;
	private isDrawing = false;
	private changeCb: (() => void) | null = null;
	// Se true: siamo su mobile (Android/iOS)
	private mobileMode = false;

	// History per undo/redo: ogni entry è uno snapshot completo dei tratti.
	// Funziona sia per disegno che per gomma.
	private history: CanvasState[] = [];
	private historyIdx = -1;
	// Flag per sapere se la gomma ha modificato qualcosa durante un drag
	private eraserChanged = false;
	// Callback invocato quando l'altezza del canvas cambia (auto-expand)
	private resizeCb: (() => void) | null = null;

	// Altezza di default delle settings (usata per reset su clear)
	private defaultHeight: number;

	// Righe e sfondo — usa la costante esportata del modulo
	readonly LINE_SPACING = LINE_SPACING;
	private bgColor = '#ffffff';
	private lineColor = '#e0e0e0';
	private backgroundPattern: BackgroundPattern = 'ruled';
	private lineSpacing = LINE_SPACING;
	private modeChangeCb: ((mode: DrawMode) => void) | null = null;

	// Auto-expand
	private readonly EXPAND_MARGIN = 40;
	private readonly EXPAND_AMOUNT = 150;

	private animFrameId: number | null = null;

	private boundDown: (e: PointerEvent) => void;
	private boundMove: (e: PointerEvent) => void;
	private boundUp: (e: PointerEvent) => void;
	private boundContextMenu: (e: MouseEvent) => void;
	private textInput: HTMLTextAreaElement | null = null;
	private temporaryEraserPreviousMode: DrawMode | null = null;
	private temporaryEraserPointerId: number | null = null;
	private activePointerId: number | null = null;
	// Some Samsung WebViews send contextmenu before the pen PointerEvent and
	// omit the S Pen side-button state from that PointerEvent.
	private stylusContextHint: { at: number; x: number; y: number } | null = null;
	// Cleanup per i listener aggiuntivi di allowFingerScroll()
	private fingerScrollCleanup: (() => void) | null = null;
	// Callback debug: se impostato, mostra Notice all'utente per ogni evento IME/touch
	private debugFn: ((msg: string) => void) | null = null;

	// Device Pixel Ratio: scala il buffer interno per display ad alta densità (Retina, ecc.)
	private dpr: number;
	// Dimensione logica CSS del canvas (in pixel logici, non fisici)
	private logicalWidth: number;
	private logicalHeight: number;
	// Spazio coordinate dei tratti salvati: cresce quando il display si allarga, non scende mai.
	// Garantisce che i tratti rimangano nell'SVG anche dopo una rotazione portrait.
	private worldWidth: number;
	// Scala orizzontale di visualizzazione: logicalWidth / worldWidth.
	// < 1 quando il display è più stretto del mondo (es. portrait dopo landscape): il contenuto
	// si comprime per mostrare tutto senza tagliare nulla.
	private viewScale = 1.0;
	// Mantenuto per compatibilità ma sempre 0 (non usiamo centering, solo scaling)
	private viewOffsetX = 0;

	constructor(container: HTMLElement, width: number, height: number, defaultHeight: number, mobileMode = false, debugFn: ((msg: string) => void) | null = null) {
		this.dpr = window.devicePixelRatio || 1;
		this.worldWidth   = width;
		this.logicalWidth  = width;
		this.logicalHeight = height;
		this.defaultHeight = defaultHeight;
		this.mobileMode = mobileMode;
		this.debugFn = debugFn;

		this.canvas = activeDocument.createElement('canvas');
		// Dimensione CSS: pixel logici → il browser mostra il canvas a questa dimensione
		this.canvas.style.width  = width  + 'px';
		this.canvas.style.height = height + 'px';
		// Buffer interno: pixel fisici moltiplicati per il DPR → nessuna pixelazione
		this.canvas.width  = Math.round(width  * this.dpr);
		this.canvas.height = Math.round(height * this.dpr);
		this.canvas.classList.add('hwm_canvas');
		// touch-action gestito in styles.css (.hwm_canvas { touch-action: none !important })
		container.appendChild(this.canvas);

		this.ctx = this.canvas.getContext('2d')!;
		// Scala il context: da questo punto tutte le coordinate ctx sono in pixel logici
		this.ctx.scale(this.dpr, this.dpr);
		this.clearBackground();

		// Stato iniziale nella history (canvas vuoto)
		this.pushHistory();

		this.boundDown = this.onPointerDown.bind(this);
		this.boundMove = this.onPointerMove.bind(this);
		this.boundUp = this.onPointerUp.bind(this);
		this.boundContextMenu = this.onContextMenu.bind(this);

		this.canvas.addEventListener('pointerdown', this.boundDown);
		this.canvas.addEventListener('pointermove', this.boundMove);
		this.canvas.addEventListener('pointerup', this.boundUp);
		this.canvas.addEventListener('pointerleave', this.boundUp);
		// Some Samsung WebViews surface the S Pen side key only as a context-menu event.
		this.canvas.addEventListener('contextmenu', this.boundContextMenu, true);
	}

	/* --- API pubblica --- */

	onChange(cb: () => void) { this.changeCb = cb; }
	// Registra callback per quando l'altezza cambia (utile per auto-scroll nell'overlay)
	onResize(cb: () => void) { this.resizeCb = cb; }
	onModeChange(cb: (mode: DrawMode) => void) { this.modeChangeCb = cb; }

	// Adatta il canvas alla larghezza di display indicata (rotazione schermo, apertura modal).
	// - expandWorld=true (default, Desktop modal): worldWidth cresce → SVG più largo.
	// - expandWorld=false (Android ResizeObserver): worldWidth invariato → SVG sempre a canvasWidth.
	//   Su Android serve evitare che il viewBox dell'SVG cambii tra sessioni su schermi diversi
	//   (altrimenti l'aspect ratio del SVG cambia e la preview inline si accorcia mostrando sfondo
	//   nero sotto l'img).
	setDisplayWidth(displayWidth: number, expandWorld = true) {
		if (displayWidth === this.logicalWidth) return;
		if (expandWorld && displayWidth > this.worldWidth) {
			// Espansione: il mondo si allarga con il display
			this.worldWidth = displayWidth;
		}
		// Aggiorna larghezza logica e fattore di scala
		this.logicalWidth = displayWidth;
		this.viewScale    = this.logicalWidth / this.worldWidth;
		this.canvas.style.width = displayWidth + 'px';
		// Cambiare canvas.width resetta il context → ri-applicare la scala DPR
		this.canvas.width = Math.round(displayWidth * this.dpr);
		this.ctx.scale(this.dpr, this.dpr);
		this.redraw();
	}
	// Abilita scroll manuale con il dito sul canvas.
	// touch-action resta 'none' (la penna non trigga scroll del browser),
	// il dito scrolla il container via JS.
	allowFingerScroll(scrollContainer: HTMLElement) {
		let scrolling = false;
		let startY = 0;
		let startScroll = 0;

		// Listener con riferimento nominale → possono essere rimossi in destroy()
		const onDown = (e: PointerEvent) => {
			if ((e.pointerType || 'pen') !== 'touch') return;
			scrolling = true;
			startY = e.clientY;
			startScroll = scrollContainer.scrollTop;
			this.canvas.setPointerCapture(e.pointerId);
		};
		const onMove = (e: PointerEvent) => {
			if (!scrolling || (e.pointerType || 'pen') !== 'touch') return;
			e.preventDefault();
			scrollContainer.scrollTop = startScroll + (startY - e.clientY);
		};
		const onStop = (e: PointerEvent) => {
			if ((e.pointerType || 'pen') !== 'touch') return;
			scrolling = false;
		};

		this.canvas.addEventListener('pointerdown', onDown);
		this.canvas.addEventListener('pointermove', onMove);
		this.canvas.addEventListener('pointerup', onStop);
		this.canvas.addEventListener('pointerleave', onStop);

		// Registra la funzione di cleanup per destroy()
		this.fingerScrollCleanup = () => {
			this.canvas.removeEventListener('pointerdown', onDown);
			this.canvas.removeEventListener('pointermove', onMove);
			this.canvas.removeEventListener('pointerup', onStop);
			this.canvas.removeEventListener('pointerleave', onStop);
		};
	}

	setMode(mode: DrawMode) {
		this.mode = mode;
		this.modeChangeCb?.(mode);
	}
	getMode(): DrawMode { return this.mode; }
	// Restituisce true se un tratto è in corso (pointer down)
	isPointerDown(): boolean { return this.isDrawing; }

	setColor(color: string) { this.color = color; }
	setLineWidth(w: number) { this.lineWidth = w; }

	getStrokes(): Stroke[] { return [...this.strokes]; }
	getTextElements(): TextElement[] { return cloneTextElements(this.texts); }
	// Ritorna le dimensioni nel sistema di coordinate mondo (usato per l'SVG viewBox)
	getWidth(): number  { return this.worldWidth; }
	getHeight(): number { return this.logicalHeight; }

	setBackground(
		bgColor: string,
		lineColor: string,
		pattern: BackgroundPattern = 'ruled',
		spacing = LINE_SPACING,
	) {
		this.bgColor = bgColor;
		this.lineColor = lineColor;
		this.backgroundPattern = pattern;
		this.lineSpacing = Math.max(12, Math.min(120, spacing));
		this.redraw();
	}
	getBgColor(): string { return this.bgColor; }
	getLineColor(): string { return this.lineColor; }
	getBackgroundPattern(): BackgroundPattern { return this.backgroundPattern; }
	getLineSpacing(): number { return this.lineSpacing; }

	loadStrokes(strokes: Stroke[], texts: TextElement[] = []) {
		this.strokes = cloneStrokes(strokes);
		this.texts = cloneTextElements(texts);
		// Reset history con lo stato caricato
		this.history = [];
		this.historyIdx = -1;
		this.pushHistory();
		this.redraw();
	}

	// Remap colori di tutti i tratti (correnti + history) al cambio tema.
	// fn: funzione pura che restituisce il nuovo colore dato quello corrente.
	// Non modifica la history — undo/redo continuano a funzionare con i colori aggiornati.
	remapStrokeColors(fn: (color: string) => string) {
		// Remap tratti correnti
		for (const s of this.strokes) s.color = fn(s.color);
		for (const text of this.texts) text.color = fn(text.color);
		// Remap tutti gli snapshot in history (così undo/redo mantiene colori coerenti)
		for (const snapshot of this.history) {
			for (const s of snapshot.strokes) s.color = fn(s.color);
			for (const text of snapshot.texts) text.color = fn(text.color);
		}
		this.redraw();
	}

	// Torna allo stato precedente nella history
	undo(): boolean {
		if (this.historyIdx <= 0) return false;
		this.historyIdx--;
		const state = this.history[this.historyIdx]!;
		this.strokes = cloneStrokes(state.strokes);
		this.texts = cloneTextElements(state.texts);
		this.redraw();
		this.changeCb?.();
		return true;
	}

	// Avanza allo stato successivo nella history
	redo(): boolean {
		if (this.historyIdx >= this.history.length - 1) return false;
		this.historyIdx++;
		const state = this.history[this.historyIdx]!;
		this.strokes = cloneStrokes(state.strokes);
		this.texts = cloneTextElements(state.texts);
		this.redraw();
		this.changeCb?.();
		return true;
	}

	clear() {
		this.strokes = [];
		this.texts = [];
		this.pushHistory();
		// Ridisegna subito (canvas visualmente vuoto) anche se l'altezza
		// è già quella di default (animateHeight ritornerebbe senza fare nulla)
		this.redraw();
		this.animateHeight(this.defaultHeight);
		this.changeCb?.();
	}

	resizeHeight(newHeight: number) {
		if (newHeight < 100) return;
		this.logicalHeight = newHeight;
		this.canvas.style.height = newHeight + 'px';
		// canvas.height resetta il context → ri-applicare la scala DPR
		this.canvas.height = Math.round(newHeight * this.dpr);
		this.ctx.scale(this.dpr, this.dpr);
		this.redraw();
	}

	destroy() {
		if (this.animFrameId !== null) {
			window.cancelAnimationFrame(this.animFrameId);
		}
		this.textInput?.remove();
		this.textInput = null;
		this.canvas.removeEventListener('pointerdown', this.boundDown);
		this.canvas.removeEventListener('pointermove', this.boundMove);
		this.canvas.removeEventListener('pointerup', this.boundUp);
		this.canvas.removeEventListener('pointerleave', this.boundUp);
		this.canvas.removeEventListener('contextmenu', this.boundContextMenu, true);
		// Rimuove i listener aggiuntivi per lo scroll con il dito (se impostati)
		this.fingerScrollCleanup?.();
	}

	/* --- History --- */

	// Salva uno snapshot dei tratti correnti nella history.
	// Taglia eventuali stati futuri (redo) quando si aggiunge un nuovo stato.
	private pushHistory() {
		this.history = this.history.slice(0, this.historyIdx + 1);
		this.history.push({ strokes: cloneStrokes(this.strokes), texts: cloneTextElements(this.texts) });
		this.historyIdx = this.history.length - 1;
	}

	/* --- Pointer Events --- */

	private onPointerDown(e: PointerEvent) {
		// pointerType vuoto ("") = evento degradato da Android → trattato come penna
		const ptype = e.pointerType || 'pen';
		// Samsung S Pen and most styluses expose their side/eraser button as a
		// secondary (or eraser) pointer button. Switch to eraser immediately.
		const stylusEraser = this.isStylusEraserButton(e);
		if (stylusEraser) this.activateStylusEraser(e.pointerId);

		// Su mobile: il dito non disegna mai
		if (this.mobileMode && ptype === 'touch' && !stylusEraser) {
			this.debugFn?.('👆 Dito sul canvas');
			e.stopPropagation();
			return;
		}

		e.preventDefault();
		if (this.mobileMode) {
			this.debugFn?.(`🖊 pointerdown tipo="${e.pointerType}" → "${ptype}"`);
			e.stopPropagation();
		}
		this.canvas.setPointerCapture(e.pointerId);
		this.activePointerId = e.pointerId;
		this.isDrawing = true;
		const pt = this.eventToPoint(e);
		if (this.mode === 'text') {
			this.isDrawing = false;
			this.openTextInput(pt);
			return;
		}

		if (this.mode === 'pen' || this.mode === 'highlighter') {
			this.currentStroke = {
				points: [pt],
				color: this.color,
				width: this.mode === 'highlighter' ? Math.max(16, this.lineWidth * 8) : this.lineWidth,
				opacity: this.mode === 'highlighter' ? 0.32 : 1,
			};
		} else {
			// Inizio drag gomma: reset flag
			this.eraserChanged = false;
			this.eraseAt(pt);
		}
	}

	private onPointerMove(e: PointerEvent) {
		// Su mobile: ignora il dito
		const stylusEraser = this.isStylusEraserButton(e);
		if (this.mobileMode && (e.pointerType || 'pen') === 'touch' && !stylusEraser) return;
		// Samsung can report the side button while the S Pen is hovering, before
		// pointerdown. Switching here makes the very next tap an erase gesture.
		if (stylusEraser) this.activateStylusEraser(e.pointerId);
		else if (!this.isDrawing) this.restoreTemporaryEraser(e.pointerId);
		if (!this.isDrawing) return;
		e.preventDefault();
		const pt = this.eventToPoint(e);

		if ((this.mode === 'pen' || this.mode === 'highlighter') && this.currentStroke) {
			this.currentStroke.points.push(pt);
			if (this.mode === 'highlighter') {
				// Repaint one continuous translucent path: overlapping round caps from
				// incremental segments otherwise produce a dotted highlighter effect.
				this.redraw();
				this.drawFullStroke(this.currentStroke);
			} else this.drawSegment(this.currentStroke);
			this.checkAutoExpand(pt);
		} else if (this.mode === 'eraser') {
			this.eraseAt(pt);
		}
	}

	private onPointerUp(e: PointerEvent) {
		// Finger scrolling never sets isDrawing, so this also safely handles the
		// Android case where an S Pen side-button release is reported as touch.
		if (!this.isDrawing) {
			this.restoreTemporaryEraser(e.pointerId);
			return;
		}
		this.isDrawing = false;

		if ((this.mode === 'pen' || this.mode === 'highlighter') && this.currentStroke) {
			if (this.currentStroke.points.length >= 2) {
				this.strokes.push(this.currentStroke);
				// Salva nella history dopo ogni tratto completato
				this.pushHistory();
				this.changeCb?.();
			}
			this.currentStroke = null;
		} else if (this.mode === 'eraser' && this.eraserChanged) {
			// Salva nella history dopo un drag gomma che ha cancellato qualcosa
			this.pushHistory();
			this.changeCb?.();
		}
		this.activePointerId = null;
		this.restoreTemporaryEraser(e.pointerId);
	}

	private openTextInput(pt: Point) {
		this.textInput?.remove();
		const host = this.canvas.parentElement;
		if (!host) return;
		const input = activeDocument.createElement('textarea');
		input.className = 'hwm_canvas-text-input';
		input.placeholder = 'Type here…';
		input.setCssProps({
			'--hwm-text-left': `${this.canvas.offsetLeft + pt.x * this.viewScale}px`,
			'--hwm-text-top': `${this.canvas.offsetTop + pt.y}px`,
		});
		host.appendChild(input);
		this.textInput = input;
		let committed = false;
		const commit = () => {
			if (committed) return;
			committed = true;
			const text = input.value.trim();
			input.remove();
			if (this.textInput === input) this.textInput = null;
			if (!text) return;
			this.texts.push({
				id: `text_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
				x: pt.x, y: pt.y, text, color: this.color, fontSize: 18,
			});
			this.pushHistory();
			this.redraw();
			this.changeCb?.();
		};
		input.addEventListener('blur', commit, { once: true });
		input.addEventListener('keydown', event => {
			if (event.key === 'Escape') { committed = true; input.remove(); this.textInput = null; }
			if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); commit(); }
		});
		input.focus();
	}

	/* --- Auto-expand --- */

	private checkAutoExpand(pt: Point) {
		// Se un'animazione è già in corso non lanciarne un'altra:
		// ripartire da un'altezza intermedia causerebbe un effetto di restringimento.
		if (this.animFrameId !== null) return;
		// Confronto in pixel logici: pt.y è in coordinate mondo, logicalHeight è logica
		if (pt.y > this.logicalHeight - Math.max(this.EXPAND_MARGIN, this.lineSpacing)) {
			// Add several complete writing lines, so the pen never reaches a hard edge.
			const newLogicalH = this.logicalHeight + Math.max(this.EXPAND_AMOUNT, this.lineSpacing * 4);
			this.animateHeight(newLogicalH);
		}
	}

	private isStylusEraserButton(e: PointerEvent): boolean {
		const pointerType = e.pointerType || 'pen';
		// A few Samsung Android WebViews report the S Pen as "mouse" while its
		// side button is held, so accept that fallback in mobile mode as well.
		if (pointerType !== 'pen' && !(this.mobileMode && (pointerType === 'mouse' || pointerType === 'touch'))) return false;
		// Any pen button other than the primary tip is treated as an eraser button.
		// This covers the inconsistent mappings used by Samsung/Android WebViews.
		if (e.button > 0 || (e.buttons & ~1) !== 0) return true;
		const hint = this.stylusContextHint;
		return !!hint && Date.now() - hint.at < 900
			&& Math.hypot(e.clientX - hint.x, e.clientY - hint.y) < 96;
	}

	private onContextMenu(e: MouseEvent) {
		// Fallback for Samsung devices that emit a contextmenu rather than a
		// secondary PointerEvent for the side button. Do not open Android's menu.
		if (!this.mobileMode) return;
		e.preventDefault();
		e.stopPropagation();
		this.stylusContextHint = { at: Date.now(), x: e.clientX, y: e.clientY };
		if (this.activePointerId !== null) {
			this.activateStylusEraser(this.activePointerId);
			if (this.isDrawing) this.eraseAt(this.eventToPoint(e as unknown as PointerEvent));
			return;
		}
		// On several Samsung builds contextmenu arrives just before pointerdown.
		// Erase at the reported point immediately, then keep the temporary eraser
		// alive briefly so the following pen drag continues to erase.
		if (this.temporaryEraserPreviousMode === null) this.temporaryEraserPreviousMode = this.mode;
		this.setMode('eraser');
		this.eraserChanged = false;
		this.eraseAt(this.eventToPoint(e as unknown as PointerEvent));
		if (this.eraserChanged) {
			this.pushHistory();
			this.changeCb?.();
		}
		window.setTimeout(() => {
			if (this.temporaryEraserPointerId !== null) return;
			const previousMode = this.temporaryEraserPreviousMode;
			this.temporaryEraserPreviousMode = null;
			this.stylusContextHint = null;
			if (previousMode) this.setMode(previousMode);
		}, 700);
	}

	private activateStylusEraser(pointerId = this.activePointerId) {
		if (this.temporaryEraserPreviousMode === null) this.temporaryEraserPreviousMode = this.mode;
		if (pointerId !== null) this.temporaryEraserPointerId = pointerId;
		if (this.mode === 'eraser') return;
		// If the side button is pressed mid-stroke, finish the written portion
		// before erasing instead of silently discarding it.
		if (this.currentStroke && this.currentStroke.points.length >= 2) {
			this.strokes.push(this.currentStroke);
			this.pushHistory();
			this.changeCb?.();
		}
		this.currentStroke = null;
		this.setMode('eraser');
	}

	private restoreTemporaryEraser(pointerId: number) {
		if (this.temporaryEraserPointerId !== pointerId) return;
		const previousMode = this.temporaryEraserPreviousMode;
		this.temporaryEraserPointerId = null;
		this.temporaryEraserPreviousMode = null;
		this.stylusContextHint = null;
		if (previousMode) this.setMode(previousMode);
	}

	private animateHeight(targetLogicalH: number) {
		const startLogicalH = this.logicalHeight;
		if (startLogicalH === targetLogicalH) return;

		if (this.animFrameId !== null) {
			window.cancelAnimationFrame(this.animFrameId);
			this.animFrameId = null;
		}

		const duration = 300;
		const startTime = performance.now();

		const step = (now: number) => {
			const elapsed = now - startTime;
			const progress = Math.min(elapsed / duration, 1);
			const eased = 1 - Math.pow(1 - progress, 3);
			// Altezza in pixel logici per questa frame
			const h = Math.round(startLogicalH + (targetLogicalH - startLogicalH) * eased);

			this.logicalHeight = h;
			this.canvas.style.height = h + 'px';
			// canvas.height è in pixel fisici; cambiarlo resetta il context → ri-scalare
			this.canvas.height = Math.round(h * this.dpr);
			this.ctx.scale(this.dpr, this.dpr);
			this.redraw();
			if (this.currentStroke) {
				this.drawFullStroke(this.currentStroke);
			}
			// Notifica chi ascolta (overlay auto-scroll)
			this.resizeCb?.();

			if (progress < 1) {
				this.animFrameId = window.requestAnimationFrame(step);
			} else {
				this.animFrameId = null;
			}
		};

		this.animFrameId = window.requestAnimationFrame(step);
	}

	/* --- Coordinate --- */

	private eventToPoint(e: PointerEvent): Point {
		const rect = this.canvas.getBoundingClientRect();
		// Divide per viewScale per tornare alle coordinate mondo (invarianti al cambio orientamento)
		return {
			x: (e.clientX - rect.left) / this.viewScale,
			y: (e.clientY - rect.top),
			pressure: e.pressure > 0 ? e.pressure : 0.5,
		};
	}

	/* --- Gomma parziale --- */

	// La gomma rimuove solo i punti vicini, tagliando i tratti in segmenti.
	// Non salva nella history ad ogni singolo punto cancellato —
	// lo snapshot viene salvato una sola volta al pointerup.
	private eraseAt(pt: Point) {
		// A forgiving target makes the toolbar eraser reliable for both thin pen
		// strokes and broad highlights, even when Android drops move events.
		const radius = Math.max(22, this.lineWidth * 6);
		const r2 = radius * radius;
		let changed = false;
		const newStrokes: Stroke[] = [];

		for (const stroke of this.strokes) {
			let segment: Point[] = [];
			let strokeTouched = false;

			for (const p of stroke.points) {
				const dx = p.x - pt.x;
				const dy = p.y - pt.y;

				if (dx * dx + dy * dy < r2) {
					if (segment.length >= 2) {
						newStrokes.push({
							points: [...segment],
							color: stroke.color,
							width: stroke.width,
							opacity: stroke.opacity,
						});
					}
					segment = [];
					strokeTouched = true;
				} else {
					segment.push(p);
				}
			}

			if (!strokeTouched) {
				newStrokes.push(stroke);
			} else {
				changed = true;
				if (segment.length >= 2) {
					newStrokes.push({
						points: [...segment],
						color: stroke.color,
						width: stroke.width,
						opacity: stroke.opacity,
					});
				}
			}
		}

		if (changed) {
			this.strokes = newStrokes;
			this.eraserChanged = true;
			this.redraw();
		}
	}

	/* --- Rendering --- */

	private clearBackground() {
		// Usa pixel logici: ctx.scale(dpr, dpr) è già applicato nel constructor/resize
		const w = this.logicalWidth;
		const h = this.logicalHeight;

		this.ctx.fillStyle = this.bgColor;
		this.ctx.fillRect(0, 0, w, h);

		this.ctx.strokeStyle = this.lineColor;
		this.ctx.fillStyle = this.lineColor;
		this.ctx.lineWidth = 0.5;
		if (this.backgroundPattern === 'ruled' || this.backgroundPattern === 'grid') {
			for (let y = this.lineSpacing; y < h; y += this.lineSpacing) {
				this.ctx.beginPath(); this.ctx.moveTo(0, y); this.ctx.lineTo(w, y); this.ctx.stroke();
			}
		}
		if (this.backgroundPattern === 'grid') {
			for (let x = this.lineSpacing; x < w; x += this.lineSpacing) {
				this.ctx.beginPath(); this.ctx.moveTo(x, 0); this.ctx.lineTo(x, h); this.ctx.stroke();
			}
		}
		if (this.backgroundPattern === 'dots') {
			for (let y = this.lineSpacing; y < h; y += this.lineSpacing) {
				for (let x = this.lineSpacing; x < w; x += this.lineSpacing) {
					this.ctx.beginPath(); this.ctx.arc(x, y, 1, 0, Math.PI * 2); this.ctx.fill();
				}
			}
		}
	}

	private redraw() {
		this.clearBackground();
		for (const stroke of this.strokes) {
			this.drawFullStroke(stroke);
		}
		for (const text of this.texts) this.drawTextElement(text);
	}

	private drawTextElement(text: TextElement) {
		const ctx = this.ctx;
		ctx.save();
		ctx.scale(this.viewScale, 1.0);
		ctx.fillStyle = text.color;
		ctx.font = `${text.fontSize}px sans-serif`;
		ctx.textBaseline = 'top';
		text.text.split('\n').forEach((line, index) => ctx.fillText(line, text.x, text.y + index * (text.fontSize + 5)));
		ctx.restore();
	}

	private drawFullStroke(stroke: Stroke) {
		const pts = stroke.points;
		if (pts.length < 2) return;

		const ctx = this.ctx;
		// Scala orizzontale: comprime i tratti mondo nello spazio logico disponibile
		ctx.save();
		ctx.scale(this.viewScale, 1.0);
		ctx.strokeStyle = stroke.color;
		ctx.globalAlpha = stroke.opacity ?? 1;
		ctx.lineWidth = stroke.width;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.beginPath();
		ctx.moveTo(pts[0]!.x, pts[0]!.y);

		if (pts.length === 2) {
			ctx.lineTo(pts[1]!.x, pts[1]!.y);
		} else {
			for (let i = 1; i < pts.length - 1; i++) {
				const curr = pts[i]!;
				const next = pts[i + 1]!;
				const midX = (curr.x + next.x) / 2;
				const midY = (curr.y + next.y) / 2;
				ctx.quadraticCurveTo(curr.x, curr.y, midX, midY);
			}
			const last = pts[pts.length - 1]!;
			ctx.lineTo(last.x, last.y);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;
		ctx.restore();
	}

	private drawSegment(stroke: Stroke) {
		const pts = stroke.points;
		if (pts.length < 2) return;

		const ctx = this.ctx;
		// Stessa scala di drawFullStroke per coerenza durante il disegno live
		ctx.save();
		ctx.scale(this.viewScale, 1.0);
		ctx.strokeStyle = stroke.color;
		ctx.globalAlpha = stroke.opacity ?? 1;
		ctx.lineWidth = stroke.width;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.beginPath();

		if (pts.length === 2) {
			ctx.moveTo(pts[0]!.x, pts[0]!.y);
			ctx.lineTo(pts[1]!.x, pts[1]!.y);
		} else {
			const i = pts.length - 2;
			const prev = i > 0 ? pts[i - 1]! : pts[0]!;
			const curr = pts[i]!;
			const next = pts[i + 1]!;
			const startX = (prev.x + curr.x) / 2;
			const startY = (prev.y + curr.y) / 2;
			const endX = (curr.x + next.x) / 2;
			const endY = (curr.y + next.y) / 2;

			ctx.moveTo(startX, startY);
			ctx.quadraticCurveTo(curr.x, curr.y, endX, endY);
		}
		ctx.stroke();
		ctx.globalAlpha = 1;
		ctx.restore();
	}
}

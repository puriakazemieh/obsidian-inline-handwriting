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

export interface ImageElement {
	id: string;
	/** A data URL makes the drawing portable with its SVG, even when a vault file moves. */
	src: string;
	x: number;
	y: number;
	width: number;
	height: number;
	/** Normalized source rectangle; omitted means the whole image. */
	crop?: { left: number; top: number; right: number; bottom: number };
}

export type DrawMode = 'pen' | 'eraser' | 'highlighter' | 'text' | 'lasso';
export type BackgroundPattern = 'ruled' | 'grid' | 'dots' | 'blank';

// Spaziatura righe orizzontali — costante condivisa con svg-utils.ts
export const LINE_SPACING = 48;

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

function cloneImageElements(images: ImageElement[]): ImageElement[] {
	return images.map(image => ({ ...image, crop: image.crop ? { ...image.crop } : undefined }));
}

interface CanvasState {
	strokes: Stroke[];
	texts: TextElement[];
	images: ImageElement[];
}

export class DrawingCanvas {
	private canvas: HTMLCanvasElement;
	private ctx: CanvasRenderingContext2D;
	private strokes: Stroke[] = [];
	private texts: TextElement[] = [];
	private images: ImageElement[] = [];
	private imageBitmaps = new Map<string, HTMLImageElement>();
	private selectedImage: ImageElement | null = null;
	private imageInteraction: 'move' | 'resize-left' | 'resize-top' | 'resize-right' | 'resize-bottom' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw' | 'crop-left' | 'crop-top' | 'crop-right' | 'crop-bottom' | null = null;
	private cropMode = false;
	private cropBefore: ImageElement | null = null;
	private imageMenu: HTMLElement | null = null;
	private imageLongPressTimer: number | null = null;
	private imageLongPressPointerId: number | null = null;
	private imageInsertionY = 40;
	private imageClipboard: ImageElement | null = null;
	private currentStroke: Stroke | null = null;
	private mode: DrawMode = 'pen';
	private color = '#000000';
	private lineWidth = 2;
	private isDrawing = false;
	private lassoPath: Point[] = [];
	private selectedStrokes: Set<Stroke> = new Set();
	private isDraggingSelection = false;
	private dragStartPoint: Point | null = null;
	private changeCb: (() => void) | null = null;
	private imageChangeCb: (() => void) | null = null;
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
	private readonly EXPAND_AMOUNT = 1123;

	private animFrameId: number | null = null;

	private boundDown: (e: PointerEvent) => void;
	private boundMove: (e: PointerEvent) => void;
	private boundRawUpdate: (e: PointerEvent) => void;
	private boundUp: (e: PointerEvent) => void;
	private boundContextMenu: (e: MouseEvent) => void;
	private boundGlobalStylusState: (e: PointerEvent) => void;
	private boundGlobalMouseUp: (e: MouseEvent) => void;
	private boundKeyDown: (e: KeyboardEvent) => void;
	private boundPaste: (e: ClipboardEvent) => void;
	private textInput: HTMLTextAreaElement | null = null;
	private temporaryEraserPreviousMode: DrawMode | null = null;
	private temporaryEraserPointerId: number | null = null;
	// True only for Samsung WebViews that expose the side button solely through
	// contextmenu. In that fallback there is no reliable button-release signal,
	// so the temporary eraser ends with the current pen gesture.
	private temporaryEraserUsesContextHint = false;
	private contextEraserArmTimer: number | null = null;
	// Samsung WebView may expose the barrel bit only on its transition event and
	// omit it from subsequent contact moves. Latch it until an explicit release.
	private stylusButtonHeld = false;
	private stylusButtonPointerId: number | null = null;
	private processedStylusStateEvents = new WeakSet<PointerEvent>();
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
		this.boundRawUpdate = this.onPointerRawUpdate.bind(this);
		this.boundUp = this.onPointerUp.bind(this);
		this.boundContextMenu = this.onContextMenu.bind(this);
		this.boundGlobalStylusState = this.onGlobalStylusState.bind(this);
		this.boundGlobalMouseUp = this.onGlobalMouseUp.bind(this);
		this.boundKeyDown = this.onKeyDown.bind(this);
		this.boundPaste = this.onPaste.bind(this);

		this.canvas.addEventListener('pointerdown', this.boundDown);
		this.canvas.addEventListener('pointermove', this.boundMove);
		this.canvas.addEventListener('pointerrawupdate', this.boundRawUpdate);
		this.canvas.addEventListener('pointerup', this.boundUp);
		this.canvas.addEventListener('pointercancel', this.boundUp);
		this.canvas.addEventListener('lostpointercapture', this.boundUp);
		this.canvas.addEventListener('pointerleave', this.boundUp);
		// Some Samsung WebViews surface the S Pen side key only as a context-menu event.
		this.canvas.addEventListener('contextmenu', this.boundContextMenu, true);
		// Release may be targeted outside the canvas if Android drops pointer
		// capture. Capture-phase document listeners keep the tool state consistent.
		activeDocument.addEventListener('pointermove', this.boundGlobalStylusState, true);
		activeDocument.addEventListener('pointerup', this.boundGlobalStylusState, true);
		activeDocument.addEventListener('pointercancel', this.boundGlobalStylusState, true);
		activeDocument.addEventListener('mouseup', this.boundGlobalMouseUp, true);
		activeDocument.addEventListener('keydown', this.boundKeyDown, true);
		activeDocument.addEventListener('paste', this.boundPaste, true);
	}

	/* --- API pubblica --- */

	onChange(cb: () => void) { this.changeCb = cb; }
	onImageChange(cb: () => void) { this.imageChangeCb = cb; }
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
	allowFingerScroll(scrollContainer: HTMLElement) {
		let scrolling = false;
		let scrollPointerId: number | null = null;
		let startY = 0;
		let startScroll = 0;
		let lastY = 0;
		let velocity = 0;
		let rafId: number | null = null;
		let lastTime = 0;

		const applyInertia = () => {
			if (scrolling) return;
			if (Math.abs(velocity) > 0.5) {
				scrollContainer.scrollTop -= velocity;
				velocity *= 0.92;
				rafId = window.requestAnimationFrame(applyInertia);
			}
		};

		// Listener con riferimento nominale → possono essere rimossi in destroy()
		const onDown = (e: PointerEvent) => {
			// A few Samsung WebViews report an S Pen barrel-button gesture as
			// pointerType="touch". Never let that gesture enter finger scrolling.
			const contextEraserArmed = this.temporaryEraserUsesContextHint
				&& this.temporaryEraserPreviousMode !== null;
			if ((e.pointerType || 'pen') !== 'touch'
				|| this.isStylusEraserButton(e)
				|| contextEraserArmed) return;
			scrolling = true;
			scrollPointerId = e.pointerId;
			startY = e.clientY;
			lastY = e.clientY;
			startScroll = scrollContainer.scrollTop;
			velocity = 0;
			lastTime = performance.now();
			if (rafId) cancelAnimationFrame(rafId);
			this.canvas.setPointerCapture(e.pointerId);
		};
		const onMove = (e: PointerEvent) => {
			if (!scrolling || e.pointerId !== scrollPointerId || (e.pointerType || 'pen') !== 'touch') return;
			e.preventDefault();
			const now = performance.now();
			const dt = now - lastTime;
			if (dt > 0) {
				velocity = (e.clientY - lastY) / dt * 16;
			}
			lastY = e.clientY;
			lastTime = now;
			scrollContainer.scrollTop = startScroll + (startY - e.clientY);
		};
		const onStop = (e: PointerEvent) => {
			if (e.pointerId !== scrollPointerId) return;
			scrolling = false;
			scrollPointerId = null;
			rafId = window.requestAnimationFrame(applyInertia);
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
			if (rafId) cancelAnimationFrame(rafId);
		};
	}

	setMode(mode: DrawMode) {
		if (mode !== 'lasso') {
			this.selectedStrokes.clear();
			this.selectedImage = null;
			this.cropMode = false;
			this.lassoPath = [];
			this.redraw();
		}
		this.mode = mode;
		this.canvas.classList.toggle('hwm_canvas--eraser', mode === 'eraser');
		this.modeChangeCb?.(mode);
	}

	// A toolbar choice is authoritative. Clear a stale temporary S Pen state so
	// Android cannot immediately force the canvas back into eraser mode.
	selectMode(mode: DrawMode) {
		if (this.temporaryEraserPreviousMode !== null && this.mode === 'eraser') {
			this.commitEraserChange();
			this.isDrawing = false;
			this.activePointerId = null;
		}
		this.clearTemporaryEraserState();
		this.setMode(mode);
	}
	getMode(): DrawMode { return this.mode; }
	// Restituisce true se un tratto è in corso (pointer down)
	isPointerDown(): boolean { return this.isDrawing; }

	setColor(color: string) { this.color = color; }
	setLineWidth(w: number) { this.lineWidth = w; }

	getStrokes(): Stroke[] { return [...this.strokes]; }
	getTextElements(): TextElement[] { return cloneTextElements(this.texts); }
	getImageElements(): ImageElement[] { return cloneImageElements(this.images); }
	setImageInsertionY(y: number): void { this.imageInsertionY = Math.max(0, y); }

	/** Starts a non-destructive crop; it is stored only after applyCropSelectedImage(). */
	beginCropSelectedImage(): boolean {
		if (!this.selectedImage) return false;
		this.selectMode('lasso');
		this.cropBefore = cloneImageElements([this.selectedImage])[0] ?? null;
		this.cropMode = true;
		this.redraw();
		return true;
	}

	/** Toolbar-friendly crop control: first tap starts, second tap applies. */
	toggleCropSelectedImage(): boolean {
		if (this.cropMode) { this.applyCropSelectedImage(); return true; }
		return this.beginCropSelectedImage();
	}

	applyCropSelectedImage(): void {
		if (!this.cropMode) return;
		if (this.selectedImage && this.cropBefore) {
			const crop = this.imageCrop(this.selectedImage);
			this.selectedImage.x = this.cropBefore.x + this.cropBefore.width * crop.left;
			this.selectedImage.y = this.cropBefore.y + this.cropBefore.height * crop.top;
			this.selectedImage.width = this.cropBefore.width * (crop.right - crop.left);
			this.selectedImage.height = this.cropBefore.height * (crop.bottom - crop.top);
		}
		this.cropMode = false; this.cropBefore = null;
		this.pushHistory(); this.redraw(); this.changeCb?.(); this.imageChangeCb?.();
	}

	cancelCropSelectedImage(): void {
		if (!this.cropMode) return;
		if (this.selectedImage && this.cropBefore) Object.assign(this.selectedImage, this.cropBefore);
		this.cropMode = false; this.cropBefore = null; this.redraw();
	}

	async insertImage(file: File): Promise<void> {
		if (!file.type.startsWith('image/')) return;
		const src = await new Promise<string>((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				if (typeof reader.result === 'string') resolve(reader.result);
				else reject(new Error('Unable to read image'));
			};
			reader.onerror = () => reject(reader.error ?? new Error('Unable to read image'));
			reader.readAsDataURL(file);
		});
		const bitmap = await this.loadImage(src);
		const maxWidth = Math.max(120, this.worldWidth * 0.7);
		const scale = Math.min(maxWidth / bitmap.naturalWidth, Math.max(120, this.logicalHeight * 0.45) / bitmap.naturalHeight, 1);
		const width = Math.max(80, Math.round(bitmap.naturalWidth * scale));
		const height = Math.max(80, Math.round(bitmap.naturalHeight * scale));
		const y = Math.max(0, this.imageInsertionY);
		if (y + height + 40 > this.logicalHeight) this.resizeHeight(y + height + 40);
		const image: ImageElement = { id: `image_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, src, x: Math.max(0, (this.worldWidth - width) / 2), y, width, height };
		this.images.push(image);
		this.selectedImage = image;
		this.selectMode('lasso');
		this.pushHistory();
		this.redraw();
		this.changeCb?.();
		this.imageChangeCb?.();
	}
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

	loadStrokes(strokes: Stroke[], texts: TextElement[] = [], images: ImageElement[] = []) {
		this.strokes = cloneStrokes(strokes);
		this.texts = cloneTextElements(texts);
		this.images = cloneImageElements(images);
		this.selectedImage = null;
		this.preloadImages();
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
		this.images = cloneImageElements(state.images);
		this.selectedImage = null;
		this.preloadImages();
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
		this.images = cloneImageElements(state.images);
		this.selectedImage = null;
		this.preloadImages();
		this.redraw();
		this.changeCb?.();
		return true;
	}

	clear() {
		this.strokes = [];
		this.texts = [];
		this.images = [];
		this.selectedImage = null;
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
		this.closeImageMenu();
		this.clearImageLongPress();
		if (this.contextEraserArmTimer !== null) window.clearTimeout(this.contextEraserArmTimer);
		this.textInput = null;
		this.canvas.removeEventListener('pointerdown', this.boundDown);
		this.canvas.removeEventListener('pointermove', this.boundMove);
		this.canvas.removeEventListener('pointerrawupdate', this.boundRawUpdate);
		this.canvas.removeEventListener('pointerup', this.boundUp);
		this.canvas.removeEventListener('pointercancel', this.boundUp);
		this.canvas.removeEventListener('lostpointercapture', this.boundUp);
		this.canvas.removeEventListener('pointerleave', this.boundUp);
		this.canvas.removeEventListener('contextmenu', this.boundContextMenu, true);
		activeDocument.removeEventListener('pointermove', this.boundGlobalStylusState, true);
		activeDocument.removeEventListener('pointerup', this.boundGlobalStylusState, true);
		activeDocument.removeEventListener('pointercancel', this.boundGlobalStylusState, true);
		activeDocument.removeEventListener('mouseup', this.boundGlobalMouseUp, true);
		activeDocument.removeEventListener('keydown', this.boundKeyDown, true);
		activeDocument.removeEventListener('paste', this.boundPaste, true);
		// Rimuove i listener aggiuntivi per lo scroll con il dito (se impostati)
		this.fingerScrollCleanup?.();
	}

	/* --- History --- */

	// Salva uno snapshot dei tratti correnti nella history.
	// Taglia eventuali stati futuri (redo) quando si aggiunge un nuovo stato.
	private pushHistory() {
		this.history = this.history.slice(0, this.historyIdx + 1);
		this.history.push({ strokes: cloneStrokes(this.strokes), texts: cloneTextElements(this.texts), images: cloneImageElements(this.images) });
		this.historyIdx = this.history.length - 1;
	}

	private pointInPolygon(pt: Point, polygon: Point[]): boolean {
		const x = pt.x, y = pt.y;
		let inside = false;
		for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
			const pi = polygon[i];
			const pj = polygon[j];
			if (!pi || !pj) continue;
			const xi = pi.x, yi = pi.y;
			const xj = pj.x, yj = pj.y;
			const intersect = ((yi > y) != (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
			if (intersect) inside = !inside;
		}
		return inside;
	}

	private isPointInSelection(pt: Point): boolean {
		for (const stroke of this.selectedStrokes) {
			let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
			for (const p of stroke.points) {
				if (p.x < minX) minX = p.x;
				if (p.x > maxX) maxX = p.x;
				if (p.y < minY) minY = p.y;
				if (p.y > maxY) maxY = p.y;
			}
			const margin = stroke.width + 10;
			if (pt.x >= minX - margin && pt.x <= maxX + margin && pt.y >= minY - margin && pt.y <= maxY + margin) {
				return true;
			}
		}
		return false;
	}

	/* --- Pointer Events --- */

	private onPointerDown(e: PointerEvent) {
		if (!this.cropMode) this.closeImageMenu();
		this.updateStylusButtonLatch(e);
		// pointerType vuoto ("") = evento degradato da Android → trattato come penna
		const ptype = e.pointerType || 'pen';
		const touchedImage = this.mobileMode && ptype === 'touch' ? this.imageAt(this.eventToPoint(e)) : null;
		if (touchedImage) {
			e.preventDefault();
			this.imageLongPressPointerId = e.pointerId;
			this.imageLongPressTimer = window.setTimeout(() => {
				this.imageLongPressTimer = null;
				this.selectedImage = touchedImage; this.selectedStrokes.clear(); this.selectMode('lasso');
				this.showImageMenu({ clientX: e.clientX, clientY: e.clientY } as MouseEvent);
			}, 650);
			return;
		}
		// Samsung S Pen and most styluses expose their side/eraser button as a
		// secondary (or eraser) pointer button. Switch to eraser immediately.
		const hasExplicitEraserButton = this.hasExplicitStylusEraserButton(e);
		const stylusEraser = this.isStylusEraserButton(e);
		const armedContextEraser = this.temporaryEraserUsesContextHint
			&& this.temporaryEraserPreviousMode !== null
			&& this.temporaryEraserPointerId === null;
		const useTemporaryEraser = stylusEraser || armedContextEraser;
		if (useTemporaryEraser) {
			// Pressing a pen barrel button while hovering is itself a pointerdown.
			// It arms erasing but is not yet a drawing gesture. Contact may arrive
			// later only as pointermove because the pointer is already active.
			e.preventDefault();
			if (this.mobileMode) e.stopPropagation();
			this.beginTemporaryEraserContact(e, !hasExplicitEraserButton);
			return;
		}

		// Su mobile: il dito non disegna mai
		if (this.mobileMode && ptype === 'touch' && !useTemporaryEraser) {
			this.debugFn?.('👆 Dito sul canvas');
			e.stopPropagation();
			return;
		}

		e.preventDefault();
		if (this.mobileMode) {
			this.debugFn?.(`🖊 pointerdown tipo="${e.pointerType}" → "${ptype}"`);
			e.stopPropagation();
		}
		this.capturePointer(e.pointerId);
		this.activePointerId = e.pointerId;
		this.isDrawing = true;
		const pt = this.eventToPoint(e);
		if (this.mode === 'text') {
			this.isDrawing = false;
			this.openTextInput(pt);
			return;
		} else if (this.mode === 'lasso') {
			if (this.cropMode && this.selectedImage) {
				const handle = this.cropHandleAt(this.selectedImage, pt);
				if (handle) {
					this.imageInteraction = handle;
					this.dragStartPoint = pt;
					this.isDraggingSelection = true;
					return;
				}
			}
			const image = this.imageAt(pt);
			if (image) {
				this.selectedImage = image;
				this.selectedStrokes.clear();
				this.imageInteraction = this.imageResizeHandleAt(image, pt) ?? 'move';
				this.dragStartPoint = pt;
				this.isDraggingSelection = true;
				this.redraw();
				return;
			}
			if (this.isPointInSelection(pt)) {
				this.isDraggingSelection = true;
				this.dragStartPoint = pt;
			} else {
				this.selectedStrokes.clear();
				this.selectedImage = null;
				this.lassoPath = [pt];
				this.isDraggingSelection = false;
				this.redraw();
			}
			return;
		}

		if (this.mode === 'pen' || this.mode === 'highlighter') {
			this.startStroke(pt);
		} else {
			// Inizio drag gomma: reset flag
			this.eraserChanged = false;
			this.eraseAt(pt);
		}
	}

	private onPointerMove(e: PointerEvent) {
		if (this.imageLongPressPointerId === e.pointerId) this.clearImageLongPress();
		// Ignore a second finger while a pen gesture owns the canvas. Otherwise a
		// touch event can prematurely end the temporary S Pen eraser state.
		if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
		this.updateStylusButtonLatch(e);
		// Su mobile: ignora il dito
		const stylusEraser = this.isStylusEraserButton(e, false);
		const contextEraser = this.temporaryEraserUsesContextHint
			&& this.temporaryEraserPreviousMode !== null
			&& (this.temporaryEraserPointerId === null || this.temporaryEraserPointerId === e.pointerId);
		const temporaryEraserRequested = stylusEraser || contextEraser;
		const ptype = e.pointerType || 'pen';
		if (this.mobileMode && ptype === 'touch' && !temporaryEraserRequested) {
			// Bypass finger rejection if this is the active drawing pointer
			if (!(this.isDrawing && e.pointerId === this.activePointerId)) {
				return;
			}
		}

		const pt = this.eventToPoint(e);
		const inContact = this.isPointerInContact(e);
		let resumedStroke = false;
		if (temporaryEraserRequested) {
			this.beginTemporaryEraserContact(e, contextEraser && !stylusEraser);
		} else if (!this.temporaryEraserUsesContextHint
			&& this.temporaryEraserPreviousMode !== null) {
			// A standard PointerEvent exposes the side button through `buttons`.
			// As soon as that bit is released, immediately return to the selected
			// tool—even while the pen is still touching the canvas.
			if (!inContact && this.temporaryEraserPreviousMode !== null
				&& this.isDrawing && this.mode === 'eraser') {
				this.isDrawing = false;
				this.activePointerId = null;
				this.commitEraserChange();
			}
			resumedStroke = this.restoreTemporaryEraser(e.pointerId, inContact ? pt : undefined);
			if (!inContact) return;
		}
		// Once an erase gesture starts, keep it alive until a release/up event.
		// Samsung WebView may report pressure=0 and omit the primary contact bit
		// throughout a valid barrel-button drag.

		if (!this.isDrawing) return;
		
		e.preventDefault();

		if (this.mode === 'lasso') {
			if (this.isDraggingSelection && this.dragStartPoint) {
				const dx = pt.x - this.dragStartPoint.x;
				const dy = pt.y - this.dragStartPoint.y;
				if (this.selectedImage) {
					if (this.imageInteraction?.startsWith('crop-')) {
						this.adjustImageCrop(this.selectedImage, this.imageInteraction as 'crop-left' | 'crop-top' | 'crop-right' | 'crop-bottom', dx, dy);
					} else if (this.imageInteraction?.startsWith('resize-')) {
						this.resizeImage(this.selectedImage, this.imageInteraction as 'resize-left' | 'resize-top' | 'resize-right' | 'resize-bottom' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw', dx, dy);
					} else { this.selectedImage.x += dx; this.selectedImage.y += dy; }
				} else for (const stroke of this.selectedStrokes) {
					for (const p of stroke.points) { p.x += dx; p.y += dy; }
				}
				this.dragStartPoint = pt;
				this.redraw();
			} else {
				this.lassoPath.push(pt);
				this.redraw();
			}
			return;
		}

		if ((this.mode === 'pen' || this.mode === 'highlighter') && this.currentStroke) {
			if (resumedStroke) return;
			this.currentStroke.points.push(pt);
			if (this.mode === 'highlighter') {
				// Repaint one continuous translucent path: overlapping round caps from
				// incremental segments otherwise produce a dotted highlighter effect.
				this.redraw();
				this.drawFullStroke(this.currentStroke);
			} else this.drawSegment(this.currentStroke);
			this.checkAutoExpand(pt);
		} else if (this.mode === 'eraser') {
			this.eraseFromPointerEvent(e);
		}
	}

	private onPointerUp(e: PointerEvent) {
		if (this.imageLongPressPointerId === e.pointerId) this.clearImageLongPress();
		if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
		this.updateStylusButtonLatch(e);
		// Do not let a compatibility latch survive the end of the gesture unless
		// the event still reports the physical side-button state explicitly.
		const sideButtonStillDown = (e.buttons & (2 | 32 | 64)) !== 0;
		const keepPhysicalEraser = sideButtonStillDown
			&& this.stylusButtonHeld
			&& !this.temporaryEraserUsesContextHint;
		// Finger scrolling never sets isDrawing, so this also safely handles the
		// Android case where an S Pen side-button release is reported as touch.
		if (!this.isDrawing) {
			this.activePointerId = null;
			if (!keepPhysicalEraser) this.restoreTemporaryEraser(e.pointerId);
			return;
		}
		this.isDrawing = false;

		if (this.mode === 'lasso') {
			if (this.isDraggingSelection) {
				this.isDraggingSelection = false;
				this.imageInteraction = null;
				if (!this.cropMode) { this.pushHistory(); this.changeCb?.(); if (this.selectedImage) this.imageChangeCb?.(); }
			} else if (this.lassoPath.length > 2) {
				for (const stroke of this.strokes) {
					for (const pt of stroke.points) {
						if (this.pointInPolygon(pt, this.lassoPath)) {
							this.selectedStrokes.add(stroke);
							break;
						}
					}
				}
				this.lassoPath = [];
				this.redraw();
			} else {
				this.lassoPath = [];
				this.selectedStrokes.clear();
				this.redraw();
			}
			this.activePointerId = null;
			this.restoreTemporaryEraser(e.pointerId);
			return;
		}

		if ((this.mode === 'pen' || this.mode === 'highlighter') && this.currentStroke) {
			if (this.currentStroke.points.length >= 2) {
				this.strokes.push(this.currentStroke);
				// Salva nella history dopo ogni tratto completato
				this.pushHistory();
				this.changeCb?.();
			}
			this.currentStroke = null;
		} else if (this.mode === 'eraser') {
			this.commitEraserChange();
		}
		this.activePointerId = null;
		if (!keepPhysicalEraser) this.restoreTemporaryEraser(e.pointerId);
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

	private isStylusEraserButton(e: PointerEvent, allowContextHint = true): boolean {
		const pointerType = e.pointerType || 'pen';
		// A few Samsung Android WebViews report the S Pen as "mouse" while its
		// side button is held, so accept that fallback in mobile mode as well.
		if (pointerType !== 'pen' && !(this.mobileMode && (pointerType === 'mouse' || pointerType === 'touch'))) return false;
		// Any pen button other than the primary tip is treated as an eraser button.
		// This covers the inconsistent mappings used by Samsung/Android WebViews.
		if (this.hasExplicitStylusEraserButton(e)) return true;
		if (this.stylusButtonHeld
			&& (this.stylusButtonPointerId === null || this.stylusButtonPointerId === e.pointerId)) return true;
		return allowContextHint && this.matchesStylusContextHint(e);
	}

	// Chrome exposes stylus button transitions through pointerrawupdate on some
	// Android devices even when a regular pointermove keeps `buttons === 1`.
	// Use it only for mode transitions; actual ink/erasure still runs once in
	// onPointerMove so raw and regular events can never duplicate a stroke.
	private onPointerRawUpdate(e: PointerEvent) {
		if (this.activePointerId !== null && e.pointerId !== this.activePointerId) return;
		this.updateStylusButtonLatch(e);
		const stylusEraser = this.isStylusEraserButton(e, false);
		const contextEraser = this.temporaryEraserUsesContextHint
			&& this.temporaryEraserPreviousMode !== null
			&& (this.temporaryEraserPointerId === null || this.temporaryEraserPointerId === e.pointerId);
		if (stylusEraser || contextEraser) {
			this.beginTemporaryEraserContact(e, contextEraser && !stylusEraser);
			return;
		}
		if (!this.temporaryEraserUsesContextHint) {
			const inContact = this.isPointerInContact(e);
			if (!inContact && this.temporaryEraserPreviousMode !== null
				&& this.isDrawing && this.mode === 'eraser') {
				this.isDrawing = false;
				this.activePointerId = null;
				this.commitEraserChange();
			}
			this.restoreTemporaryEraser(
				e.pointerId,
				this.isDrawing && inContact ? this.eventToPoint(e) : undefined,
			);
		}
	}

	private hasExplicitStylusEraserButton(e: PointerEvent): boolean {
		// Pointer Events reserve button 2 / mask 2 for the barrel button and
		// button 5 / mask 32 for an eraser end. Android maps BTN_STYLUS to
		// BUTTON_SECONDARY, so accepting these specific states avoids treating
		// unrelated mouse navigation buttons as a stylus eraser.
		// `button` describes the button whose state *changed*, so button=2 is also
		// present on release. `buttons` is the authoritative current-state mask.
		// Only pointerdown needs the transition value as a compatibility fallback.
		return (e.buttons & (2 | 32 | 64)) !== 0
			|| (e.type === 'pointerdown' && (e.button === 2 || e.button === 5));
	}

	private updateStylusButtonLatch(e: PointerEvent): boolean {
		// The document capture listener and the canvas listener receive the same
		// event object. Process its state transition exactly once.
		if (this.processedStylusStateEvents.has(e)) return false;
		this.processedStylusStateEvents.add(e);
		const pointerType = e.pointerType || 'pen';
		if (pointerType !== 'pen'
			&& !(this.mobileMode && (pointerType === 'mouse' || pointerType === 'touch'))) return false;
		const sideMaskDown = (e.buttons & (2 | 32 | 64)) !== 0;
		const sideTransition = e.button === 2 || e.button === 5;
		if (sideMaskDown) {
			this.stylusButtonHeld = true;
			this.stylusButtonPointerId = e.pointerId;
			return false;
		}
		if (e.type === 'pointerdown' && sideTransition) {
			this.stylusButtonHeld = true;
			this.stylusButtonPointerId = e.pointerId;
			return false;
		}
		// When a WebView omits the barrel bit, button=2 on pointermove still arms
		// the eraser. Never use the same repeated value as a release signal.
		if (sideTransition && e.type === 'pointermove' && !this.stylusButtonHeld) {
			this.stylusButtonHeld = true;
			this.stylusButtonPointerId = e.pointerId;
			return false;
		}
		// `button=2` may be repeated on every Samsung pointermove while the
		// current-state mask is missing, so only an actual up/cancel ends the latch.
		const explicitRelease = sideTransition && e.type === 'pointerup';
		if (explicitRelease || e.type === 'pointercancel') {
			const wasHeld = this.stylusButtonHeld;
			this.stylusButtonHeld = false;
			this.stylusButtonPointerId = null;
			return wasHeld;
		}
		return false;
	}

	private onGlobalStylusState(e: PointerEvent): void {
		if (this.temporaryEraserPreviousMode === null) return;
		const belongsToThisCanvas = e.target === this.canvas
			|| this.temporaryEraserPointerId === e.pointerId
			|| this.stylusButtonPointerId === e.pointerId;
		if (!belongsToThisCanvas) return;
		const released = this.updateStylusButtonLatch(e);
		if (!released) return;
		// Run after the canvas handler. If release happened over the canvas it can
		// resume the pen at the exact contact point; otherwise simply restore it.
		queueMicrotask(() => {
			if (this.stylusButtonHeld) return;
			const pointerId = this.temporaryEraserPointerId;
			if (pointerId !== null) this.restoreTemporaryEraser(pointerId);
		});
	}

	private onGlobalMouseUp(e: MouseEvent): void {
		if (e.button !== 2 || this.temporaryEraserPreviousMode === null) return;
		this.stylusButtonHeld = false;
		this.stylusButtonPointerId = null;
		queueMicrotask(() => {
			const pointerId = this.temporaryEraserPointerId;
			if (pointerId !== null) this.restoreTemporaryEraser(pointerId);
		});
	}

	private isPointerInContact(e: PointerEvent): boolean {
		const pointerType = e.pointerType || 'pen';
		if (pointerType === 'touch') return e.type !== 'pointerup' && e.type !== 'pointercancel';
		// Pressure distinguishes S Pen contact from a side-button pointerdown while
		// hovering. The primary-contact bit covers devices without pressure data.
		return e.pressure > 0 || (e.buttons & 1) !== 0;
	}

	private capturePointer(pointerId: number): void {
		try {
			this.canvas.setPointerCapture(pointerId);
		} catch {
			// Android WebView can reject capture for a hover-originated pointer. The
			// following contact events are still usable and must not abort the gesture.
		}
	}

	private beginTemporaryEraserContact(e: PointerEvent, fromContextHint: boolean): boolean {
		this.activateStylusEraser(e.pointerId, fromContextHint);
		if (!this.isPointerInContact(e)) return false;
		if (!this.isDrawing) {
			if (e.cancelable) e.preventDefault();
			if (this.mobileMode) e.stopPropagation();
			this.capturePointer(e.pointerId);
			this.activePointerId = e.pointerId;
			this.isDrawing = true;
			this.eraserChanged = false;
			this.eraseFromPointerEvent(e);
		}
		return true;
	}

	private eraseFromPointerEvent(e: PointerEvent): void {
		let samples: PointerEvent[] = [];
		try {
			samples = e.getCoalescedEvents?.() ?? [];
		} catch {
			// Some older Android WebViews expose the method but throw when called.
		}
		if (samples.length === 0) samples = [e];
		// This method is only called for an active canvas gesture. Android WebView
		// can report pressure=0 and buttons=0 for valid manual/S Pen drag samples.
		for (const sample of samples) this.eraseAt(this.eventToPoint(sample));
	}

	private matchesStylusContextHint(e: PointerEvent): boolean {
		const hint = this.stylusContextHint;
		return !!hint && Date.now() - hint.at < 900
			&& Math.hypot(e.clientX - hint.x, e.clientY - hint.y) < 96;
	}

	private onContextMenu(e: MouseEvent) {
		const image = this.imageAt(this.eventToPoint(e as unknown as PointerEvent));
		if (image) {
			e.preventDefault(); e.stopPropagation();
			this.selectedImage = image; this.selectedStrokes.clear(); this.selectMode('lasso');
			this.showImageMenu(e);
			return;
		}
		// Fallback for Samsung devices that emit a contextmenu rather than a
		// secondary PointerEvent for the side button. Do not open Android's menu.
		if (!this.mobileMode) return;
		e.preventDefault();
		e.stopPropagation();
		this.stylusButtonHeld = true;
		this.stylusContextHint = { at: Date.now(), x: e.clientX, y: e.clientY };
		if (this.activePointerId !== null) {
			this.activateStylusEraser(this.activePointerId, true);
			if (this.isDrawing) this.eraseAt(this.eventToPoint(e as unknown as PointerEvent));
			return;
		}
		// On several Samsung builds contextmenu arrives while the S Pen button is
		// held above the glass. Arm the *next* pen gesture; never erase on hover.
		if (this.temporaryEraserPreviousMode === null) this.temporaryEraserPreviousMode = this.mode;
		this.temporaryEraserUsesContextHint = true;
		this.setMode('eraser');
		if (this.contextEraserArmTimer !== null) window.clearTimeout(this.contextEraserArmTimer);
		// The side-button contextmenu can arrive while the pen is hovering. Keep
		// the eraser armed long enough for the following touch-and-drag gesture,
		// rather than dropping back to pen after 700ms.
		this.contextEraserArmTimer = window.setTimeout(() => {
			this.contextEraserArmTimer = null;
			if (this.temporaryEraserPointerId !== null) return;
			const previousMode = this.temporaryEraserPreviousMode;
			this.clearTemporaryEraserState();
			if (previousMode) this.setMode(previousMode);
		}, 5000);
	}

	private activateStylusEraser(pointerId = this.activePointerId, fromContextHint = false) {
		if (pointerId !== null && this.contextEraserArmTimer !== null) {
			window.clearTimeout(this.contextEraserArmTimer);
			this.contextEraserArmTimer = null;
		}
		if (this.temporaryEraserPreviousMode === null) {
			this.temporaryEraserPreviousMode = this.mode;
			this.eraserChanged = false;
			this.temporaryEraserUsesContextHint = fromContextHint;
		} else if (!fromContextHint) {
			// A real button bit supersedes the less precise contextmenu fallback and
			// gives us an immediate release signal on the following pointermove.
			this.temporaryEraserUsesContextHint = false;
		}
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

	private restoreTemporaryEraser(pointerId: number, resumeAt?: Point): boolean {
		if (this.temporaryEraserPointerId !== pointerId) return false;
		const previousMode = this.temporaryEraserPreviousMode;
		this.clearTemporaryEraserState();
		if (previousMode) {
			// If the physical side button was released before pointerup, record the
			// erasure now and then begin a fresh pen stroke from the same gesture.
			this.commitEraserChange();
			this.setMode(previousMode);
			if (resumeAt && this.isDrawing && (previousMode === 'pen' || previousMode === 'highlighter')) {
				this.startStroke(resumeAt);
				return true;
			}
		}
		return false;
	}

	private showImageMenu(event: MouseEvent): void {
		this.closeImageMenu();
		const host = this.canvas.parentElement;
		if (!host) return;
		const menu = activeDocument.createElement('div');
		menu.className = 'hwm_image-menu';
		const rect = this.canvas.getBoundingClientRect();
		menu.setCssProps({
			'--hwm-image-menu-left': `${this.canvas.offsetLeft + event.clientX - rect.left}px`,
			'--hwm-image-menu-top': `${this.canvas.offsetTop + event.clientY - rect.top}px`,
		});
		const addAction = (label: string, fn: () => void) => {
			const button = menu.createEl('button', { text: label });
			button.addEventListener('click', () => { fn(); this.closeImageMenu(); });
		};
		if (this.cropMode) {
			addAction('Apply crop', () => this.applyCropSelectedImage());
			addAction('Cancel crop', () => this.cancelCropSelectedImage());
		} else {
			addAction('Crop', () => {
				this.beginCropSelectedImage();
				window.setTimeout(() => this.showImageMenu(event), 0);
			});
			addAction('Delete', () => {
				this.images = this.images.filter(item => item !== this.selectedImage);
				this.selectedImage = null; this.pushHistory(); this.redraw(); this.changeCb?.(); this.imageChangeCb?.();
			});
		}
		host.appendChild(menu); this.imageMenu = menu;
	}

	private closeImageMenu(): void {
		this.imageMenu?.remove(); this.imageMenu = null;
	}

	private clearImageLongPress(): void {
		if (this.imageLongPressTimer !== null) window.clearTimeout(this.imageLongPressTimer);
		this.imageLongPressTimer = null; this.imageLongPressPointerId = null;
	}

	private clearTemporaryEraserState(): void {
		this.temporaryEraserPointerId = null;
		this.temporaryEraserPreviousMode = null;
		this.temporaryEraserUsesContextHint = false;
		this.stylusButtonHeld = false;
		this.stylusButtonPointerId = null;
		if (this.contextEraserArmTimer !== null) {
			window.clearTimeout(this.contextEraserArmTimer);
			this.contextEraserArmTimer = null;
		}
		this.stylusContextHint = null;
	}

	private commitEraserChange() {
		if (!this.eraserChanged) return;
		this.eraserChanged = false;
		this.pushHistory();
		this.changeCb?.();
	}

	private startStroke(pt: Point) {
		this.currentStroke = {
			points: [pt],
			color: this.color,
			width: this.mode === 'highlighter' ? Math.max(16, this.lineWidth * 8) : this.lineWidth,
			opacity: this.mode === 'highlighter' ? 0.32 : 1,
		};
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

		const remainingTexts = this.texts.filter(text => !this.isTextWithinEraser(text, pt, radius));
		if (remainingTexts.length !== this.texts.length) {
			this.texts = remainingTexts;
			changed = true;
		}

		if (changed) {
			this.strokes = newStrokes;
			this.eraserChanged = true;
			this.redraw();
		}
	}

	private isTextWithinEraser(text: TextElement, pt: Point, radius: number): boolean {
		const lines = text.text.split('\n');
		this.ctx.save();
		this.ctx.font = `${text.fontSize}px sans-serif`;
		const width = Math.max(0, ...lines.map(line => this.ctx.measureText(line).width));
		this.ctx.restore();
		const height = Math.max(text.fontSize, lines.length * (text.fontSize + 5));
		return pt.x >= text.x - radius && pt.x <= text.x + width + radius
			&& pt.y >= text.y - radius && pt.y <= text.y + height + radius;
	}

	private imageAt(pt: Point): ImageElement | null {
		for (let i = this.images.length - 1; i >= 0; i--) {
			const image = this.images[i]!;
			if (pt.x >= image.x && pt.x <= image.x + image.width && pt.y >= image.y && pt.y <= image.y + image.height) return image;
		}
		return null;
	}

	private imageResizeHandleAt(image: ImageElement, pt: Point): 'resize-left' | 'resize-top' | 'resize-right' | 'resize-bottom' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw' | null {
		const tolerance = 20;
		const near = (x: number, y: number) => Math.abs(pt.x - x) <= tolerance && Math.abs(pt.y - y) <= tolerance;
		if (near(image.x, image.y)) return 'resize-nw';
		if (near(image.x + image.width, image.y)) return 'resize-ne';
		if (near(image.x + image.width, image.y + image.height)) return 'resize-se';
		if (near(image.x, image.y + image.height)) return 'resize-sw';
		if (pt.y >= image.y - tolerance && pt.y <= image.y + image.height + tolerance && Math.abs(pt.x - image.x) <= tolerance) return 'resize-left';
		if (pt.y >= image.y - tolerance && pt.y <= image.y + image.height + tolerance && Math.abs(pt.x - (image.x + image.width)) <= tolerance) return 'resize-right';
		if (pt.x >= image.x - tolerance && pt.x <= image.x + image.width + tolerance && Math.abs(pt.y - image.y) <= tolerance) return 'resize-top';
		if (pt.x >= image.x - tolerance && pt.x <= image.x + image.width + tolerance && Math.abs(pt.y - (image.y + image.height)) <= tolerance) return 'resize-bottom';
		return null;
	}

	private resizeImage(image: ImageElement, edge: 'resize-left' | 'resize-top' | 'resize-right' | 'resize-bottom' | 'resize-nw' | 'resize-ne' | 'resize-se' | 'resize-sw', dx: number, dy: number): void {
		const oldWidth = image.width, oldHeight = image.height;
		if (edge === 'resize-left') { const width = Math.max(48, oldWidth - dx); image.x += oldWidth - width; image.width = width; return; }
		if (edge === 'resize-right') { image.width = Math.max(48, oldWidth + dx); return; }
		if (edge === 'resize-top') { const height = Math.max(48, oldHeight - dy); image.y += oldHeight - height; image.height = height; return; }
		if (edge === 'resize-bottom') { image.height = Math.max(48, oldHeight + dy); return; }
		const horizontal = edge === 'resize-nw' || edge === 'resize-sw' ? -dx : dx;
		const vertical = edge === 'resize-nw' || edge === 'resize-ne' ? -dy : dy;
		const scale = Math.max(48 / oldWidth, 48 / oldHeight, (oldWidth + horizontal) / oldWidth, (oldHeight + vertical) / oldHeight);
		const width = oldWidth * scale, height = oldHeight * scale;
		if (edge === 'resize-nw' || edge === 'resize-sw') image.x += oldWidth - width;
		if (edge === 'resize-nw' || edge === 'resize-ne') image.y += oldHeight - height;
		image.width = width; image.height = height;
	}

	private imageCrop(image: ImageElement) {
		return image.crop ?? { left: 0, top: 0, right: 1, bottom: 1 };
	}

	private cropHandleAt(image: ImageElement, pt: Point): 'crop-left' | 'crop-top' | 'crop-right' | 'crop-bottom' | null {
		const crop = this.imageCrop(image);
		const left = image.x + image.width * crop.left;
		const right = image.x + image.width * crop.right;
		const top = image.y + image.height * crop.top;
		const bottom = image.y + image.height * crop.bottom;
		const tolerance = 18;
		if (pt.y >= top - tolerance && pt.y <= bottom + tolerance && Math.abs(pt.x - left) <= tolerance) return 'crop-left';
		if (pt.y >= top - tolerance && pt.y <= bottom + tolerance && Math.abs(pt.x - right) <= tolerance) return 'crop-right';
		if (pt.x >= left - tolerance && pt.x <= right + tolerance && Math.abs(pt.y - top) <= tolerance) return 'crop-top';
		if (pt.x >= left - tolerance && pt.x <= right + tolerance && Math.abs(pt.y - bottom) <= tolerance) return 'crop-bottom';
		return null;
	}

	private adjustImageCrop(image: ImageElement, handle: 'crop-left' | 'crop-top' | 'crop-right' | 'crop-bottom', dx: number, dy: number): void {
		const crop = { ...this.imageCrop(image) };
		const minimum = 0.08;
		if (handle === 'crop-left') crop.left = Math.max(0, Math.min(crop.right - minimum, crop.left + dx / image.width));
		if (handle === 'crop-right') crop.right = Math.min(1, Math.max(crop.left + minimum, crop.right + dx / image.width));
		if (handle === 'crop-top') crop.top = Math.max(0, Math.min(crop.bottom - minimum, crop.top + dy / image.height));
		if (handle === 'crop-bottom') crop.bottom = Math.min(1, Math.max(crop.top + minimum, crop.bottom + dy / image.height));
		image.crop = crop;
	}

	private loadImage(src: string): Promise<HTMLImageElement> {
		const cached = this.imageBitmaps.get(src);
		if (cached?.complete) return Promise.resolve(cached);
		return new Promise((resolve, reject) => {
			const image = cached ?? new Image();
			image.onload = () => { this.imageBitmaps.set(src, image); this.redraw(); resolve(image); };
			image.onerror = () => reject(new Error('Unable to load image'));
			image.src = src;
			this.imageBitmaps.set(src, image);
		});
	}

	private preloadImages(): void {
		for (const image of this.images) void this.loadImage(image.src).catch(() => undefined);
	}

	private onKeyDown(event: KeyboardEvent): void {
		if (event.defaultPrevented || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
		const modifier = event.ctrlKey || event.metaKey;
		if (modifier && event.key.toLowerCase() === 'v' && this.imageClipboard) {
			const image = { ...this.imageClipboard, id: `image_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: this.imageClipboard.x + 24, y: this.imageClipboard.y + 24 };
			this.images.push(image); this.selectedImage = image; this.pushHistory(); this.redraw(); this.changeCb?.(); this.imageChangeCb?.(); event.preventDefault();
		} else if (modifier && event.key.toLowerCase() === 'c' && this.selectedImage) {
			this.imageClipboard = { ...this.selectedImage };
			event.preventDefault();
		} else if (modifier && event.key.toLowerCase() === 'x' && this.selectedImage) {
			this.imageClipboard = { ...this.selectedImage };
			this.images = this.images.filter(image => image !== this.selectedImage);
			this.selectedImage = null;
			this.pushHistory(); this.redraw(); this.changeCb?.(); this.imageChangeCb?.(); event.preventDefault();
		} else if ((event.key === 'Delete' || event.key === 'Backspace') && this.selectedImage) {
			this.images = this.images.filter(image => image !== this.selectedImage);
			this.selectedImage = null;
			this.pushHistory(); this.redraw(); this.changeCb?.(); this.imageChangeCb?.(); event.preventDefault();
		}
	}

	private onPaste(event: ClipboardEvent): void {
		if (event.defaultPrevented || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
		const file = Array.from(event.clipboardData?.files ?? []).find(item => item.type.startsWith('image/'));
		if (file) { event.preventDefault(); void this.insertImage(file); return; }
		if (this.imageClipboard) {
			const image = { ...this.imageClipboard, id: `image_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, x: this.imageClipboard.x + 24, y: this.imageClipboard.y + 24 };
			this.images.push(image); this.selectedImage = image; this.pushHistory(); this.redraw(); this.changeCb?.(); this.imageChangeCb?.(); event.preventDefault();
		}
	}

	/* --- Rendering --- */

	private clearBackground() {
		// Usa pixel logici: ctx.scale(dpr, dpr) è già applicato nel constructor/resize
		const w = this.logicalWidth;
		const h = this.logicalHeight;

		// Filling with a transparent color does not remove pixels already painted.
		// Clear first so switching from a solid paper color is truly transparent.
		this.ctx.clearRect(0, 0, w, h);
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
		for (const image of this.images) this.drawImageElement(image);
		for (const stroke of this.strokes) {
			this.drawFullStroke(stroke);
		}
		for (const text of this.texts) this.drawTextElement(text);
		
		if (this.mode === 'lasso') {
			if (this.lassoPath.length > 0) {
				const startPt = this.lassoPath[0];
				if (startPt) {
					this.ctx.beginPath();
					this.ctx.moveTo(startPt.x * this.viewScale, startPt.y);
					for (let i = 1; i < this.lassoPath.length; i++) {
						const nextPt = this.lassoPath[i];
						if (nextPt) this.ctx.lineTo(nextPt.x * this.viewScale, nextPt.y);
					}
					this.ctx.strokeStyle = '#2196F3';
					this.ctx.lineWidth = 1.5;
					this.ctx.setLineDash([5, 5]);
					this.ctx.stroke();
					this.ctx.setLineDash([]);
				}
			}
			for (const stroke of this.selectedStrokes) {
				let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
				for (const p of stroke.points) {
					if (p.x < minX) minX = p.x;
					if (p.x > maxX) maxX = p.x;
					if (p.y < minY) minY = p.y;
					if (p.y > maxY) maxY = p.y;
				}
				const margin = stroke.width + 2;
				this.ctx.strokeStyle = 'rgba(33, 150, 243, 0.9)';
				this.ctx.lineWidth = 2;
				this.ctx.setLineDash([4, 4]);
				this.ctx.strokeRect(
					(minX - margin) * this.viewScale,
					minY - margin,
					(maxX - minX + margin * 2) * this.viewScale,
					maxY - minY + margin * 2
				);
				this.ctx.setLineDash([]);
			}
			if (this.selectedImage) this.drawImageSelection(this.selectedImage);
		}
	}

	private drawImageElement(element: ImageElement): void {
		const image = this.imageBitmaps.get(element.src);
		if (!image?.complete) return;
		const crop = this.imageCrop(element);
		this.ctx.save(); this.ctx.scale(this.viewScale, 1);
		// While cropping, show the original image with a movable crop frame.
		if (this.cropMode && this.selectedImage === element) this.ctx.drawImage(image, element.x, element.y, element.width, element.height);
		else this.ctx.drawImage(image, image.naturalWidth * crop.left, image.naturalHeight * crop.top,
			image.naturalWidth * (crop.right - crop.left), image.naturalHeight * (crop.bottom - crop.top),
			element.x, element.y, element.width, element.height);
		this.ctx.restore();
	}

	private drawImageSelection(image: ImageElement): void {
		const ctx = this.ctx; ctx.save(); ctx.scale(this.viewScale, 1);
		ctx.strokeStyle = 'rgba(33, 150, 243, 0.95)'; ctx.lineWidth = 2 / this.viewScale; ctx.setLineDash([5 / this.viewScale, 4 / this.viewScale]);
		if (this.cropMode) {
			const crop = this.imageCrop(image);
			const x = image.x + image.width * crop.left, y = image.y + image.height * crop.top;
			const width = image.width * (crop.right - crop.left), height = image.height * (crop.bottom - crop.top);
			ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
			ctx.fillRect(image.x, image.y, image.width, y - image.y);
			ctx.fillRect(image.x, y, x - image.x, height);
			ctx.fillRect(x + width, y, image.x + image.width - (x + width), height);
			ctx.fillRect(image.x, y + height, image.width, image.y + image.height - (y + height));
			ctx.strokeRect(x, y, width, height);
			ctx.fillStyle = '#2196F3';
			const size = 14 / this.viewScale;
			for (const [handleX, handleY] of [[x, y + height / 2], [x + width, y + height / 2], [x + width / 2, y], [x + width / 2, y + height]] as [number, number][]) {
				ctx.fillRect(handleX - size / 2, handleY - size / 2, size, size);
			}
		} else {
			ctx.strokeRect(image.x, image.y, image.width, image.height);
			ctx.fillStyle = '#2196F3';
			const size = 14 / this.viewScale;
			const handles: [number, number][] = [
				[image.x, image.y + image.height / 2], [image.x + image.width, image.y + image.height / 2],
				[image.x + image.width / 2, image.y], [image.x + image.width / 2, image.y + image.height],
				[image.x, image.y], [image.x + image.width, image.y],
				[image.x + image.width, image.y + image.height], [image.x, image.y + image.height],
			];
			for (const [x, y] of handles) ctx.fillRect(x - size / 2, y - size / 2, size, size);
		}
		ctx.setLineDash([]);
		ctx.restore();
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

import { Notice, TFile } from 'obsidian';
import type HandwritingPlugin from './main';
import { DrawingCanvas } from './drawing-canvas';
import { buildEditorUI, replaceInMdFile, saveSvgToDisk } from './editor-view';
import { t } from './i18n';

/** A canvas editor embedded directly in a Markdown render/widget node. */
export class InlineDrawingEditor {
	private canvas: DrawingCanvas | null = null;
	private bgModeListener: ((bgMode: string) => void) | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private saveTimer: number | null = null;
	private closing = false;

	constructor(
		private readonly host: HTMLElement,
		private readonly plugin: HandwritingPlugin,
		private readonly embedId: string,
		private readonly svgPath: string,
		private readonly sourcePath: string,
		private readonly onClosed: () => void,
		private readonly onLayoutChanged: () => void = () => {},
	) {}

	async open(): Promise<void> {
		this.host.empty();
		this.host.addClass('hwm_editor-view', 'hwm_inline-editor');
		const { canvas, bgModeListener } = await buildEditorUI({
			el: this.host, plugin: this.plugin, svgPath: this.svgPath,
			embedId: this.embedId, sourcePath: this.sourcePath,
			onClose: async () => this.close(),
			afterCanvas: (drawingCanvas, scrollWrap) => {
			this.resizeObserver = new ResizeObserver(() => {
				const width = scrollWrap.clientWidth;
				if (width > 0) drawingCanvas.setDisplayWidth(width, false);
				this.requestLayout();
			});
				this.resizeObserver.observe(scrollWrap);
				this.resizeObserver.observe(this.host);
			},
			doSave: () => this.save(), doDelete: () => this.delete(),
		});
		if (this.closing) {
			canvas.destroy();
			this.plugin.bgModeListeners.delete(bgModeListener);
			return;
		}
		this.canvas = canvas;
		this.bgModeListener = bgModeListener;
		canvas.onChange(() => this.scheduleSave());
		this.requestLayout();
	}

	async close(save = true): Promise<void> {
		if (this.closing) return;
		this.closing = true;
		await this.dispose(save);
		this.host.empty();
		this.host.removeClass('hwm_editor-view', 'hwm_inline-editor');
		this.requestLayout();
		this.onClosed();
	}

	destroy(): void {
		if (this.closing) return;
		this.closing = true;
		void this.dispose(true);
	}

	private scheduleSave(): void {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = window.setTimeout(() => { void this.save(); }, 700);
	}

	private async dispose(save: boolean): Promise<void> {
		if (this.saveTimer) window.clearTimeout(this.saveTimer);
		this.saveTimer = null;
		if (save) await this.save();
		this.canvas?.destroy();
		this.canvas = null;
		if (this.bgModeListener) this.plugin.bgModeListeners.delete(this.bgModeListener);
		this.bgModeListener = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
	}

	private requestLayout(): void {
		window.requestAnimationFrame(() => this.onLayoutChanged());
	}

	private async save(): Promise<void> {
		if (this.canvas) await saveSvgToDisk(this.canvas, this.svgPath, this.embedId, this.plugin);
	}

	private async delete(): Promise<void> {
		if (!await this.confirmDelete()) return;
		await replaceInMdFile(this.sourcePath, this.svgPath, this.embedId, '\n', this.plugin);
		const svgFile = this.plugin.app.vault.getAbstractFileByPath(this.svgPath);
		if (svgFile instanceof TFile) await this.plugin.app.fileManager.trashFile(svgFile);
		await this.close(false);
		new Notice(t('notice_deleted'));
	}

	private confirmDelete(): Promise<boolean> {
		return new Promise(resolve => {
			const overlay = this.host.createDiv({ cls: 'hwm_confirm-overlay' });
			overlay.createEl('span', { text: t('confirm_delete'), cls: 'hwm_confirm-msg' });
			const ok = overlay.createEl('button', { text: t('confirm_ok'), cls: 'mod-warning' });
			const cancel = overlay.createEl('button', { text: t('confirm_cancel') });
			ok.addEventListener('click', () => { overlay.remove(); resolve(true); }, { once: true });
			cancel.addEventListener('click', () => { overlay.remove(); resolve(false); }, { once: true });
			ok.focus();
		});
	}
}

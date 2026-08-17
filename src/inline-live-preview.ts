import { editorLivePreviewField, MarkdownView, Notice, TFile, setIcon } from 'obsidian';
import { StateField, RangeSetBuilder } from '@codemirror/state';
import { Decoration, DecorationSet, EditorView, WidgetType } from '@codemirror/view';
import type HandwritingPlugin from './main';
import { InlineDrawingEditor } from './inline-editor';
import { t } from './i18n';

const HANDWRITING_EMBED = /!\[\[([^\]|]+\.svg)(?:\|[^\]]*)?\]\]/g;

class InlineHandwritingWidget extends WidgetType {
	private editor: InlineDrawingEditor | null = null;
	private sourcePath = '';
	private editorView: EditorView | null = null;

	constructor(private readonly plugin: HandwritingPlugin, private readonly svgPath: string) { super(); }

	eq(other: InlineHandwritingWidget): boolean { return this.svgPath === other.svgPath; }

	toDOM(view: EditorView): HTMLElement {
		this.editorView = view;
		const root = activeDocument.createElement('div');
		root.className = 'hwm_live-preview-widget';
		root.setAttribute('contenteditable', 'false');
		root.tabIndex = -1;
		this.sourcePath = sourcePathFor(this.plugin, view);
		this.renderPreview(root);
		return root;
	}

	destroy(): void {
		this.editor?.destroy();
		this.editor = null;
	}

	// Widgets own their controls. CodeMirror must not consume touch, pen, select,
	// or colour-picker events before the native element receives them.
	ignoreEvent(): boolean { return true; }

	private renderPreview(root: HTMLElement): void {
		root.empty();
		const preview = root.createDiv({ cls: 'hwm_live-preview-image' });
		const file = this.plugin.app.vault.getAbstractFileByPath(this.svgPath);
		if (file instanceof TFile) {
			const image = preview.createEl('img', { attr: { alt: this.svgPath } });
			image.src = this.plugin.app.vault.getResourcePath(file);
		} else {
			preview.createEl('span', { text: t('notice_placeholder_draw') });
		}

		const edit = root.createEl('button', { cls: 'hwm_live-preview-edit', attr: { title: t('btn_open_editor') } });
		setIcon(edit, 'pencil');
		edit.createEl('span', { text: 'Edit', cls: 'hwm_live-preview-edit-label' });
		const openEditor = (event: Event) => {
			event.preventDefault();
			event.stopPropagation();
			if (this.editor) return;
			this.editor = new InlineDrawingEditor(root, this.plugin, this.embedId, this.svgPath, this.sourcePath, () => {
				this.editor = null;
				this.renderPreview(root);
			}, () => this.editorView?.requestMeasure());
			void this.editor.open().catch(error => {
				this.editor = null;
				this.renderPreview(root);
				console.error('Inline Handwriting could not open the editor:', error);
				new Notice('Unable to open the inline editor: ' + (error instanceof Error ? error.message : String(error)));
			});
		};
		// pointerup avoids Android cancelling a short S Pen tap after the widget
		// has already rebuilt itself. click keeps mouse/keyboard activation working.
		edit.addEventListener('pointerup', openEditor);
		edit.addEventListener('touchend', openEditor, { passive: false });
		edit.addEventListener('click', openEditor);
		preview.addEventListener('dblclick', openEditor);
	}

	private get embedId(): string {
		return this.svgPath.split('/').pop()?.replace(/\.svg$/i, '') ?? this.svgPath;
	}
}

function sourcePathFor(plugin: HandwritingPlugin, editorView: EditorView): string {
	for (const leaf of plugin.app.workspace.getLeavesOfType('markdown')) {
		const markdownView = leaf.view as MarkdownView;
		const cm = (markdownView.editor as unknown as { cm?: EditorView } | undefined)?.cm;
		if (cm === editorView) return markdownView.file?.path ?? '';
	}
	return plugin.app.workspace.getActiveFile()?.path ?? '';
}

function buildDecorations(plugin: HandwritingPlugin, state: EditorView['state']): DecorationSet {
	if (!state.field(editorLivePreviewField, false)) return Decoration.none;
	const builder = new RangeSetBuilder<Decoration>();
	for (const match of state.doc.toString().matchAll(HANDWRITING_EMBED)) {
		const svgPath = match[1];
		if (!svgPath || !svgPath.startsWith(plugin.settings.svgFolder + '/')) continue;
		const fileName = svgPath.split('/').pop() ?? '';
		if (!/^(hw_|HTMD_).+\.svg$/i.test(fileName)) continue;
		const from = match.index ?? 0;
		builder.add(from, from + match[0].length, Decoration.replace({
			widget: new InlineHandwritingWidget(plugin, svgPath),
			block: true,
		}));
	}
	return builder.finish();
}

/** Registers a Live Preview widget so editing stays anchored in the current note. */
export function registerInlineLivePreview(plugin: HandwritingPlugin): void {
	const field = StateField.define<DecorationSet>({
		create: state => buildDecorations(plugin, state),
		update: (decorations, transaction) => transaction.docChanged
			? buildDecorations(plugin, transaction.state)
			: decorations.map(transaction.changes),
		provide: fieldValue => EditorView.decorations.from(fieldValue),
	});
	plugin.registerEditorExtension(field);
}

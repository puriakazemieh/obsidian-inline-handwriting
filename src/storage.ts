import { App, normalizePath, TFolder } from 'obsidian';

/** Keep Obsidian's SVG embeds intact while excluding their folder from Android media scans. */
export async function ensureHandwritingFolder(app: App, folderPath: string, create = true): Promise<void> {
	const folder = normalizePath(folderPath);
	if (!folder || folder === '/') return;
	if (!app.vault.getAbstractFileByPath(folder)) {
		if (!create) return;
		const parts = folder.split('/');
		for (let i = 1; i <= parts.length; i++) {
			const path = parts.slice(0, i).join('/');
			if (!app.vault.getAbstractFileByPath(path)) await app.vault.createFolder(path);
		}
	}
	if (!(app.vault.getAbstractFileByPath(folder) instanceof TFolder)) return;
	const marker = `${folder}/.nomedia`;
	if (!(await app.vault.adapter.exists(marker))) await app.vault.adapter.write(marker, '');
}

/** Add media-scan markers to folders containing drawings from older installs. */
export async function hideExistingHandwritingFromGallery(app: App, configuredFolder: string): Promise<void> {
	const folders = new Set([configuredFolder, '_inline_handwriting', '_handwriting']);
	for (const file of app.vault.getFiles()) {
		if (file.extension !== 'svg' || !/^(hw_|HTMD_)/i.test(file.basename)) continue;
		// Never hide the entire vault if someone saved a drawing at its root.
		if (file.parent?.path && file.parent.path !== '/') folders.add(file.parent.path);
	}
	for (const folder of folders) await ensureHandwritingFolder(app, folder, false);
}

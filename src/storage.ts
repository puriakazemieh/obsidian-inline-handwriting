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

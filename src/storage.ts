import { App, normalizePath, TFile, TFolder } from 'obsidian';

const OLD_GALLERY_FOLDER = '_inline_handwriting';
const PRIVATE_GALLERY_FOLDER = '_inline_handwriting_private';

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

/** Move previously indexed SVGs into a fresh marked folder without breaking note embeds. */
export async function migrateIndexedGalleryFolder(app: App, configuredFolder: string): Promise<string> {
	if (normalizePath(configuredFolder) !== OLD_GALLERY_FOLDER) return configuredFolder;
	const oldFolder = app.vault.getAbstractFileByPath(OLD_GALLERY_FOLDER);
	const targetFolder = app.vault.getAbstractFileByPath(PRIVATE_GALLERY_FOLDER);
	if (!(oldFolder instanceof TFolder) && !(targetFolder instanceof TFolder)) return configuredFolder;
	if (targetFolder && !(targetFolder instanceof TFolder)) return configuredFolder;
	if (targetFolder instanceof TFolder) {
		// A previous run may have moved the directory before note links finished.
		if (!targetFolder.children.some(file => file.path.toLowerCase().endsWith('.svg'))
			&& !(oldFolder instanceof TFolder && oldFolder.children.some(file => file.path.toLowerCase().endsWith('.svg')))) {
			return configuredFolder;
		}
		if (oldFolder instanceof TFolder) {
			for (const file of [...oldFolder.children]) {
				if (!(file instanceof TFile) || file.extension !== 'svg') continue;
				const destination = `${PRIVATE_GALLERY_FOLDER}/${file.name}`;
				if (!app.vault.getAbstractFileByPath(destination)) {
					await app.fileManager.renameFile(file, destination);
				}
			}
		}
	} else if (oldFolder instanceof TFolder) {
		await ensureHandwritingFolder(app, OLD_GALLERY_FOLDER, false);
		await app.fileManager.renameFile(oldFolder, PRIVATE_GALLERY_FOLDER);
	}
	await ensureHandwritingFolder(app, PRIVATE_GALLERY_FOLDER, false);
	// FileManager updates wikilinks according to Obsidian's preference. Cover
	// disabled link updates and the legacy JSON code blocks that it cannot see.
	for (const note of app.vault.getMarkdownFiles()) {
		const content = await app.vault.read(note);
		const updated = content
			.replace(/(!\[\[)_inline_handwriting\/((?:hw_|HTMD_)[^\]|]+\.svg)/gi,
				`$1${PRIVATE_GALLERY_FOLDER}/$2`)
			.replace(/(["']svg["']\s*:\s*["'])_inline_handwriting\/((?:hw_|HTMD_)[^"']+\.svg)/gi,
				`$1${PRIVATE_GALLERY_FOLDER}/$2`);
		if (updated !== content) await app.vault.modify(note, updated);
	}
	// Keep the old directory ignored if an older synced device writes into it.
	await ensureHandwritingFolder(app, OLD_GALLERY_FOLDER);
	return PRIVATE_GALLERY_FOLDER;
}

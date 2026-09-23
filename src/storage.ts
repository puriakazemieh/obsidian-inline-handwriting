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

/** Repair embeds left pointing at the old folder by a sync conflict or a
 * folder rename. A sync may deliver a note after the folder has moved, so this
 * is also called for later markdown modifications. Only rewrite existing files. */
export async function repairHandwritingLinks(app: App, note: TFile): Promise<void> {
	if (note.extension !== 'md') return;
	const fix = (content: string) => content.replace(
		/(!\[\[|!\[[^\]]*\]\(|["']svg["']\s*:\s*["'])_inline_handwriting\/((?:hw_|HTMD_)[^\s\]|)"'<>]+\.svg)/gi,
		(match, prefix: string, filename: string) => app.vault.getAbstractFileByPath(
			`${PRIVATE_GALLERY_FOLDER}/${filename}`
		) instanceof TFile && !(app.vault.getAbstractFileByPath(`${OLD_GALLERY_FOLDER}/${filename}`) instanceof TFile)
			? `${prefix}${PRIVATE_GALLERY_FOLDER}/${filename}` : match);
	const content = await app.vault.read(note);
	if (fix(content) !== content) await app.vault.process(note, fix);
}

/** Move drawings individually so that Obsidian Sync sees file changes instead
 * of a folder rename. The destination remains stable on both devices. */
export async function migrateIndexedGalleryFolder(app: App, configuredFolder: string): Promise<string> {
	const oldFolder = app.vault.getAbstractFileByPath(OLD_GALLERY_FOLDER);
	const targetFolder = app.vault.getAbstractFileByPath(PRIVATE_GALLERY_FOLDER);
	if (normalizePath(configuredFolder) !== OLD_GALLERY_FOLDER
		&& normalizePath(configuredFolder) !== PRIVATE_GALLERY_FOLDER) return configuredFolder;
	if (targetFolder && !(targetFolder instanceof TFolder)) return configuredFolder;
	await ensureHandwritingFolder(app, PRIVATE_GALLERY_FOLDER);
	if (oldFolder instanceof TFolder) {
		for (const file of [...oldFolder.children]) {
			if (!(file instanceof TFile) || file.extension !== 'svg'
				|| !/^(hw_|HTMD_)/i.test(file.basename)) continue;
			const destination = `${PRIVATE_GALLERY_FOLDER}/${file.name}`;
			if (!app.vault.getAbstractFileByPath(destination)) {
				await app.fileManager.renameFile(file, destination);
			}
		}
	}
	await ensureHandwritingFolder(app, OLD_GALLERY_FOLDER);
	for (const note of app.vault.getMarkdownFiles()) await repairHandwritingLinks(app, note);
	return PRIVATE_GALLERY_FOLDER;
}

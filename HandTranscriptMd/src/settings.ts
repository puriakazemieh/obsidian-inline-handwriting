import { App, PluginSettingTab, Setting } from 'obsidian';
import type HandwritingPlugin from './main';
import { t, setLocale, availableLocales, localeNames } from './i18n';

export type BgMode = 'light' | 'dark' | 'auto';

export interface HandwritingSettings {
	svgFolder: string;
	canvasWidth: number;
	canvasHeight: number;
	bgMode: BgMode;
	debugMode: boolean;
	uiLanguage: string;
	customPalette: string[];
	defaultPalette: string[];
	storageNamespaceMigrated: boolean;
}

export const BG_COLORS: Record<'light' | 'dark', string> = {
	light: '#ffffff',
	dark: '#1e1e1e',
};

export const LINE_COLORS: Record<'light' | 'dark', string> = {
	light: '#e0e0e0',
	dark: '#3a3a3a',
};

function resolveAutoMode(): 'light' | 'dark' {
	return activeDocument.body.classList.contains('theme-dark') ? 'dark' : 'light';
}

export function getEffectiveBgColor(settings: HandwritingSettings): string {
	if (settings.bgMode === 'auto') {
		const appBackground = getComputedStyle(activeDocument.body).getPropertyValue('--background-primary').trim();
		if (appBackground) return appBackground;
	}
	const mode = settings.bgMode === 'auto' ? resolveAutoMode() : settings.bgMode;
	return BG_COLORS[mode];
}

export function getEffectiveLineColor(settings: HandwritingSettings): string {
	if (settings.bgMode === 'auto') {
		const appLineColor = getComputedStyle(activeDocument.body).getPropertyValue('--background-modifier-border').trim();
		if (appLineColor) return appLineColor;
	}
	const mode = settings.bgMode === 'auto' ? resolveAutoMode() : settings.bgMode;
	return LINE_COLORS[mode];
}

export const LIGHT_COLORS = ['#1f2937', '#2563eb', '#dc2626', '#059669', '#7c3aed'];
export const DARK_COLORS = ['#f8fafc', '#60a5fa', '#fb7185', '#34d399', '#c4b5fd'];

export function getQuickPalette(settings: HandwritingSettings, isDark: boolean): string[] {
	const defaults = settings.defaultPalette?.length === LIGHT_COLORS.length
		? settings.defaultPalette.map(color => remapStrokeColor(color, isDark ? 'dark' : 'light'))
		: (isDark ? DARK_COLORS : LIGHT_COLORS);
	return [...defaults, ...(settings.customPalette ?? [])];
}

export function resolveIsDark(bgMode: string): boolean {
	if (bgMode === 'auto') return activeDocument.body.classList.contains('theme-dark');
	return bgMode === 'dark';
}

export function remapStrokeColor(color: string, bgMode: BgMode): string {
	const mode = bgMode === 'auto' ? resolveAutoMode() : bgMode;
	const normalized = normalizeColor(color);
	if (mode === 'dark' && normalized === '#000000') return '#f8fafc';
	if (mode === 'light' && normalized === '#ffffff') return '#1f2937';
	if (mode === 'dark') {
		const index = LIGHT_COLORS.indexOf(normalized);
		if (index >= 0) return DARK_COLORS[index]!;
	} else {
		const index = DARK_COLORS.indexOf(normalized);
		if (index >= 0) return LIGHT_COLORS[index]!;
	}
	return color;
}

function normalizeColor(color: string): string {
	const normalized = color.trim().toLowerCase();
	if (/^#[0-9a-f]{3}$/.test(normalized)) return '#' + normalized.slice(1).split('').map(char => char + char).join('');
	return normalized;
}

export const DEFAULT_SETTINGS: HandwritingSettings = {
	svgFolder: '_inline_handwriting',
	canvasWidth: 800,
	canvasHeight: 300,
	bgMode: 'auto',
	debugMode: false,
	uiLanguage: 'auto',
	customPalette: [],
	defaultPalette: [],
	storageNamespaceMigrated: false,
};

export class HandwritingSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: HandwritingPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass('hwm_settings');
		containerEl.createEl('p', { text: `v${this.plugin.manifest.version}`, cls: 'setting-item-description' });

		new Setting(containerEl)
			.setName(t('ui_language_name'))
			.setDesc(t('ui_language_desc'))
			.addDropdown(dropdown => {
				dropdown.addOption('auto', t('ui_language_auto'));
				availableLocales().forEach(code => { dropdown.addOption(code, localeNames[code] ?? code); });
				dropdown.setValue(this.plugin.settings.uiLanguage);
				dropdown.onChange(value => { void (async () => {
					this.plugin.settings.uiLanguage = value;
					await this.plugin.saveSettings();
					setLocale(value);
					this.display();
				})().catch(console.error); });
			});

		new Setting(containerEl)
			.setName(t('svg_folder_name'))
			.setDesc(t('svg_folder_desc'))
			.addText(text => text
				.setPlaceholder('_inline_handwriting')
				.setValue(this.plugin.settings.svgFolder)
				.onChange(async value => {
					this.plugin.settings.svgFolder = value || '_inline_handwriting';
					await this.plugin.saveSettings();
				}));

		new Setting(containerEl)
			.setName(t('canvas_width_name'))
			.setDesc(t('canvas_width_desc'))
			.addText(text => text.setValue(String(this.plugin.settings.canvasWidth)).onChange(async value => {
				const width = parseInt(value);
				if (!isNaN(width) && width > 100) {
					this.plugin.settings.canvasWidth = width;
					await this.plugin.saveSettings();
				}
			}));

		new Setting(containerEl)
			.setName(t('canvas_height_name'))
			.setDesc(t('canvas_height_desc'))
			.addText(text => text.setValue(String(this.plugin.settings.canvasHeight)).onChange(async value => {
				const height = parseInt(value);
				if (!isNaN(height) && height > 50) {
					this.plugin.settings.canvasHeight = height;
					await this.plugin.saveSettings();
				}
			}));

		new Setting(containerEl)
			.setName(t('bg_mode_name'))
			.setDesc(t('bg_mode_desc'))
			.addDropdown(dropdown => dropdown
				.addOption('auto', t('bg_mode_auto'))
				.addOption('light', t('bg_mode_light'))
				.addOption('dark', t('bg_mode_dark'))
				.setValue(this.plugin.settings.bgMode)
				.onChange(async value => {
					this.plugin.settings.bgMode = value as BgMode;
					await this.plugin.saveSettings();
					this.plugin.notifyBgModeChange();
				}));

		new Setting(containerEl)
			.setName('Additional quick colours')
			.setDesc('Up to five hex colours, separated by commas. You can edit any quick colour directly from the drawing toolbar.')
			.addText(text => text
				.setPlaceholder('#F59e0b, #a855f7')
				.setValue(this.plugin.settings.customPalette.join(', '))
				.onChange(async value => {
					this.plugin.settings.customPalette = value.split(',')
						.map(color => color.trim())
						.filter(color => /^#[0-9a-f]{6}$/i.test(color))
						.filter((color, index, all) => all.indexOf(color) === index)
						.slice(0, 5);
					await this.plugin.saveSettings();
				}));
	}
}

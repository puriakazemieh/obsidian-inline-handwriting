/* =============================================
   SVG Utilities — Conversione tratti ↔ SVG
   I tratti vengono salvati come <path> nell'SVG,
   e i dati grezzi in un elemento <desc> (JSON)
   per poter ricaricare e rieditare il disegno.
   ============================================= */

import { BackgroundPattern, Point, Stroke, TextElement, LINE_SPACING } from './drawing-canvas';

export interface SvgBackground {
	color: string;
	lineColor: string;
	pattern: BackgroundPattern;
	spacing: number;
}

// Genera ID univoco per nuovi disegni nel formato HTMD_YYYYMMDDHHMMSS_XXXX
export function generateId(): string {
	const now = new Date();
	const p = (n: number) => String(n).padStart(2, '0');
	const date = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
	const time = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const rnd  = Math.random().toString(36).substring(2, 6).toUpperCase();
	return `HTMD_${date}${time}_${rnd}`;
}

// Converte un array di punti in un attributo SVG path "d"
// Usa curve quadratiche Bézier con midpoint per smoothing
function pointsToPathD(points: Point[]): string {
	if (points.length < 2) return '';

	const parts: string[] = [];
	// Move to primo punto
	parts.push(`M ${r(points[0]!.x)},${r(points[0]!.y)}`);

	if (points.length === 2) {
		parts.push(`L ${r(points[1]!.x)},${r(points[1]!.y)}`);
	} else {
		// Curve quadratiche con midpoint (stessa tecnica del canvas)
		for (let i = 1; i < points.length - 1; i++) {
			const curr = points[i]!;
			const next = points[i + 1]!;
			const midX = (curr.x + next.x) / 2;
			const midY = (curr.y + next.y) / 2;
			parts.push(`Q ${r(curr.x)},${r(curr.y)} ${r(midX)},${r(midY)}`);
		}
		// Ultimo punto
		const last = points[points.length - 1]!;
		parts.push(`L ${r(last.x)},${r(last.y)}`);
	}

	return parts.join(' ');
}

// Arrotonda a 1 decimale per SVG più compatti
function r(n: number): string {
	return Math.round(n * 10) / 10 + '';
}

// Converte array di Stroke in contenuto SVG completo
// I dati grezzi dei tratti sono dentro <desc> come JSON
// per permettere il riedit senza perdere informazioni
export function strokesToSvg(
	strokes: Stroke[], width: number, height: number,
	bgColor = '#ffffff', lineColor = '#e0e0e0',
	pattern: BackgroundPattern = 'ruled', spacing = LINE_SPACING,
	texts: TextElement[] = [],
): string {
	const paths: string[] = [];

	for (const stroke of strokes) {
		const d = pointsToPathD(stroke.points);
		if (!d) continue;
		paths.push(
			`  <path d="${d}" stroke="${stroke.color}" fill="none" ` +
			`stroke-width="${stroke.width}" stroke-opacity="${stroke.opacity ?? 1}" stroke-linecap="round" stroke-linejoin="round"/>`
		);
	}

	const strokesJson = JSON.stringify(strokes);
	const textsJson = JSON.stringify(texts);
	const textNodes = texts.flatMap(text => text.text.split('\n').map((line, index) =>
		`  <text x="${r(text.x)}" y="${r(text.y + index * (text.fontSize + 5))}" fill="${text.color}" font-size="${text.fontSize}" font-family="sans-serif" dominant-baseline="hanging">${escapeXml(line)}</text>`
	));

	// Righe orizzontali (foglio a righe) — stessa spaziatura del canvas
	const safeSpacing = Math.max(12, Math.min(120, spacing));
	const background: SvgBackground = { color: bgColor, lineColor, pattern, spacing: safeSpacing };
	const lines: string[] = [];
	if (pattern === 'ruled' || pattern === 'grid') {
		for (let y = safeSpacing; y < height; y += safeSpacing) {
			lines.push(`  <line x1="0" y1="${y}" x2="${width}" y2="${y}" stroke="${lineColor}" stroke-width="0.5"/>`);
		}
	}
	if (pattern === 'grid') {
		for (let x = safeSpacing; x < width; x += safeSpacing) {
			lines.push(`  <line x1="${x}" y1="0" x2="${x}" y2="${height}" stroke="${lineColor}" stroke-width="0.5"/>`);
		}
	}
	if (pattern === 'dots') {
		for (let y = safeSpacing; y < height; y += safeSpacing) {
			for (let x = safeSpacing; x < width; x += safeSpacing) {
				lines.push(`  <circle cx="${x}" cy="${y}" r="1" fill="${lineColor}"/>`);
			}
		}
	}

	return [
		`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}">`,
		`  <rect width="100%" height="100%" fill="${bgColor}"/>`,
		...lines,
		`  <desc class="hwm-background">${escapeXml(JSON.stringify(background))}</desc>`,
		`  <desc class="hwm-strokes">${escapeXml(strokesJson)}</desc>`,
		`  <desc class="hwm-text">${escapeXml(textsJson)}</desc>`,
		...paths,
		...textNodes,
		`</svg>`
	].join('\n');
}

// Estrae i tratti dal JSON nella <desc> dell'SVG
// Restituisce array vuoto se non trova dati validi
export function parseSvgStrokes(svgContent: string): Stroke[] {
	try {
		// Cerca il contenuto del tag <desc class="hwm-strokes">
		const match = svgContent.match(/<desc class="hwm-strokes">([\s\S]*?)<\/desc>/);
		if (!match) return [];

		const json = unescapeXml(match[1] ?? '');
		// JSON.parse ritorna unknown; validazione esplicita prima di usare i dati
		const parsed: unknown = JSON.parse(json);

		// Validazione base: deve essere un array di oggetti con points, color, width
		if (!Array.isArray(parsed)) return [];
		return (parsed as unknown[]).filter((s): s is Stroke =>
			s !== null && typeof s === 'object' &&
			Array.isArray((s as Stroke).points) &&
			typeof (s as Stroke).color === 'string' &&
			typeof (s as Stroke).width === 'number'
		);
	} catch {
		return [];
	}
}

export function parseSvgText(svgContent: string): TextElement[] {
	try {
		const match = svgContent.match(/<desc class="hwm-text">([\s\S]*?)<\/desc>/);
		if (!match) return [];
		const parsed: unknown = JSON.parse(unescapeXml(match[1] ?? ''));
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((item): item is TextElement =>
			item !== null && typeof item === 'object' && typeof (item as TextElement).id === 'string' &&
			typeof (item as TextElement).x === 'number' && typeof (item as TextElement).y === 'number' &&
			typeof (item as TextElement).text === 'string' && typeof (item as TextElement).color === 'string' &&
			typeof (item as TextElement).fontSize === 'number'
		);
	} catch { return []; }
}

export function parseSvgBackground(svgContent: string): SvgBackground {
	const fallback: SvgBackground = { color: '#ffffff', lineColor: '#e0e0e0', pattern: 'ruled', spacing: LINE_SPACING };
	try {
		const match = svgContent.match(/<desc class="hwm-background">([\s\S]*?)<\/desc>/);
		if (!match) return fallback;
		const data: unknown = JSON.parse(unescapeXml(match[1] ?? ''));
		if (data === null || typeof data !== 'object') return fallback;
		const raw = data as Partial<SvgBackground>;
		const pattern: BackgroundPattern = raw.pattern === 'grid' || raw.pattern === 'dots' || raw.pattern === 'blank' ? raw.pattern : 'ruled';
		return {
			color: typeof raw.color === 'string' ? raw.color : fallback.color,
			lineColor: typeof raw.lineColor === 'string' ? raw.lineColor : fallback.lineColor,
			pattern,
			spacing: typeof raw.spacing === 'number' ? Math.max(12, Math.min(120, raw.spacing)) : fallback.spacing,
		};
	} catch { return fallback; }
}

// Escape caratteri speciali XML per inserimento in <desc>
function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

// Ripristina i caratteri XML escapati
function unescapeXml(s: string): string {
	return s
		.replace(/&quot;/g, '"')
		.replace(/&gt;/g, '>')
		.replace(/&lt;/g, '<')
		.replace(/&amp;/g, '&');
}

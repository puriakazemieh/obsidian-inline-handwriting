# Inline Handwriting

Write, edit, and keep handwriting directly inside an Obsidian note.

Inline Handwriting adds a pen-first drawing canvas to ordinary Markdown files. Drawings are stored as editable SVG files in your vault and embedded with standard Obsidian links, so your notes remain portable even when the plugin is disabled.

## Features

- Insert a handwriting block at the current cursor position.
- Draw with a stylus, mouse, or trackpad in an inline editor.
- Use pen, highlighter, eraser, and text tools.
- Choose quick colours, pen size, background colour, paper pattern, and line spacing.
- Undo, redo, clear, autosave, and delete drawings.
- Collapse long drawings in a note and expand them again when needed.
- Insert references to existing handwriting SVG files.
- Works on desktop and mobile Obsidian.
- Keeps drawings locally in the vault; it has no OCR, API key, network request, analytics, or telemetry feature.

## Install

### From the Community plugins directory

After the plugin has been accepted, open **Settings → Community plugins**, search for **Inline Handwriting**, install it, and enable it.

### Manually from GitHub

1. Download the three assets from the latest GitHub release: `main.js`, `manifest.json`, and `styles.css`.
2. Create this folder in your vault:

   ```text
   <vault>/.obsidian/plugins/inline-handwriting-puria/
   ```

3. Copy the three downloaded files into that folder.
4. Reload Obsidian and enable **Inline Handwriting** under **Settings → Community plugins**.

## Use

1. Open a Markdown note.
2. Run **Insert handwriting block** from the Command Palette, or select the pencil icon in the left ribbon.
3. Select **Edit** on the inserted drawing, or double-click the drawing, to open the canvas.
4. Draw, then use **Save**. The drawing is stored as an SVG under `_inline_handwriting/` by default.

You can also run **Insert SVG reference** to embed an existing SVG from the configured drawing folder.

## Settings

The plugin lets you configure:

- Interface language
- SVG storage folder
- Default canvas width and height
- Canvas theme behaviour (automatic, light, or dark)
- Extra quick colours for the drawing toolbar

## Data and privacy

All drawing data stays in your Obsidian vault as SVG files. This plugin does not send drawings, note content, usage data, or identifiers to an external service. It does not include OCR, AI, analytics, or telemetry.

## Development

```powershell
npm ci
npm run build
npm run lint
```

The release assets are generated in that directory:

- `main.js`
- `manifest.json`
- `styles.css`

Create a GitHub release whose tag exactly matches the version in `manifest.json` (for example, `1.0.0`) and attach those three files. The included release workflow does this automatically when a matching version tag is pushed.

## License and attribution

Licensed under the [MIT License](./LICENSE).

This project is independently maintained by [Puria Kazemieh](https://github.com/puriakazemieh). It began from the MIT-licensed HandTranscriptMd project; the original copyright notice is retained in the license.

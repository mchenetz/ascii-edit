# Ascii Edit (React)

A React-based WYSIWYG editor for Asciinema recordings (`.cast`/`asciicast v2/v3`) with a video-editor style timeline.

## Features

- Load local `asciicast` files in both JSON-object and line-based (`.cast`) formats.
- Color terminal preview with ANSI SGR support:
  - standard + bright colors,
  - 256-color mode,
  - truecolor (`RGB`),
  - style attributes (`bold`, `italic`, `underline`, inverse, strike).
- Timeline editing:
  - split at playhead,
  - trim clip start/end,
  - drag clip body to reorder,
  - right-click clip actions (`cut`, `copy`, `paste before`, `paste after`, `delete`),
  - inspector edits for clip label/start/end.
- Undo edits (`Undo` button or `Cmd/Ctrl+Z`).
- Export edited result as `asciicast v2` JSON.
- Draggable and resizable floating panels:
  - preview panel,
  - timeline panel.

## Run

```bash
cd /Users/mchenetz/git/ascii-edit
npm install
npm run dev
```

Open the local Vite URL (typically `http://localhost:5173`).

## Layout controls

- Drag a panel by its header.
- Resize a panel from the bottom-right handle.
- Bring panel to front by clicking it.
- Use `Reset Layout` to restore default positions.

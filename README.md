# Cutir

A browser-based lyric-video editor with a local AI chat (Ollama). Load a song, lyrics and a background, sync the timings, style the text, preview in real time and export an MP4. Everything runs in the browser; there is no backend.

## Setup

```bash
npm i
npm run dev          # http://localhost:5173
```

### AI chat (Ollama)

```bash
ollama pull qwen3:8b
```

The browser must be allowed to call Ollama, so start it with `OLLAMA_ORIGINS` set.

**Windows (PowerShell)**
```powershell
setx OLLAMA_ORIGINS "*"
# then quit Ollama from the tray icon and start it again
```

**macOS**
```bash
launchctl setenv OLLAMA_ORIGINS "*"
# then quit and reopen the Ollama app
```

**Linux (systemd)**
```bash
sudo systemctl edit ollama.service
# add:
#   [Service]
#   Environment="OLLAMA_ORIGINS=*"
sudo systemctl daemon-reload && sudo systemctl restart ollama
```

Or, for one run from a terminal: `OLLAMA_ORIGINS=* ollama serve`.
Instead of `*` you can use just the dev URL, e.g. `http://localhost:5173`.

In the chat panel the status dot turns green when Ollama is reachable. Pick a model from the dropdown (the refresh button re-reads `/api/tags`).

### Auto-sync lyrics (optional Python helper)

Cutir can time your lyrics to the song automatically with [stable-ts](https://github.com/jianfch/stable-ts) (Whisper forced alignment). It runs locally; nothing is uploaded anywhere.

```bash
cd tools/aligner
pip install -r requirements.txt      # needs ffmpeg on PATH
python server.py                     # http://127.0.0.1:8765
```

Then in the left panel use **Auto-sync lyrics** under *Lyrics*. It gives every line (and every word) a start/end time; undo with Ctrl+Z.

- `[Verse]` / `[Chorus]` tag lines (Suno adds these) are skipped and removed.
- For produced songs (Suno, anything with a backing track) turn on **Separate vocals** (`pip install demucs`); alignment is far more accurate on the isolated voice. Use the `small` or `medium` model for better accuracy.
- Set the **Language** (`en`, `es`, `hi`, ... or `auto`).
- Env vars: `CUTIR_ALIGNER_PORT`, `CUTIR_ALIGNER_MODEL`, `CUTIR_ALIGNER_DEVICE`, and `CUTIR_ALIGNER_BACKEND=faster` to use faster-whisper (no PyTorch).
- The helper only accepts requests from pages on `localhost`.

## Using it

1. **Audio / background / lyrics** in the left panel (or import `.lrc` / `.srt`).
2. **Timeline:** drag blocks to move them, drag edges to resize (snaps to 0.05s). `Tap to sync` plays the song: press **Space** at the start of each line and **Enter** at the end of the current one. Mouse wheel scrolls sideways, **Ctrl+wheel** zooms, **Fit** shows the whole song, and you can drag the top edge of the timeline to make it taller.
   - **Layers:** each lane is a layer (up to 8), drawn bottom to top, with its own text. Click **+ Layer** to add one (for example a translation under the lyrics). Per layer you can rename it (double-click the name), hide it (eye), lock it, and set its position, size and colour or reorder it (⋯). Double-click empty space in a lane to add text, double-click a block to edit it, and drag a block up or down to move it to another layer. **Right-click** a block for Edit, Duplicate, Copy, Split at playhead, Set start/end to playhead, Play from here, Loop, Move to layer and Delete; right-click empty lane space for Add text here / at playhead and Paste. Shortcuts: Ctrl+D duplicate, Ctrl+C / Ctrl+V copy and paste (pastes at the playhead), Delete. The Lyrics box, Tap to sync and new lines act on the layer you last clicked; auto-sync times the first layer only. `.srt` merges visible layers and `.ass` gives each layer its own style.
3. **Chat:** describe edits in plain English ("shift lines 4 to 8 by 0.5s", "use a pink-to-orange gradient", "delete line 2"). Each reply that changes something shows an *Applied changes* card with an Undo button. You can attach images (vision models only) or `.txt` / `.lrc` / `.srt` files.
4. **Export:** the `Export` button renders MP4 (H.264 + the original audio) at 1920x1080, 1080x1920 or 1080x1080, and can also save `.srt` and `.ass` (karaoke).

### Shortcuts

| Key | Action |
| --- | --- |
| Space | play / pause (tap a line start in sync mode) |
| Enter | set end of the current line (sync mode) |
| Esc | leave sync mode |
| Ctrl+Z / Ctrl+Shift+Z | undo / redo |
| Left / Right | nudge the selected line by 0.05s |

## Notes

- **Export runs in your browser.** It uses the browser's built-in H.264/AAC encoders (WebCodecs, hardware accelerated where available) through [Mediabunny](https://mediabunny.dev): a 2-minute 1080p30 song exports in seconds. If the browser cannot encode H.264 at the chosen size, Cutir automatically falls back to ffmpeg.wasm (single-threaded, roughly 15x slower) and the export dialog says "compatibility mode". Use a recent Chrome or Edge for the fast path.
- The dev server sends COOP/COEP headers (see `vite.config.ts`). If you host a production build, send the same headers.
- Projects autosave to localStorage and can be saved/opened as JSON. Audio and background files are not stored in the JSON; re-upload them after reopening a project.
- Chats are kept in memory only.

## Layout

```
src/
  components/   LeftPanel, Preview, Timeline, ChatPanel, ExportDialog, Thinking
  lib/          renderer.ts  (shared draw function), transport.ts, ollama.ts,
                tools.ts, exporter.ts, subtitles.ts
  store/        project.ts (state + undo/redo), chat.ts
```

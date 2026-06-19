# Xpeaker

Read **X / Twitter** posts aloud with a 🔊 button on every post — speech is produced by Chrome's
built-in `chrome.tts` engine, routed to the **Supertonic Text-to-Speech Voices** companion extension
that runs neural TTS **in your browser**. No host server, no Python, no ONNX model to install.

Ported from the [`tweet-reader-supertonic`](../tweet-reader-supertonic) userscript; the local
`supertonic serve` dependency is gone.

## Install

1. Install the **[Supertonic Text-to-Speech Voices](https://chromewebstore.google.com/detail/supertonic-text-to-speech/mdoplmghlkjcnegkdhocjbjcncocbdhk)**
   extension from the Chrome Web Store (this is the engine that actually speaks). The same
   mechanism Read Aloud uses.
2. Load Xpeaker:
   - `chrome://extensions` → enable **Developer mode** → **Load unpacked** → select this `xpeaker/` folder.
3. Open `x.com`. Each post gets a 🔊 button in its action bar; a floating player bar sits bottom-right.

## Use

- **Single mode** (default): click 🔊 on a post → it's read aloud; click again to stop.
- **Thread mode**: switch via the bar's mode button (or `Alt+T`) → click a post → reads from there onward,
  auto-scrolling and de-duping by tweet id. Skip/prev/pause from the bar.
- **Floating bar**: voices-status dot, mode, direction, pause, prev/next, stop, speed chip, ⚙ settings.
- **Popup** (toolbar icon): quick mode / direction / speed / stop + status.
- **Options** (⚙ or right-click → Xpeaker: Settings): default voice, speed, per-author voices,
  auto-voice-per-author, announce author, alt-text, pause-on-video, browser-voice fallback.

### Keyboard
`Alt+R` read under cursor · `Alt+T` thread from there · `Alt+S` stop · `Alt+N`/`Alt+B` next/back ·
`Alt+Space` pause · `Alt+↑`/`Alt+↓` speed.

## Architecture

```
 x.com page (content.js)            extension service worker            companion ext
 ┌───────────────────────┐  Port   ┌────────────────────────┐  tts   ┌──────────────┐
 │ buttons, bar, thread   │ ──────▶ │ chrome.tts.speak(...)  │ ─────▶ │ Supertonic   │
 │ walk, text extraction  │ ◀────── │ relays tts events back │        │ voices (WASM)│
 └───────────────────────┘ events  └────────────────────────┘        └──────────────┘
```

`chrome.tts` isn't callable from content scripts, so the content script speaks via a long-lived
`chrome.runtime` Port to the service worker, which owns `chrome.tts` and relays `start`/`word`/`end`/
`error`/`interrupted` events. The `speak()` promise resolves `ended`/`error`/`stopped` — a drop-in for
the userscript's old `playArrayBuffer`.

## Files
- `manifest.json` — MV3 contract (permissions: `tts`, `storage`, `contextMenus`; content script on x/twitter).
- `background/service-worker.js` — chrome.tts owner, port bridge, context menus.
- `content/content.js` + `content.css` — all on-page UI/logic (buttons, bar, thread reader, extraction, keyboard, auto-duck).
- `options/` — full settings page. `popup/` — quick controls. `icons/` — toolbar/store icons.

## On-device AI (v1.1) — optional, no server

Enable in **Settings → On-device AI**. Speech text can be run through a small **Gemma** model that runs
**entirely in your browser** via [transformers.js](https://github.com/huggingface/transformers.js) (WebGPU,
with a WASM fallback) — no LM Studio, no server. It powers:

- **Cleanup** — expand slang/acronyms, describe emoji before reading.
- **Translate** — non-English posts → English.
- **Summary mode** — a 3rd bar mode: digest a thread, then read the digest aloud.

The model (default `onnx-community/Qwen2.5-0.5B-Instruct` (Gemma 3 currently fails to load in transformers.js — issue #1239)) downloads once
from Hugging Face and is cached;
after that it's offline. First run is slow. WebGPU is much faster but isn't everywhere — Xpeaker falls
back to WASM.

Inference can't run in the service worker (no WebGPU there), so it runs in an **offscreen document**
(`offscreen/`): content → SW (orchestrator) → offscreen (transformers.js) → back.

**Word highlighting** (Settings → Word highlighting): a karaoke **caption overlay** that tracks the
spoken word, plus best-effort in-post highlighting (CSS Custom Highlight API) when the spoken text
matches the tweet. Needs the voice engine to emit `word` events; degrades to a plain caption otherwise.

## Building from source

The on-device AI bundles transformers.js, so there's a build step (the rest of the extension is plain JS):

```bash
npm install
node copy-wasm.mjs     # copy onnxruntime WASM into wasm/
node build.mjs         # bundle offscreen/offscreen.js → offscreen/offscreen.bundle.js
```

The committed `offscreen/offscreen.bundle.js` and `wasm/` let you load-unpacked directly without building.

## Not in v1.1 (still cut from the userscript)
Export-thread-to-WAV and the hover-prefetch *audio* cache — both need raw audio buffers that `chrome.tts`
doesn't expose. (Would require bundling Supertonic in-browser instead of using the companion engine.)

## Note on voice detection
Xpeaker treats voices whose name/engine mentions "Supertonic" (or, failing that, any extension-provided
`ttsEngine` voice) as the Supertonic set. After loading, open the service-worker console
(`chrome://extensions` → Xpeaker → *service worker* → inspect) and run
`chrome.tts.getVoices(v => console.log(v))` to confirm the real `voiceName`/`extensionId` strings. If the
companion advertises differently, tighten the filter in `content/content.js` (`pickEngineVoices`),
`options/options.js`, and `popup/popup.js`.

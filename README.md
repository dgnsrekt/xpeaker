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
Two styles (Settings → Keyboard shortcuts), all `Alt` + key:
- **Default:** `Alt+R` read · `Alt+T` thread · `Alt+S` stop · `Alt+N`/`Alt+B` next/back · `Alt+Space` pause · `Alt+↑`/`Alt+↓` speed.
- **Vim-ish:** `Alt+P` read · `Alt+J`/`Alt+K` down/up · `Alt+T` thread · `Alt+Space` pause · `Alt+S` stop · `Alt+H`/`Alt+L` slower/faster.

The bar's **‹ button** expands it to show the active shortcuts (and collapses back).

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

**Word highlighting** (Settings → Word highlighting): a karaoke **caption overlay** that tracks the
spoken word, plus best-effort in-post highlighting (CSS Custom Highlight API) when the spoken text
matches the tweet. Needs the voice engine to emit `word` events; degrades to a plain caption otherwise.

**Single global reader:** `chrome.tts` is global to the browser, so starting a read in any tab
automatically stops a read running in another — no overlapping/echoing audio.

## On-device AI — removed for now

An earlier build ran a small in-browser LLM (transformers.js) for cleanup / translate / a thread-summary
mode. It was removed: the only model small enough to load reliably in the WASM runtime (Qwen-0.5B) produced
gibberish, and anything larger (Qwen-1.5B, Gemma) either OOM-aborts or isn't supported by transformers.js
yet. The code lives in git history; the revisit is tracked in
[#2](https://github.com/dgnsrekt/xpeaker/issues/2) (in-browser Supertonic + Web Audio FX) and
[#1](https://github.com/dgnsrekt/xpeaker/issues/1) (raw-ORT QAT engine).

## Not included
Thread summary, AI text cleanup/translate, export-thread-to-WAV, and the hover-prefetch *audio* cache —
the last two need raw audio buffers that `chrome.tts` doesn't expose (would require bundling Supertonic
in-browser instead of using the companion engine).

## Note on voice detection
Xpeaker treats voices whose name/engine mentions "Supertonic" (or, failing that, any extension-provided
`ttsEngine` voice) as the Supertonic set. After loading, open the service-worker console
(`chrome://extensions` → Xpeaker → *service worker* → inspect) and run
`chrome.tts.getVoices(v => console.log(v))` to confirm the real `voiceName`/`extensionId` strings. If the
companion advertises differently, tighten the filter in `content/content.js` (`pickEngineVoices`),
`options/options.js`, and `popup/popup.js`.

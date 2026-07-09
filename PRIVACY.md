# Xpeaker — Privacy Policy

_Last updated: 2026-07-09_

**Xpeaker does not collect, store, transmit, or sell any personal information.** It runs
entirely on your device.

- **No analytics, tracking, advertising, or account — and none of your data leaves your device.**
  The only network request Xpeaker makes is optional: if you enable the **Mood ring** (Settings),
  it downloads a small emotion-classification model **once** from HuggingFace (`huggingface.co`)
  and caches it. Classification then runs entirely on your device — the text of your posts is
  **never** sent to HuggingFace or anywhere else. If you don't enable the mood ring, Xpeaker makes
  no network requests of its own.
- **Settings stay local.** Your preferences (voice, speed, per-author voices, keymap, etc.)
  are saved in your browser via `chrome.storage.local` and never leave your device.
- **Post text is used only on your device.** The text of a post you choose to read is taken from
  the page and handed to your browser's built-in text-to-speech engine (`chrome.tts`) — and, if
  installed, the separate **Supertonic Text-to-Speech Voices** extension — solely to generate
  audio on your device; if you enable the mood ring, it is also classified for emotion on your
  device. It is not logged, stored, or transmitted by Xpeaker.
- **The background shaders read only what's already on the page (or that X itself loads).** To pick a
  bull/bear tint, the ticker overlay hovers a post's `$cashtag` to make X show its own price-card
  popover, then reads the name, % change, and logo from it — all in your browser; author signature
  shaders read the post's author. Xpeaker transmits none of this. (The hover may prompt X — not
  Xpeaker — to fetch that card from X's own servers, exactly as it would if you moused over the
  cashtag yourself.)
- **Permissions** are used only to provide the feature:
  - `tts` — speak the text aloud.
  - `storage` — save your settings locally.
  - `contextMenus` — add Xpeaker entries to the right-click menu on X/Twitter.
  - `offscreen` — run the on-device emotion classifier (mood ring) in a hidden document.
  - Access to `huggingface.co` — download the mood-ring model once, only if you enable it.
  - Content script on `x.com` / `twitter.com` — show the read-aloud buttons and player bar.

If you install the optional **Supertonic Text-to-Speech Voices** companion extension, its own
privacy policy governs how it handles audio synthesis; Xpeaker only requests speech from it
locally via the browser's TTS API.

**Not affiliated with X Corp or Twitter, Inc.** "X" and "Twitter" are referenced only to
describe the website Xpeaker works on.

Questions or concerns: open an issue at <https://github.com/dgnsrekt/xpeaker/issues>.

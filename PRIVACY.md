# Xpeaker — Privacy Policy

_Last updated: 2026-06-20_

**Xpeaker does not collect, store, transmit, or sell any personal information.** It runs
entirely on your device.

- **No servers, no network requests.** Xpeaker contacts no servers and makes no network
  requests of its own. There is no analytics, no tracking, no advertising, and no account.
- **Settings stay local.** Your preferences (voice, speed, per-author voices, keymap, etc.)
  are saved in your browser via `chrome.storage.local` and never leave your device.
- **Post text is used only to speak it.** The text of a post you choose to read is taken from
  the page and handed to your browser's built-in text-to-speech engine (`chrome.tts`) — and,
  if installed, the separate **Supertonic Text-to-Speech Voices** extension — solely to
  generate audio on your device. It is not logged, stored, or transmitted by Xpeaker.
- **Permissions** are used only to provide the feature:
  - `tts` — speak the text aloud.
  - `storage` — save your settings locally.
  - `contextMenus` — add Xpeaker entries to the right-click menu on X/Twitter.
  - Content script on `x.com` / `twitter.com` — show the read-aloud buttons and player bar.

If you install the optional **Supertonic Text-to-Speech Voices** companion extension, its own
privacy policy governs how it handles audio synthesis; Xpeaker only requests speech from it
locally via the browser's TTS API.

**Not affiliated with X Corp or Twitter, Inc.** "X" and "Twitter" are referenced only to
describe the website Xpeaker works on.

Questions or concerns: open an issue at <https://github.com/dgnsrekt/xpeaker/issues>.

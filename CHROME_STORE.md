# Chrome Web Store submission — Xpeaker

Reference copy + checklist for publishing / updating the listing. Xpeaker is MV3, uses **no
remote code**, collects **no user data**, and makes **no network request of its own** except one
optional, one-time model download (the opt-in mood ring) — which keeps it clear of the top
rejection reasons. The work is mostly keeping the store listing + privacy fields accurate.

> **Status: LIVE 🎉** — published in the Chrome Web Store as
> [**Xpeaker**](https://chromewebstore.google.com/detail/xpeaker/kmglffjlieflbckmhmmbdbgfpboncmij)
> (item ID `kmglffjlieflbckmhmmbdbgfpboncmij`, account run2devtest@gmail.com). First shipped
> v1.3.1 (2026-06-20); current manifest is **v1.9.0** (Focus Mode, on-device mood ring, GLSL
> background shaders + ticker shader modes). To ship an update: bump the manifest version →
> re-zip → Package → "Upload new package" → Submit. Listing assets + screenshot generators live
> in [`store/`](store/).

## Listing copy

**Name:** `Xpeaker`

**Short description** (manifest `description`, ≤132 chars — keep in sync with `manifest.json`):
> Read X/Twitter posts aloud — neural Supertonic or browser voices. Full-screen Focus Mode, thread reader, per-author voices.

**Category:** Accessibility (or Productivity)

**Full description** (paste into the dashboard):
> Xpeaker reads X / Twitter posts aloud, right in your timeline. Click the 🔊 on any post, or use
> the keyboard.
>
> READING
> • Single or continuous "thread" reading that auto-scrolls and reads from a post onward
> • Per-author voices (or auto-assign a distinct voice per author)
> • Karaoke word-highlight caption as it reads
> • Reads full "Show more" posts; skips promoted/ad posts in thread mode
> • Auto-pauses when you play a video, resumes after
> • Keyboard shortcuts — Default or Vim-ish (hold Alt: J/K to move, etc.)
>
> FOCUS MODE
> • A full-screen, distraction-free reader — one post at a time over a live animated background
> • Like / reply without leaving; edge arrows to move; Alt+Space to pause
> • A HUD pill shows the post's mood, a live price ticker for any $cashtag, and the background name
> • Several GLSL background scenes; click the scene name to cycle them
> • Optional on-device "mood ring" tints the background to each post's emotion (opt-in)
> • Ticker shader modes: mention a $cashtag and the background reacts to its price move (bull/bear)
>
> Private by design: everything runs on your device. No account, no servers, no analytics, no
> tracking. Your posts never leave your machine. The only network request Xpeaker ever makes is
> the optional, one-time mood-ring model download (only if you turn the mood ring on).
>
> Voices: for high-quality neural voices, install the free "Supertonic Text-to-Speech Voices"
> extension. Without it, Xpeaker uses your browser's built-in voices.
>
> Open source: https://github.com/dgnsrekt/xpeaker
>
> Not affiliated with X Corp or Twitter, Inc.

## Privacy tab (dashboard)

- **Single purpose:** "Reads X (Twitter) posts aloud, with an optional full-screen Focus reader."
- **Privacy policy URL:** `https://dgnsrekt.github.io/xpeaker/privacy.html` (served via GitHub Pages from `/docs`)
- **Permission justifications** (must cover every entry in `manifest.json`):
  - `tts` — "Speaks the text of posts aloud (the extension's core function)."
  - `storage` — "Saves the user's settings (voice, speed, etc.) locally; nothing is transmitted."
  - `contextMenus` — "Adds Xpeaker actions (settings, read from top, focus, stop) to the right-click menu on X/Twitter."
  - `offscreen` — "Runs the optional on-device emotion classifier (the 'mood ring') in a hidden document; WASM needs a DOM context. No text leaves the device."
  - Host access `https://huggingface.co/*` (and `*.huggingface.co`, `*.hf.co`, `cas-bridge.xethub.hf.co`) — "Downloads the mood-ring emotion model **once** and caches it locally, only if the user enables the mood ring. The text of posts is classified on-device and is never sent to HuggingFace."
  - Host access `https://x.com/*`, `https://twitter.com/*` — "Content script injects the read-aloud buttons, player bar, and Focus overlay into the X/Twitter timeline."
- **Remote code:** No. (The mood-ring download is model *data*, not executable code; WASM runtime ships in the package.)
- **Data collection:** None — check "I do not collect or use user data." No user data is transmitted; the model download sends no post content.
- **Limited Use certification:** Confirm compliance (no user data handled or transferred).

## Assets to produce (you)

- ✅ Icon 128×128 — `icons/icon128.png`.
- ✅ **5 screenshots, 1280×800** — [`store/screenshots/`](store/screenshots): `01-focus` (Focus-Mode hero over Aurora), `02-ticker` (DOODLE ticker mode stamping the $TSLA logo), `03-read` (timeline + dock in thread mode), `04-settings` (Options page), `05-mood` (mood ring: HUD pill reads `MOOD: ANGER` over an emotion-coloured Aurora). Captured live for v1.9.0.
- ✅ Small promo tile 440×280 — `store/promo-tile.png` (regenerate via `store/render.sh`).
- ✅ Landscape demo GIF — `store/demo.gif` (Focus-Mode reel: scene cycling with the live $TSLA bear-mode ticker; replaced the stale portrait one).

> Store screenshots are 256-colour (captured through the extension's GIF export channel), so smooth
> shader gradients show mild banding. Good enough for the listing; for pixel-perfect PNGs, re-grab the
> staged frames with macOS ⌘⇧4.

## Pre-submission checklist

Must-have (or it gets rejected):
- [x] Manifest V3, no remote code, narrow content-script match
- [x] `offscreen` + HuggingFace `host_permissions` each have a justification (added v1.9.0)
- [x] Works standalone (browser voices) — `fallbackToNative` defaults on
- [x] Privacy policy page live + URL in dashboard; reflects the mood-ring model download
- [x] Data-collection form = none; the "only network request" nuance matches PRIVACY.md
- [x] Accurate, non-spammy description; name doesn't claim to be "X"/"Twitter"
- [x] $5 developer account registered + verified
- [ ] Upload the 5 **current** v1.9.0 screenshots (staged in `store/screenshots/`) + promo tile to the dashboard
- [x] Tested on x.com and twitter.com with the extension installed alone

Nice-to-have:
- [x] `homepage_url` in manifest; open-source repo link
- [x] "Not affiliated with X Corp" disclaimer (listing + privacy policy)
- [x] Supertonic companion extension named in the description
- [ ] Promo tile 440×280 uploaded

## Notes / risks
- **"No network" is no longer true** — the opt-in mood ring downloads a model from HuggingFace.
  The listing/privacy copy now says so plainly ("the *only* network request is the optional,
  one-time mood-model download"). Leaving the old "no network requests" claim would be a
  rejection/compliance risk, so it has been removed everywhere.
- **Trademark:** Name "Xpeaker" + descriptive "X/Twitter" references are fine. The icon's X is a
  generic soundwave-X, not the X Corp logo — low risk; the "not affiliated" disclaimer is included.
- **Companion dependency:** mitigated by the native-voice fallback (works alone) + disclosed in the
  description. Reviewers test in isolation, so this matters.
- **Zip for upload:** `git archive` the tag, or zip the repo excluding `.git` and `*.md` — but
  **keep `docs/welcome.html` and any images it references** (the first-run onboarding page is
  opened via `chrome.runtime.getURL` and must be in the package).

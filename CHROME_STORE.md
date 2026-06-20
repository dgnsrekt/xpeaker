# Chrome Web Store submission — Xpeaker

Reference copy + checklist for publishing. Xpeaker is already MV3, has **no remote code**, no
network requests, no data collection, and minimal permissions — which sidesteps the top
rejection reasons. The work is mostly the store listing + privacy fields.

## Listing copy

**Name:** `Xpeaker`

**Short description** (manifest `description`, ≤132 chars — already set):
> Read X/Twitter posts aloud — neural Supertonic voices or your browser's. Thread reader, per-author voices, word highlighting.

**Category:** Accessibility (or Productivity)

**Full description** (paste into the dashboard):
> Xpeaker reads X / Twitter posts aloud, right in your timeline. Click the 🔊 on any post, or
> use the keyboard.
>
> • Single or continuous "thread" reading that auto-scrolls and reads from a post onward
> • Per-author voices (or auto-assign a distinct voice per author)
> • Karaoke word-highlight caption as it reads
> • Reads full "Show more" posts; skips promoted/ad posts in thread mode
> • Auto-pauses when you play a video, resumes after
> • Keyboard shortcuts — Default or Vim-ish (hold Alt: J/K to move, etc.)
> • Compact or expanded player bar
>
> Private by design: everything runs on your device. No account, no servers, no tracking.
>
> Voices: for high-quality neural voices, install the free "Supertonic Text-to-Speech Voices"
> extension. Without it, Xpeaker uses your browser's built-in voices.
>
> Open source: https://github.com/dgnsrekt/xpeaker
>
> Not affiliated with X Corp or Twitter, Inc.

## Privacy tab (dashboard)

- **Single purpose:** "Reads X (Twitter) posts aloud using the browser's text-to-speech."
- **Privacy policy URL:** `https://dgnsrekt.github.io/xpeaker/privacy.html` (enable GitHub Pages from `/docs`)
- **Permission justifications:**
  - `tts` — "Speaks the text of posts aloud (the extension's core function)."
  - `storage` — "Saves the user's settings (voice, speed, etc.) locally; nothing is transmitted."
  - `contextMenus` — "Adds Xpeaker actions (settings, read from top, stop) to the right-click menu on X/Twitter."
  - Host access `https://x.com/*`, `https://twitter.com/*` — "Content script injects the read-aloud buttons and player bar into the X/Twitter timeline."
- **Remote code:** No.
- **Data collection:** None — check "I do not collect or use user data" (or the equivalent: no categories selected).
- **Limited Use certification:** Confirm compliance (no data handled).

## Assets to produce (you)

- ✅ Icon 128×128 — `icons/icon128.png` (already in repo).
- ⬜ **1–5 screenshots, 1280×800** (or 640×400). Suggested shots:
  1. A post with the 🔊 button + the player bar reading (caption visible).
  2. The options page (voices, per-author, keyboard styles).
  3. The expanded bar showing shortcuts.
  Use a normal-looking timeline; avoid sensitive content. Pad to exact dimensions.
- ⬜ (optional) Small promo tile 440×280.

## Pre-submission checklist

Must-have (or it gets rejected):
- [x] Manifest V3, no remote code, minimal permissions, no `host_permissions`, narrow content-script match
- [x] Works standalone (browser voices) — `fallbackToNative` defaults on
- [x] Privacy policy page (host via GitHub Pages → fill URL in dashboard)
- [x] Accurate, non-spammy description; name doesn't claim to be "X"/"Twitter"
- [ ] $5 developer account registered + verified
- [ ] ≥1 screenshot uploaded
- [ ] Permission justifications + data-collection form filled (copy above)
- [ ] Tested on x.com and twitter.com with the extension installed alone

Nice-to-have:
- [x] `homepage_url` in manifest; open-source repo link
- [x] "Not affiliated with X Corp" disclaimer (listing + privacy policy)
- [ ] Link to the Supertonic companion extension in the description
- [ ] Submit as draft ("Publish automatically" unchecked) to review before going live

## Notes / risks
- **Trademark:** Name "Xpeaker" + descriptive "X/Twitter" references are fine. The icon's X is a
  generic soundwave-X, not the X Corp logo — low risk, but if a reviewer objects, a non-X glyph is
  the easy fallback. The "not affiliated" disclaimer is included to be safe.
- **Companion dependency:** mitigated by the native-voice fallback (works alone) + clearly disclosed
  in the description. Reviewers test in isolation, so this matters.
- **Zip for upload:** `git archive` the tag, or zip the repo excluding `.git`, `docs/`, `*.md`.

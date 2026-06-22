# Xpeaker demo — recording kit

The recursive promo: post the thread below on X (attach the matching card image to each tweet),
then screen-record Xpeaker reading it in **thread mode**. Hand the footage back and I'll cut the
README + social clips.

## 1. The promo thread (post on X, one card image per tweet)

| # | Image | Tweet |
|---|-------|-------|
| 1 | `store/cards/card-01.png` | 🔊 You're hearing this thread read aloud — by **Xpeaker**, a free Chrome extension that reads X out loud. No copy-paste, no app-switching. Here's what it does 🧵 |
| 2 | `store/cards/card-02.png` | Tap the speaker on any post and it speaks in a natural neural voice. Or hit play once and walk away — **thread mode** reads post after post and auto-scrolls. (That's how you're hearing this.) |
| 3 | `store/cards/card-03.png` | Give every account its **own voice** — auto-assigned or hand-picked. Your timeline sounds like a cast, not a monotone. |
| 4 | `store/cards/card-04.png` | Follow along with **karaoke captions** — the current word highlights as it's read. Great for noisy rooms and accessibility. |
| 5 | `store/cards/card-05.png` | Power users: **vim-ish keyboard shortcuts**. Hold Alt — J/K to move, P to read, T for thread mode. Hands stay on the keys. |
| 6 | `store/cards/card-06.png` | It reads what you'd miss too: expands "Show more" posts in full, **skips promoted ads**, and reads image alt-text. |
| 7 | `store/cards/card-07.png` | **Private by design** — everything runs on your device. No account, no servers, no tracking. Free and open source. |
| 8 | `store/cards/card-08.png` | Add Xpeaker to Chrome 👇  chromewebstore.google.com (search "Xpeaker")  ·  ⭐ github.com/dgnsrekt/xpeaker |

## 2. OBS settings (on your recording machine)
- **Output:** 1920×1080 (or 2560×1440), **60 fps**, MKV or MP4, high bitrate (CBR ~30–50 Mbps or near-lossless — we compress in post).
- **Video source:** *Window Capture* → the Chrome window (keeps the shot clean; cursor shows).
- **Audio:** *Application Audio Capture* → **Google Chrome** (OBS 30+ on macOS 13+ — grabs the TTS audio straight from Chrome, no BlackHole needed). Mute the mic.
- Full-screen the browser, hide bookmarks/other tabs, neutral timeline.

## 3. Shot list (record these — extra takes welcome)
**A) Hook — the recursive read (the money shot):**
1. Open your posted thread on `x.com`.
2. Put Xpeaker in **Thread mode** (bar mode button, or Alt+T) and click ▶ on tweet 1.
3. Let it read and auto-scroll through tweets 1–4 — keep the **caption overlay** and the per-post
   button states visible. (~25–35s)

**B) B-roll (short, isolated clips):**
- **Single read:** click the 🔊 on one post → it reads with the caption.
- **Options page:** open Settings → voices, per-author voices, keyboard styles, word-highlighting.
- **Expanded bar:** click the ‹ to expand → show the shortcut chips.
- **Keyboard:** a couple of Alt+J / Alt+P reads.

Tips: move the mouse slowly; rest ~1s on each element; 2–3 takes per beat.

## 4. Hand off
Drop the recording(s) into `~/Development/` (or tell me the path). I'll tighten pacing
(auto-editor), normalize audio (ffmpeg `loudnorm`), add zoom-to-action + a title/CTA card,
caption it (faster-whisper), and export a **silent looping README clip** (gifski GIF + MP4) and a
**captioned social clip**.

> Cards are generated from `store/cards/card.html` (one template, `?i=1..8`). To re-render, see
> the loop in `store/cards/render.sh`.

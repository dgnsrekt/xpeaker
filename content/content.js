// Xpeaker — content script (x.com / twitter.com)
// Ported from the tweet-reader-supertonic userscript. DOM work + UI live here; all speech
// goes through the service-worker "speak bridge" (chrome.tts isn't available in content
// scripts). v1: single + thread modes, dynamic Supertonic voices, no host server.

(function () {
  'use strict';

  // Guard against a second instance in the same page (e.g. an orphaned content
  // script left over after reloading the unpacked extension) → prevents double audio.
  if (window.__XPEAKER_LOADED__) { console.log('[Xpeaker] already loaded in this page — skipping duplicate'); return; }
  window.__XPEAKER_LOADED__ = true;

  // Shared constants/helpers — see shared.js (loaded first in the content_scripts list).
  const { SPEED_PRESETS, MODES, KEYMAPS, DEFAULTS, pickEngineVoices } = XP;
  const SUPERTONIC_INSTALL_URL = XP.SUPERTONIC_URL;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Dynamic voice state (filled from chrome.tts.getVoices via the bridge)
  let VOICES = [];               // array of voiceName strings (engine/Supertonic voices), sorted
  let supertonicAvailable = false;
  let installToastShown = false;

  // --------------------------------------------------------------------------
  // Settings (chrome.storage.local)
  // --------------------------------------------------------------------------
  let settings = Object.assign({}, DEFAULTS);

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('settings', (res) => {
        settings = XP.mergeSettings(res && res.settings);
        resolve(settings);
      });
    });
  }
  // When the unpacked extension is reloaded/updated, THIS already-injected content
  // script is orphaned: chrome.runtime.id goes undefined and every chrome.* call
  // throws "Extension context invalidated". Detect it, stop cleanly, and hint a
  // refresh ONCE — rather than spamming the console on every settings write / speak.
  let orphaned = false;
  function contextValid() {
    try { return !!(chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }
  function markOrphaned() {
    if (orphaned) return true;
    orphaned = true;
    try { softStop(); } catch (e) {}
    port = null;
    const d = barEl && barEl.querySelector('.xpeaker-dot.tts');
    if (d) { d.dataset.s = 'down'; d.title = 'Xpeaker was updated — refresh this tab to reconnect'; }
    console.log('[Xpeaker] extension reloaded — this tab is disconnected. Refresh to reconnect.');
    return true;
  }
  function saveSettings() {
    if (orphaned || !contextValid()) { markOrphaned(); return; }
    try { chrome.storage.local.set({ settings }); } catch (e) { markOrphaned(); }
  }
  // React to changes made by the popup / options page.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const prev = XP.mergeSettings(changes.settings.oldValue);
    settings = XP.mergeSettings(changes.settings.newValue);
    updateBarControls(); applyModeToButtons();
    // live-swap the Focus background scene if it changed while Focus is open
    if (focusEl && settings.focusScene !== prev.focusScene) {
      if (focusScene) focusScene.destroy();
      focusScene = makeFocusScene(focusEl.querySelector('.xpeaker-focus-bg'));
      if (focusScene) focusScene.setMood(focusLastMood); // carry the current mood into the new scene
    }
    // NOTE: Focus Mode is intentionally NOT toggled here. It is per-tab, in-memory state
    // (see toggleFocus) — driving it from a persisted setting made every open x.com tab
    // enter/exit together (dual overlay + dual TTS) and re-mount after a refresh.
  });

  function rate() { return clamp(settings.speed, 0.1, 10); }

  // --------------------------------------------------------------------------
  // Speak bridge (client side) — replaces the old fetch + AudioContext pipeline
  // --------------------------------------------------------------------------
  let port = null, seq = 0;
  const waiters = new Map();       // reqId -> { resolve, onStart, onWord }
  const voiceWaiters = new Map();  // reqId -> resolve

  function connectBridge() {
    try { port = chrome.runtime.connect({ name: 'xpeaker' }); }
    catch (e) { markOrphaned(); return; }
    port.onMessage.addListener((m) => {
      if (!m) return;
      if (m.t === 'voices') {
        const r = voiceWaiters.get(m.reqId);
        if (r) { voiceWaiters.delete(m.reqId); r(m.voices || []); }
        return;
      }
      if (m.t === 'yield') { softStop(); return; } // another tab took over reading
      if (m.t === 'tts') {
        const w = waiters.get(m.reqId);
        if (!w) return;
        if (m.ev === 'start') { if (w.onStart) w.onStart(); return; }
        if (m.ev === 'word') { if (w.onWord) w.onWord(m); return; }
        if (m.ev === 'end' || m.ev === 'error' || m.ev === 'interrupted' || m.ev === 'cancelled') {
          waiters.delete(m.reqId);
          w.resolve(m.ev === 'end' ? 'ended' : m.ev === 'error' ? 'error' : 'stopped');
        }
      }
    });
    port.onDisconnect.addListener(() => {
      // Service worker recycled — reconnect lazily; resolve any pending speaks as stopped.
      for (const [id, w] of waiters) w.resolve('stopped');
      waiters.clear();
      port = null;
      if (!contextValid()) markOrphaned(); // extension itself is gone → stop reconnecting
    });
  }
  function ensurePort() {
    if (orphaned || !contextValid()) { markOrphaned(); return null; }
    if (!port) connectBridge();
    return port;
  }

  // Drop-in replacement for the old playArrayBuffer(buf): resolves 'ended'|'error'|'stopped'.
  function speakBridge(text, voiceName, speakRate, cbs) {
    const reqId = ++seq;
    return new Promise((resolve) => {
      waiters.set(reqId, { resolve, onStart: cbs && cbs.onStart, onWord: cbs && cbs.onWord });
      try { ensurePort().postMessage({ t: 'speak', reqId, text, voiceName, rate: speakRate }); }
      catch (e) { waiters.delete(reqId); resolve('error'); }
    });
  }
  function ttsStop() { try { ensurePort().postMessage({ t: 'stop' }); } catch (e) {} }
  function claimReader() { try { ensurePort().postMessage({ t: 'claim' }); } catch (e) {} } // make other tabs stop
  function ttsPause() { try { ensurePort().postMessage({ t: 'pause' }); } catch (e) {} }
  function ttsResume() { try { ensurePort().postMessage({ t: 'resume' }); } catch (e) {} }
  function getVoicesBridge() {
    const reqId = ++seq;
    return new Promise((resolve) => {
      voiceWaiters.set(reqId, resolve);
      try { ensurePort().postMessage({ t: 'getVoices', reqId }); }
      catch (e) { voiceWaiters.delete(reqId); resolve([]); }
      setTimeout(() => { if (voiceWaiters.has(reqId)) { voiceWaiters.delete(reqId); resolve([]); } }, 5000);
    });
  }
  async function refreshVoices() {
    const all = await getVoicesBridge();
    const engine = pickEngineVoices(all);
    VOICES = engine.map((v) => v.voiceName).filter(Boolean).sort();
    supertonicAvailable = VOICES.length > 0;
    setDot(supertonicAvailable ? 'ok' : 'down');
    updateBarControls();
  }

  // --------------------------------------------------------------------------
  // Tweet parsing (ported verbatim)
  // --------------------------------------------------------------------------
  function cleanNodes(nodes) {
    const parts = [];
    nodes.forEach((node) => {
      if (!node) return;
      const clone = node.cloneNode(true);
      clone.querySelectorAll('a').forEach((a) => {
        const href = a.getAttribute('href') || '';
        if (/^https?:\/\//i.test(href) || href.includes('t.co/')) a.remove();
      });
      parts.push(clone.innerText || '');
    });
    let text = parts.join('. ');
    text = text.replace(/[\p{Emoji_Presentation}\p{Extended_Pictographic}]/gu, ' ');
    text = text.replace(/#(\w+)/g, '$1').replace(/@(\w+)/g, 'at $1');
    text = text.replace(/https?:\/\/\S+/gi, '');
    text = text.replace(/\b(?:[a-z0-9-]+\.)+(?:com|net|org|io|co|gg|tv|me|ly|app|dev|xyz|ai|to|us|uk|so|fm)\b(?:\/\S*)?/gi, '');
    return text.replace(/\s+/g, ' ').trim();
  }
  function extractParts(tweetEl) {
    const allText = Array.from(tweetEl.querySelectorAll('[data-testid="tweetText"]'));
    let qWrap = null;
    tweetEl.querySelectorAll('div[role="link"][tabindex]').forEach((w) => {
      if (!qWrap && w.querySelector('[data-testid="User-Name"]') && w.querySelector('[data-testid="tweetText"]')) qWrap = w;
    });
    let quoted = null;
    if (qWrap) {
      const qNameEl = qWrap.querySelector('[data-testid="User-Name"]');
      const qName = qNameEl ? (qNameEl.innerText.split('\n')[0] || '').trim() : '';
      const qText = cleanNodes([qWrap.querySelector('[data-testid="tweetText"]')]);
      if (qText) quoted = { name: qName, text: qText };
    }
    const mainNodes = allText.filter((t) => !(qWrap && qWrap.contains(t)));
    return { main: cleanNodes(mainNodes), quoted };
  }
  function altTexts(tweetEl) {
    const out = [];
    tweetEl.querySelectorAll('[data-testid="tweetPhoto"] img[alt], img[alt][draggable="true"]').forEach((im) => {
      const a = (im.getAttribute('alt') || '').trim();
      if (a && a.length > 2 && a.toLowerCase() !== 'image') out.push(a);
    });
    return out;
  }
  function extractAuthor(tweetEl) {
    const nameEl = tweetEl.querySelector('[data-testid="User-Name"]');
    let handle = '', name = '';
    if (nameEl) {
      const txt = nameEl.innerText || '';
      const m = txt.match(/@(\w+)/); if (m) handle = m[1];
      name = (txt.split('\n')[0] || '').trim();
    }
    return { handle, name };
  }
  function tweetId(el) {
    if (!el || !el.querySelector) return null;
    const a = el.querySelector('a[href*="/status/"]'); if (!a) return null;
    const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/); return m ? m[1] : null;
  }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; }
  function hashVoice(handle) { return VOICES.length ? VOICES[Math.abs(hashStr(handle.toLowerCase())) % VOICES.length] : ''; }
  function resolveVoice(handle) {
    if (handle) { const v = settings.authorVoices[handle.toLowerCase()]; if (v) return v; if (settings.autoVoices) return hashVoice(handle); }
    return settings.voice || '';
  }
  function voiceArg(handle) {
    if (!supertonicAvailable) return undefined;   // fallback path → let the engine pick a default
    return resolveVoice(handle) || undefined;
  }
  function buildSpokenText(tweetEl) {
    const { main, quoted } = extractParts(tweetEl);
    let text = main || '';
    if (quoted && quoted.text) { const q = quoted.name ? `quoting ${quoted.name}: ${quoted.text}` : `quoting: ${quoted.text}`; text = text ? `${text}. ${q}` : q; }
    if (settings.readAltText) { const alts = altTexts(tweetEl); if (alts.length) { const a = `Image: ${alts.join('. ')}`; text = text ? `${text}. ${a}` : a; } }
    if (!text) return '';
    if (settings.announceAuthor) { const { name } = extractAuthor(tweetEl); if (name) text = `${name} says: ${text}`; }
    if (!/[.!?…]$/.test(text)) text += '.';
    if (text.length > settings.maxChars) text = text.slice(0, settings.maxChars);
    return text;
  }
  // X truncates long posts in the DOM ("Show more"). Click to expand so we read the FULL
  // text (it expands inline — no navigation), then wait briefly for it to grow.
  async function expandTruncated(tweetEl) {
    const link = tweetEl && tweetEl.querySelector('[data-testid="tweet-text-show-more-link"]');
    if (!link) return;
    const tt = tweetEl.querySelector('[data-testid="tweetText"]');
    const before = tt ? tt.innerText.length : 0;
    try { link.click(); } catch (e) { return; }
    for (let i = 0; i < 16; i++) {
      await sleep(50);
      if (!tweetEl.querySelector('[data-testid="tweet-text-show-more-link"]')) return;
      const t2 = tweetEl.querySelector('[data-testid="tweetText"]');
      if (t2 && t2.innerText.length > before) return;
    }
  }
  // Promoted/ad posts — skipped during continuous (thread) reading. Detect ads ONLY by the
  // standalone "Ad"/"Promoted" label. Do NOT use [data-testid="placementTracking"]: X applies
  // that to organic VIDEO tweets too, which made thread mode skip every video post.
  function isPromoted(tweetEl) {
    if (!tweetEl) return false;
    return Array.from(tweetEl.querySelectorAll('span')).some((s) =>
      s.children.length === 0 && /^(ad|promoted)$/i.test((s.textContent || '').trim()));
  }

  // --------------------------------------------------------------------------
  // Word highlighting: caption overlay (always) + best-effort in-post (Highlight API)
  // --------------------------------------------------------------------------
  let captionEl = null;
  const supportsHL = typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && CSS.highlights;
  function ensureCaption() {
    if (captionEl) return captionEl;
    captionEl = document.createElement('div'); captionEl.className = 'xpeaker-caption';
    document.body.appendChild(captionEl);
    return captionEl;
  }
  function clearInPost() { if (supportsHL) { try { CSS.highlights.delete('xpeaker'); } catch (e) {} } }
  function highlightInPost(rootNode, word, cursorRef) {
    if (!supportsHL || !word) return;
    const walker = document.createTreeWalker(rootNode, NodeFilter.SHOW_TEXT, null);
    let flat = ''; const segs = []; let tn;
    while ((tn = walker.nextNode())) { segs.push([tn, flat.length]); flat += tn.nodeValue; }
    if (!flat) return;
    const needle = word.trim().toLowerCase(); if (!needle) return;
    const hay = flat.toLowerCase();
    let idx = hay.indexOf(needle, cursorRef.pos);
    if (idx === -1) idx = hay.indexOf(needle);
    if (idx === -1) return;
    cursorRef.pos = idx + needle.length;
    const locate = (pos) => { for (let i = segs.length - 1; i >= 0; i--) if (pos >= segs[i][1]) return [segs[i][0], pos - segs[i][1]]; return [segs[0][0], 0]; };
    const [sNode, sOff] = locate(idx);
    const [eNode, eOff] = locate(idx + needle.length);
    try {
      const range = document.createRange();
      range.setStart(sNode, Math.min(sOff, sNode.nodeValue.length));
      range.setEnd(eNode, Math.min(eOff, eNode.nodeValue.length));
      CSS.highlights.set('xpeaker', new Highlight(range));
    } catch (e) {}
  }
  function startHighlight(tweetEl, spokenText) {
    const mode = settings.highlight || 'caption';
    // Focus Mode shows text statically over a full-screen stage — suppress the
    // karaoke caption/in-post highlight entirely (it would otherwise run hidden
    // behind the overlay, wasting work).
    if (mode === 'off' || focusActive) return { word() {}, end() {} };
    const cap = ensureCaption();
    cap.textContent = spokenText; cap.style.display = 'block';
    let inPostNode = null; const cursor = { pos: 0 };
    if (mode === 'both') {
      const tn = tweetEl && tweetEl.querySelector('[data-testid="tweetText"]');
      if (tn) inPostNode = tn;
    }
    return {
      word(m) {
        if (typeof m.charIndex !== 'number') return;
        const start = m.charIndex, end = start + (m.length || 0);
        const word = spokenText.slice(start, end);
        cap.innerHTML = '';
        cap.append(document.createTextNode(spokenText.slice(0, start)));
        const sp = document.createElement('span'); sp.className = 'xpeaker-word'; sp.textContent = word;
        cap.append(sp, document.createTextNode(spokenText.slice(end)));
        try { sp.scrollIntoView({ block: 'nearest' }); } catch (e) {}
        if (inPostNode) highlightInPost(inPostNode, word, cursor);
      },
      end() { if (captionEl) { captionEl.style.display = 'none'; captionEl.textContent = ''; } clearInPost(); },
    };
  }

  // --------------------------------------------------------------------------
  // Focus Mode hooks — a presentation layer (the full-screen Focus overlay)
  // subscribes here to observe playback without forking the reader. The single/
  // thread loops fire onTweetStart when a tweet begins speaking and onTweetEnd when
  // its utterance resolves (reason: 'ended' | 'error' | 'stopped', see speakBridge).
  // Default no-ops so nothing changes until a consumer installs handlers via
  // setFocusHooks(). Handlers are wrapped so a buggy overlay can't break the reader.
  // Phase-0 note: run `localStorage.xpeakerFocusDebug = 1` in the page console and
  // reload to log each start/end and confirm the seam fires. localStorage (not a
  // window flag) is used deliberately: the content script runs in an isolated world,
  // so a window var set from the DevTools console (main world) never reaches it —
  // localStorage is shared per-origin across both worlds.
  // --------------------------------------------------------------------------
  const NO_FOCUS_HOOKS = { onTweetStart() {}, onTweetEnd() {}, onThreadEnd() {} };
  let focusHooks = NO_FOCUS_HOOKS;
  let focusDebug = false;
  try { focusDebug = localStorage.getItem('xpeakerFocusDebug') === '1'; } catch (e) {}
  function setFocusHooks(h) { focusHooks = h || NO_FOCUS_HOOKS; }
  function fireTweetStart(el, text, author, index) {
    if (focusDebug) console.log('[Xpeaker:focus] start', { index, author, len: (text || '').length, text });
    try { focusHooks.onTweetStart(el, text, author, index); } catch (e) { console.error('[Xpeaker] focus onTweetStart handler threw', e); }
  }
  function fireTweetEnd(el, reason) {
    if (focusDebug) console.log('[Xpeaker:focus] end', { reason });
    try { focusHooks.onTweetEnd(el, reason); } catch (e) { console.error('[Xpeaker] focus onTweetEnd handler threw', e); }
  }
  // Fired ONCE when the thread reader runs dry naturally (not on stop/supersede).
  function fireThreadEnd(count) {
    if (focusDebug) console.log('[Xpeaker:focus] threadEnd', { count });
    try { focusHooks.onThreadEnd(count); } catch (e) { console.error('[Xpeaker] focus onThreadEnd handler threw', e); }
  }

  // --------------------------------------------------------------------------
  // Playback control flags (AudioContext logic removed; routes to chrome.tts)
  // --------------------------------------------------------------------------
  let activeBtn = null, isPaused = false, pausedForVideo = false, resumeWaiters = [], watchedVideo = null;
  function pause() {
    if (isPaused || !(activeBtn || threadActive)) return;
    isPaused = true; ttsPause();
    if (focusActive && focusVideoEl && !focusVideoEl.paused) { try { focusVideoEl.pause(); focusVideoPaused = true; focusVideoPausedByUser = true; } catch (e) {} } // pause the clip too
    if (activeBtn) setBtnState(activeBtn, 'paused');
    updateBarControls();
  }
  function resume() {
    if (!isPaused) return;
    isPaused = false; pausedForVideo = false; ttsResume();
    if (focusActive && focusVideoPausedByUser && focusVideoEl) { try { focusVideoPaused = false; focusVideoPausedByUser = false; focusVideoEl.play().catch(() => {}); } catch (e) {} }
    if (activeBtn) setBtnState(activeBtn, 'playing');
    const w = resumeWaiters; resumeWaiters = []; w.forEach((r) => r());
    updateBarControls();
  }
  function togglePause() { if (isPaused) resume(); else pause(); }
  function waitWhilePaused() { return isPaused ? new Promise((r) => resumeWaiters.push(r)) : Promise.resolve(); }
  // Revert the active post button to its idle state and forget it. Called from any path
  // that stops/supersedes playback, so the per-post button never gets stuck "playing".
  function clearActiveBtn() { if (activeBtn) { setBtnState(activeBtn, 'idle'); activeBtn = null; } }
  function fullStop() {
    stopThread(); ttsStop(); clearActiveBtn();
    isPaused = false; pausedForVideo = false;
    const w = resumeWaiters; resumeWaiters = []; w.forEach((r) => r());
    detachWatch(); setBarState('idle'); updateBarControls();
  }
  // Stop our reader WITHOUT chrome.tts.stop() (global — would cut off the tab that just
  // claimed). Used when another tab takes over.
  function softStop() {
    stopThread(); clearActiveBtn(); isPaused = false; pausedForVideo = false;
    const w = resumeWaiters; resumeWaiters = []; w.forEach((r) => r());
    detachWatch(); setBarState('idle'); updateBarControls();
  }
  function detachWatch() {
    if (watchedVideo) { watchedVideo.removeEventListener('ended', onWatchEnd); watchedVideo.removeEventListener('pause', onWatchEnd); watchedVideo = null; }
  }
  function onWatchEnd() { if (pausedForVideo) resume(); detachWatch(); }

  function canSpeak(btn) {
    if (supertonicAvailable || settings.fallbackToNative) return true;
    if (btn) flashError(btn);
    showInstallToast();
    refreshVoices();
    return false;
  }

  // --------------------------------------------------------------------------
  // Single-post playback
  // --------------------------------------------------------------------------
  async function speakSingle(tweetEl, btn) {
    stopThread(); setBarState('idle'); ttsStop(); clearActiveBtn(); isPaused = false;
    cursorTweet = tweetEl; // J/K step from the last post you read
    await expandTruncated(tweetEl);
    const text = buildSpokenText(tweetEl);
    if (!text) { flashError(btn); return; }
    if (!canSpeak(btn)) return;
    claimReader();
    setBtnState(btn, 'loading'); activeBtn = btn;
    const hl = startHighlight(tweetEl, text);
    fireTweetStart(tweetEl, text, extractAuthor(tweetEl), 1);
    const reason = await speakBridge(text, voiceArg(extractAuthor(tweetEl).handle), rate(), {
      onStart: () => { if (activeBtn === btn) setBtnState(btn, 'playing'); },
      onWord: (m) => hl.word(m),
    });
    hl.end();
    fireTweetEnd(tweetEl, reason);
    if (activeBtn !== btn) return;
    if (reason === 'error') flashError(btn);
    else if (['playing', 'loading', 'paused'].includes(btn.dataset.state)) setBtnState(btn, 'idle');
    if (activeBtn === btn) activeBtn = null;
  }
  function readSinglePost(el) { if (el) { const btn = el.querySelector('.xpeaker-speak-btn'); if (btn) speakSingle(el, btn); } }
  function flashError(btn) { if (!btn) return; setBtnState(btn, 'error'); setTimeout(() => { if (btn.dataset.state === 'error') setBtnState(btn, 'idle'); }, 1800); }

  // --------------------------------------------------------------------------
  // Thread reader
  // --------------------------------------------------------------------------
  let threadGen = 0, threadActive = false, navRequest = null;
  function getTimelineTweets() { return Array.from(document.querySelectorAll('article[data-testid="tweet"]')); }
  function findById(id) { return getTimelineTweets().find((e) => tweetId(e) === id) || null; }
  function highlight(el, on) { if (el) el.classList.toggle('xpeaker-reading', !!on); }
  function stopThread() {
    threadGen++; threadActive = false;
    document.querySelectorAll('.xpeaker-reading').forEach((e) => e.classList.remove('xpeaker-reading'));
  }
  function skipNext() { if (settings.mode === 'thread' && threadActive) { navRequest = 'next'; ttsStop(); } }
  function prevPost() { if (settings.mode === 'thread' && threadActive) { navRequest = 'prev'; ttsStop(); } }
  function neighbor(el, dir, seen) {
    const list = getTimelineTweets(); const idx = list.indexOf(el); if (idx === -1) return null;
    const step = dir === 'down' ? 1 : -1;
    for (let j = idx + step; j >= 0 && j < list.length; j += step) { const id = tweetId(list[j]); if (!seen || !id || !seen.has(id)) return list[j]; }
    return null;
  }
  function pickUnseen(dir, seen) {
    const list = getTimelineTweets(); const order = dir === 'down' ? list : list.slice().reverse();
    for (const el of order) { const id = tweetId(el); if (!id || !seen.has(id)) return el; }
    return null;
  }
  async function loadMore(dir) {
    const before = new Set(getTimelineTweets().map(tweetId).filter(Boolean));
    window.scrollBy(0, Math.round(window.innerHeight * 0.85) * (dir === 'down' ? 1 : -1));
    await sleep(650);
    for (const id of getTimelineTweets().map(tweetId)) if (id && !before.has(id)) return true;
    return false;
  }
  async function runThread(startEl) {
    stopThread(); ttsStop(); clearActiveBtn(); isPaused = false;
    if (!(supertonicAvailable || settings.fallbackToNative)) { setBarState('idle', 'Install Supertonic voices'); showInstallToast(); refreshVoices(); return; }
    claimReader();
    const gen = ++threadGen; threadActive = true; navRequest = null;
    const dir = settings.direction; const seen = new Set(); const order = [];
    setBarState('playing', 'Reading…');
    let el = startEl, dryLoads = 0;
    try {
      while (gen === threadGen && el) {
        navRequest = null;
        if (isPaused) { await waitWhilePaused(); if (gen !== threadGen) return; }
        const id = tweetId(el);
        const promoted = isPromoted(el);
        if (promoted && id) seen.add(id);
        if (!promoted && (!id || !seen.has(id))) {
          if (id) { seen.add(id); order.push(id); }
          await expandTruncated(el);
          if (gen !== threadGen) return;
          const text = buildSpokenText(el);
          // A caption-less tweet (empty/emoji-only text) is normally skipped — nothing
          // to read. In Focus, still SHOW a media tweet: scroll it in, let the media
          // mount, and render if it actually has a video / photos to present.
          let captionless = false;
          if (!text && focusActive) {
            try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
            await sleep(150); if (gen !== threadGen) return;
            captionless = focusHasMedia(liveArticle(el) || el);
          }
          if (text || captionless) {
            try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
            highlight(el, true);
            const btn = el.querySelector('.xpeaker-speak-btn');
            activeBtn = btn; if (btn) setBtnState(btn, 'playing'); // reflect on the post button too
            setBarState('playing', `Reading ${order.length}`);
            fireTweetStart(el, text, extractAuthor(el), order.length);
            let reason = 'ended';
            const speak = async () => {
              if (!text) return;                                               // caption-less media tweet → nothing to read
              const hl = startHighlight(el, text);
              reason = await speakBridge(text, voiceArg(extractAuthor(el).handle), rate(), { onWord: (m) => {
                if (!focusFirstWordLogged) { focusFirstWordLogged = true; if (focusDebug && focusEnterT) console.log(`[Xpeaker:focus] first audible word +${Math.round(performance.now() - focusEnterT)}ms after enter (moodRing=${!!settings.moodRing})`); }
                hl.word(m);
              } });
              hl.end();
            };
            // Video tweets (Focus, sound on): sequence the clip's audio vs the caption
            // TTS per the videoOrder setting. Everything else reads normally.
            // X lazy-mounts <video> after scrollIntoView fires its IntersectionObserver,
            // so on auto-advance to an off-screen video tweet the node may not exist yet.
            // When a video container IS present but the <video> hasn't attached, poll
            // briefly before deciding — else the audio phase is silently skipped.
            let vplan = focusVideoPlan(el);
            if (!vplan.audio && focusActive && settings.videoSound !== false && !focusSilenceSession && liveVideoPending(el)) {
              for (let i = 0; i < 8 && !liveVideo(el) && gen === threadGen; i++) await sleep(200);
              if (gen !== threadGen) return;
              vplan = focusVideoPlan(el);
            }
            if (vplan.audio && vplan.order === 'clip') {
              await focusPlayAudio(el, gen);                                   // clip only, no TTS
            } else if (vplan.audio && vplan.order === 'play') {
              await focusPlayAudio(el, gen);                                   // play clip, then read
              if (gen === threadGen && !navRequest) await speak();
            } else if (vplan.audio && vplan.order === 'read') {
              await speak();                                                   // read the caption first
              // "next" during the caption skips AHEAD TO THE CLIP (not to the next
              // tweet); a second "next" during the clip then advances. prev/stop pass through.
              const skipToClip = gen === threadGen && navRequest === 'next';
              if (skipToClip) navRequest = null;
              if (gen === threadGen && !navRequest && (reason === 'ended' || skipToClip)) await focusPlayAudio(el, gen);
            } else {
              await speak();                                                   // text / photo / muted b-roll / bar mode
            }
            fireTweetEnd(el, reason);
            if (gen !== threadGen) return; // superseded: stopThread() cleared highlights, clearActiveBtn() the button
            highlight(el, false);
            if (activeBtn === btn) { setBtnState(btn, 'idle'); activeBtn = null; }
            // Focus Mode: if a multi-image tweet's caption ended before its photos
            // finished cycling, hold before advancing so every image is seen. Bounded,
            // and interrupted by next/prev (navRequest) or stop (gen change).
            if (focusActive && reason === 'ended' && !navRequest) {
              const holdStart = Date.now();
              while (!focusMediaComplete && !navRequest && gen === threadGen && Date.now() - holdStart < 11000) await sleep(120);
              if (gen !== threadGen) return;
            }
            // Minimum on-screen dwell (Focus): short tweets linger so you can interact
            // via the always-visible action bar; long tweets advance right after playback.
            // Bar mode keeps the plain postGap.
            if (focusActive && reason !== 'stopped' && !navRequest && gen === threadGen) {
              await focusDwellHold(el, gen);
              if (gen !== threadGen) return;
            } else if (!navRequest && reason !== 'stopped' && settings.postGapMs) {
              await sleep(settings.postGapMs); if (gen !== threadGen) return;
            }
          }
        }
        if (navRequest === 'prev' && order.length >= 2) {
          const curId = order.pop(); const prevId = order.pop();
          seen.delete(curId); seen.delete(prevId);
          const prevEl = findById(prevId);
          if (prevEl) { el = prevEl; continue; }
          order.push(prevId); order.push(curId);
        }
        let next = neighbor(el, dir, seen);
        if (!next) {
          const grew = await loadMore(dir);
          if (gen !== threadGen) return;
          next = neighbor(el, dir, seen) || pickUnseen(dir, seen);
          if (!grew && !next) dryLoads++; else dryLoads = 0;
          if (dryLoads >= 2 || !next) { setBarState('idle', 'Done'); fireThreadEnd(order.length); return; }
        }
        el = next;
      }
    } finally { if (gen === threadGen) threadActive = false; }
  }

  // --------------------------------------------------------------------------
  // Per-post button
  // --------------------------------------------------------------------------
  const SVG = {
    speaker: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3A4.5 4.5 0 0 0 14 7.97v8.05A4.5 4.5 0 0 0 16.5 12zM14 3.23v2.06a7 7 0 0 1 0 13.42v2.06a9 9 0 0 0 0-17.54z"></path></svg>',
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7L8 5z"></path></svg>',
    playing: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 7h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1z"></path></svg>',
    error: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.1 1.6 21h20.8L12 3.1zm0 4.9 6.9 11.9H5.1L12 8zm-1 3.5v3h2v-3h-2zm0 4.5v2h2v-2h-2z"></path></svg>',
    loading: '<span class="xpeaker-spinner" aria-hidden="true"></span>',
  };
  const BAR_ICON = {
    play: SVG.play, stop: SVG.playing, speaker: SVG.speaker,
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h3v12H7zM14 6h3v12h-3z"></path></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14l8-7zM16 5h2.2v14H16z"></path></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14l-8-7zM7.8 5H5.6v14h2.2z"></path></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-8 8h5v8h6v-8h5z"></path></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20l8-8h-5V4H9v8H4z"></path></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm9-2c0-.5-.05-1-.13-1.47l1.86-1.45-2-3.46-2.2.9a7.5 7.5 0 0 0-1.27-.74l-.33-2.35h-4l-.33 2.35c-.45.2-.87.45-1.27.74l-2.2-.9-2 3.46 1.86 1.45A8 8 0 0 0 6 12c0 .5.05 1 .13 1.47L4.27 14.9l2 3.46 2.2-.9c.4.3.82.55 1.27.74l.33 2.35h4l.33-2.35c.45-.2.87-.44 1.27-.74l2.2.9 2-3.46-1.86-1.45c.08-.46.13-.96.13-1.45z"></path></svg>',
    scene: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3 3 8l9 5 9-5-9-5Z"></path><path d="m3 13 9 5 9-5"></path></svg>',
    newtab: '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 16 16 8"></path><path d="M9.5 8H16v6.5"></path></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12 15 18.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    focus: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V5.5a1.5 1.5 0 0 1 1.5-1.5H9M15 4h3.5A1.5 1.5 0 0 1 20 5.5V9M20 15v3.5a1.5 1.5 0 0 1-1.5 1.5H15M9 20H5.5A1.5 1.5 0 0 1 4 18.5V15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>',
    // Xpeaker logo mark (the X + soundwaves from icons/icon.svg, sans the black tile —
    // the pill supplies the background). Anchors the collapsed control dock.
    xpeaker: '<svg viewBox="0 0 128 128" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="12" stroke-linecap="round"><line x1="36" y1="46" x2="72" y2="84"></line><line x1="72" y1="46" x2="36" y2="84"></line></g><g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round"><path d="M86 54a15 15 0 0 1 0 22"></path><path d="M97 46a30 30 0 0 1 0 38"></path></g></svg>',
  };

  function idleIcon() { return settings.mode === 'thread' ? SVG.play : SVG.speaker; }
  function setBtnState(btn, state) {
    if (!btn) return;
    btn.dataset.state = state;
    const wrap = btn.querySelector('.xp-iconwrap');
    const icon = state === 'idle' ? idleIcon() : state === 'paused' ? SVG.play : (SVG[state] || idleIcon());
    if (wrap) wrap.innerHTML = icon;
    const label = state === 'paused' ? 'Resume'
      : state === 'playing' ? 'Stop'
      : settings.mode === 'thread' ? `Read from here (${settings.direction})`
      : 'Read this post aloud';
    btn.setAttribute('aria-label', label); btn.title = label;
  }
  function applyModeToButtons() { document.querySelectorAll('.xpeaker-speak-btn').forEach((btn) => { if (!btn.dataset.state || btn.dataset.state === 'idle') setBtnState(btn, 'idle'); }); }
  function makeButton(tweetEl) {
    const btn = document.createElement('div');
    btn.setAttribute('role', 'button'); btn.setAttribute('tabindex', '0'); btn.className = 'xpeaker-speak-btn';
    const wrap = document.createElement('div'); wrap.className = 'xp-iconwrap'; btn.appendChild(wrap); setBtnState(btn, 'idle');
    const onActivate = (e) => {
      e.preventDefault(); e.stopPropagation();
      const st = btn.dataset.state;
      // A playing button shows "Stop" — clicking it must STOP (both modes). Check
      // state BEFORE the thread-mode branch, else thread mode just restarted the post.
      if (st === 'playing' || st === 'loading') { fullStop(); return; }
      if (st === 'paused') { resume(); return; }
      if (settings.mode === 'thread') { runThread(tweetEl); return; }
      speakSingle(tweetEl, btn);
    };
    btn.addEventListener('click', onActivate);
    btn.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') onActivate(e); });
    return btn;
  }
  function addButtonToTweet(tweetEl) {
    if (tweetEl.querySelector('.xpeaker-speak-btn')) return;
    const actionBar = tweetEl.querySelector('[role="group"]'); if (!actionBar) return;
    actionBar.appendChild(makeButton(tweetEl));
  }

  // --------------------------------------------------------------------------
  // Install toast (Supertonic voices missing)
  // --------------------------------------------------------------------------
  function showInstallToast() {
    if (installToastShown) return; installToastShown = true;
    const t = document.createElement('div'); t.className = 'xpeaker-toast';
    t.innerHTML = 'No Supertonic voices found. ';
    const a = document.createElement('a'); a.href = SUPERTONIC_INSTALL_URL; a.target = '_blank'; a.rel = 'noopener'; a.textContent = 'Install the Supertonic voices extension';
    t.appendChild(a);
    const close = document.createElement('button'); close.className = 'xpeaker-toast-x'; close.textContent = '✕'; close.onclick = () => t.remove();
    t.appendChild(close);
    document.body.appendChild(t);
    setTimeout(() => { if (t.isConnected) t.remove(); }, 12000);
    setTimeout(() => { installToastShown = false; }, 12000);
  }

  // --------------------------------------------------------------------------
  // Focus Mode overlay — full-screen presentation surface over the existing
  // reader. A new *presentation layer* only: entering forces thread mode and
  // starts runThread(), which drives everything (enumeration, ad-skip, paging,
  // per-author voice, pause/resume, next/prev). The overlay just renders each
  // tweet's static text + author via the focusHooks seam while chrome.tts speaks,
  // and the control pill calls the SAME transport functions as the floating bar.
  // No karaoke (dropped): text is shown statically, advance on 'ended'.
  // Focus Mode is PER-TAB, in-memory state (focusActive) — never persisted — so opening
  // it in one tab doesn't mount it (or start TTS) in other x.com tabs, and a refresh /
  // new tab always starts clean. Toggled locally by toggleFocus (dock/keyboard/Esc) or a
  // {t:'cmd',cmd:'focus'} message to THIS tab from the popup / context menu.
  // --------------------------------------------------------------------------
  let focusEl = null, focusActive = false, priorMode = null;
  let focusScene = null, focusLastMood = null, activeSceneId = null, focusHideT = null, focusCurrentEl = null, focusAvatarTimer = null, focusMediaTimer = null, focusQuoteTimer = null, focusFollowTimer = null, focusRetweetTimer = null;
  let focusEnterT = 0, focusFirstWordLogged = false; // debug timing: enter → first audible word (set localStorage.xpeakerFocusDebug=1)
  let focusMediaComplete = true; // false while a multi-image tweet still has photos left to show
  let focusVideoRaf = 0, focusVideoEl = null; // canvas mirror: rAF handle + the mirrored <video>
  let focusVideoPaused = false;               // user/pill-paused the clip (blocks the draw loop's auto-replay)
  let focusVideoAudio = false;                // true during the audio phase (clip plays unmuted; b-roll otherwise)
  let focusVideoPausedByUser = false;         // clip paused via the transport (vs. frozen on last frame post-audio) — only this should replay on resume
  let focusSilenceSession = false;            // "Keep silent" at the audio prompt: mute clips for this browsing session (in-memory; clears on reload) rather than persisting to settings
  let audioAskEnable = null, audioAskSilent = null; // pending audio-prompt callbacks
  const FOCUS_VIDEO_AUDIO_DEFAULT = 150;      // fallback: auto-play WITH SOUND for clips ≤ this many seconds
  const videoAudioMax = () => clamp(Math.round(settings.videoAudioMaxSec || FOCUS_VIDEO_AUDIO_DEFAULT), 5, 3600); // configurable sound cap (seconds)
  let focusInteractExtend = null, focusInteractEl = null, focusTweetStart = 0, focusInteractLastTap = 0; // interaction bar state
  const FOCUS_INTERACT_MS = 4000;             // minimum time a tweet stays on screen (short tweets); an action tap resets it

  const FOCUS_PALETTES = [['#6d5cf0', '#12a3a6'], ['#e0245e', '#8c5aff'], ['#0f9d58', '#12a3a6'],
    ['#f4b400', '#e0245e'], ['#8c5aff', '#12a3a6'], ['#1d9bf0', '#6d5cf0'], ['#12a3a6', '#8c5aff']];
  const FOCUS_X = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path></svg>';
  const WARN_TRI = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.2 1.6 21h20.8L12 3.2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"></path><path d="M12 10v4.2" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"></path><circle cx="12" cy="17.6" r="1.15" fill="currentColor"></circle></svg>';
  const CHEV_L = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5l-7 7 7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  const CHEV_R = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>';
  function focusInitials(name, handle) {
    const src = (name || handle || '?').trim();
    const parts = src.split(/\s+/).filter(Boolean);
    let ini = parts.slice(0, 2).map((p) => p[0]).join('');
    if (ini.length < 2) ini = src.replace(/\s+/g, '').slice(0, 2); // single-word name -> first 2 chars
    return ini.toUpperCase().slice(0, 2);
  }
  function focusGradient(handle) { return FOCUS_PALETTES[Math.abs(hashStr((handle || '').toLowerCase())) % FOCUS_PALETTES.length]; }
  // The author's profile image URL from the tweet DOM (X's own pbs.twimg.com CDN,
  // already allowed by x.com's img-src), or null → the initials gradient is used.
  function extractAvatar(tweetEl) {
    const box = tweetEl && tweetEl.querySelector('[data-testid="Tweet-User-Avatar"]');
    let src = '';
    if (box) {
      const img = box.querySelector('img');
      src = (img && (img.currentSrc || img.src)) || '';
      if (!src) { const bg = box.querySelector('[style*="profile_images"]'); const m = bg && (bg.getAttribute('style') || '').match(/url\("?([^")]+)"?\)/); if (m) src = m[1]; }
    }
    return /pbs\.twimg\.com\/profile_images/.test(src) ? src : null;
  }
  // The main tweet's photo URLs (real photos only — not video thumbnails), upgraded
  // to a large variant. Quoted-tweet photos are excluded via the same qWrap detection
  // extractParts uses. Empty array ⇒ a text-only tweet.
  function extractPhotos(tweetEl) {
    if (!tweetEl) return [];
    let qWrap = null;
    tweetEl.querySelectorAll('div[role="link"][tabindex]').forEach((w) => {
      if (!qWrap && w.querySelector('[data-testid="User-Name"]') && w.querySelector('[data-testid="tweetText"]')) qWrap = w;
    });
    const urls = [];
    tweetEl.querySelectorAll('[data-testid="tweetPhoto"] img').forEach((im) => {
      if (qWrap && qWrap.contains(im)) return;               // skip quoted-tweet photos
      const src = im.currentSrc || im.src || '';
      if (!/pbs\.twimg\.com\/media\//.test(src)) return;      // real photos only (drops video thumbs)
      const hi = src.replace(/([?&]name=)[^&]+/, '$1large');  // upgrade size to the large variant
      if (!urls.includes(hi)) urls.push(hi);
    });
    return urls.slice(0, 6);
  }
  // The quoted tweet (name, handle, text, profile pic, image), or null.
  function extractQuote(tweetEl) {
    if (!tweetEl) return null;
    let qWrap = null;
    tweetEl.querySelectorAll('div[role="link"][tabindex]').forEach((w) => {
      if (!qWrap && w.querySelector('[data-testid="User-Name"]') && w.querySelector('[data-testid="tweetText"]')) qWrap = w;
    });
    if (!qWrap) return null;
    const nameEl = qWrap.querySelector('[data-testid="User-Name"]');
    const raw = nameEl ? (nameEl.innerText || '') : '';
    const name = (raw.split('\n')[0] || '').trim();
    const hm = raw.match(/@(\w+)/); const handle = hm ? hm[1] : '';
    const textEl = qWrap.querySelector('[data-testid="tweetText"]');
    const text = textEl ? (textEl.innerText || '').replace(/\s+$/, '') : '';
    const av = qWrap.querySelector('[data-testid="Tweet-User-Avatar"] img') || qWrap.querySelector('img[src*="profile_images"]');
    const avatar = av && /pbs\.twimg\.com\/profile_images/.test(av.currentSrc || av.src || '') ? (av.currentSrc || av.src) : null;
    const ph = qWrap.querySelector('[data-testid="tweetPhoto"] img');
    const image = ph && /pbs\.twimg\.com\/media\//.test(ph.currentSrc || ph.src || '') ? (ph.currentSrc || ph.src) : null;
    return { name, handle, text, avatar, image };
  }
  // The author's verified badge <svg> (or null). Returned as-is so the caller can
  // clone it — cloning preserves X's exact blue / gold / grey check colour.
  function extractVerified(tweetEl) {
    const nameEl = tweetEl && tweetEl.querySelector('[data-testid="User-Name"]');
    return (nameEl && nameEl.querySelector('svg[aria-label="Verified account"]')) || null;
  }
  // The author's follow relationship: true (following), false (not following →
  // offer Follow), or null (unknown). The state lives in X's React props, and the
  // fiber (`__reactFiber$…`) is a page-world expando INVISIBLE to this isolated
  // content script — so we ask the MAIN-world bridge (content/mainworld.js) via a
  // synchronous DOM event; it stamps `data-xp-following` which we then read.
  function extractFollowState(tweetEl) {
    if (!tweetEl) return null;
    try {
      tweetEl.dispatchEvent(new CustomEvent('xpeaker-getfollow', { bubbles: true }));
      const v = tweetEl.getAttribute('data-xp-following');
      if (v === 'true') return true;
      if (v === 'false') return false;
    } catch (e) {}
    return null; // 'unknown' or bridge not ready yet → caller retries
  }
  // The main tweet's <video> element (excluding a quoted tweet's), or null.
  function extractVideo(tweetEl) {
    if (!tweetEl) return null;
    let qWrap = null;
    tweetEl.querySelectorAll('div[role="link"][tabindex]').forEach((w) => {
      if (!qWrap && w.querySelector('[data-testid="User-Name"]') && w.querySelector('[data-testid="tweetText"]')) qWrap = w;
    });
    for (const v of tweetEl.querySelectorAll('video')) { if (!(qWrap && qWrap.contains(v))) return v; }
    return null;
  }
  // Does this tweet have media Focus can show (its own video or photos, excluding a
  // quoted tweet's)? Lets a caption-less media tweet still render instead of being
  // skipped. Accepts the video player container/poster too, since the <video> may
  // not have mounted yet.
  function focusHasMedia(tweetEl) {
    if (!tweetEl) return false;
    if (extractVideo(tweetEl)) return true;
    let qWrap = null;
    tweetEl.querySelectorAll('div[role="link"][tabindex]').forEach((w) => { if (!qWrap && w.querySelector('[data-testid="User-Name"]') && w.querySelector('[data-testid="tweetText"]')) qWrap = w; });
    for (const c of tweetEl.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) { if (!(qWrap && qWrap.contains(c))) return true; }
    try { if (extractPhotos(tweetEl).length) return true; } catch (e) {}
    return false;
  }
  // Clean text to SHOW (distinct from the spoken string, which carries TTS
  // scaffolding like "Name says:" / "Image:"): prefer the raw extracted parts.
  function focusDisplayText(el, spoken) {
    try {
      const { main } = extractParts(el); // quoted content is rendered in its own card, not appended here
      if (main) return main;
    } catch (e) {}
    return (spoken || '').replace(/^.{1,60}? says:\s*/, '').trim();
  }
  // Populate the nested quote card (quoted author avatar/name + text + image), or
  // hide it. Avatar/image lazy-load like the main ones → short retry poll.
  function applyFocusQuote(el) {
    if (!focusEl) return;
    const card = focusEl.querySelector('.xpeaker-focus-quote'); if (!card) return;
    const q0 = extractQuote(el);
    if (!q0) { card.dataset.show = '0'; return; }
    card.dataset.show = '1';
    const nm = card.querySelector('.xpeaker-focus-quote-name'); if (nm) nm.textContent = q0.name || (q0.handle ? '@' + q0.handle : '');
    const hd = card.querySelector('.xpeaker-focus-quote-handle'); if (hd) hd.textContent = q0.handle ? '@' + q0.handle : '';
    const tx = card.querySelector('.xpeaker-focus-quote-text'); if (tx) tx.textContent = q0.text || '';
    const av = card.querySelector('.xpeaker-focus-quote-av');
    if (av) { const [c1, c2] = focusGradient(q0.handle); av.style.background = `linear-gradient(135deg,${c1},${c2})`; const ini = av.querySelector('.ini'); if (ini) ini.textContent = focusInitials(q0.name, q0.handle); }
    const avImg = av && av.querySelector('.qav'); const qImg = card.querySelector('.xpeaker-focus-quote-img');
    if (avImg) { avImg.removeAttribute('src'); avImg.style.display = 'none'; }
    if (qImg) { qImg.removeAttribute('src'); qImg.style.display = 'none'; }
    clearTimeout(focusQuoteTimer);
    let tries = 0;
    const poll = () => {
      if (!focusEl || focusCurrentEl !== el) return;
      const q = extractQuote(el); if (!q) return;
      if (avImg && q.avatar) { avImg.src = q.avatar.replace(/_(?:normal|bigger|mini|x96|reasonably_small)\.(\w+)/i, '_x96.$1'); avImg.style.display = 'block'; }
      if (qImg && q.image) { qImg.src = q.image.replace(/([?&]name=)[^&]+/, '$1small'); qImg.style.display = 'block'; }
      if (!q.avatar && tries++ < 8) focusQuoteTimer = setTimeout(poll, 200);
    };
    poll();
  }
  // Show the Follow pill only when we've CONFIRMED the author isn't followed.
  // X's follow flag can land a beat after the tweet renders (notably on profile
  // pages), so retry while extractFollowState is null rather than defaulting hidden.
  function applyFocusFollow(el, handle) {
    const fbtn = focusEl && focusEl.querySelector('.xpeaker-focus-follow');
    if (!fbtn) return;
    fbtn.dataset.state = ''; fbtn.textContent = 'Follow';
    const h = (handle || '').toLowerCase();
    clearTimeout(focusFollowTimer);
    let tries = 0;
    const evalState = () => {
      if (!focusEl || focusCurrentEl !== el) return;
      let st = extractFollowState(liveArticle(el) || el);
      if (st === null && h) { // reader's node can be detached (esp. profile pages) → read state off any live tweet by the same author
        const alt = getTimelineTweets().find((a) => { const n = a.querySelector('[data-testid="User-Name"]'); return n && n.innerText.toLowerCase().includes('@' + h); });
        if (alt) st = extractFollowState(alt);
      }
      if (st === null && tries++ < 10) { focusFollowTimer = setTimeout(evalState, 250); return; }
      fbtn.dataset.show = st === false ? '1' : '0';
    };
    evalState();
  }

  // ---- mood ring: ease the ambient field to the current post's emotion --------
  // 7 emotions from emotion-english-distilroberta (see experiments/FINDINGS.md).
  const MOOD = {
    joy:      { rgb: [0.97, 0.79, 0.22], hex: '#f6c945' }, // warm gold
    surprise: { rgb: [0.98, 0.55, 0.78], hex: '#fb8ec6' }, // pink
    neutral:  { rgb: [0.44, 0.48, 0.57], hex: '#727a88' }, // slate
    sadness:  { rgb: [0.28, 0.56, 0.90], hex: '#478fe6' }, // blue
    fear:     { rgb: [0.56, 0.36, 0.93], hex: '#8f5cee' }, // violet
    anger:    { rgb: [0.90, 0.24, 0.31], hex: '#e63d4f' }, // red
    disgust:  { rgb: [0.44, 0.73, 0.36], hex: '#6fbb5c' }, // green
  };
  function focusClassify(text) {
    return new Promise((resolve) => {
      if (!contextValid() || !text) { resolve(null); return; }
      try {
        chrome.runtime.sendMessage({ t: 'classify', text }, (res) => {
          if (chrome.runtime.lastError || !res || !res.ok) { resolve(null); return; }
          resolve(res.result || null);
        });
      } catch (e) { resolve(null); }
    });
  }
  async function applyFocusMood(el, text) {
    const lbl = focusEl && focusEl.querySelector('.xpeaker-focus-mood');
    const clear = () => { focusLastMood = null; if (focusScene) focusScene.setMood(null); if (lbl) lbl.dataset.show = '0'; if (focusEl) focusEl.dataset.mood = '0'; };
    if (!settings.moodRing || !text) { clear(); return; }
    const ranked = await focusClassify(text);
    if (!focusEl || focusCurrentEl !== el) return;         // tweet advanced → abandon this result
    const top = ranked && ranked[0];
    if (!top || !MOOD[top.label]) { clear(); return; }
    const m = MOOD[top.label];
    const amt = top.label === 'neutral' ? 0.14 : (0.34 + 0.42 * top.score); // confidence-scaled; neutral barely tints
    focusLastMood = { rgb: m.rgb, hex: m.hex, amt, label: top.label, score: top.score }; // remembered so a scene swap can re-apply it
    if (focusScene) focusScene.setMood(focusLastMood);
    focusEl.style.setProperty('--xp-mood', m.hex); // drives the edge vignette + pill glow
    focusEl.dataset.mood = '1';
    if (lbl) {
      lbl.dataset.show = '1';
      const dot = lbl.querySelector('.dot'); if (dot) { dot.style.background = m.hex; dot.style.boxShadow = '0 0 10px 1px ' + m.hex; }
      const txt = lbl.querySelector('.txt'); if (txt) txt.textContent = 'mood: ' + top.label;
    }
  }

  // -------- GLSL background shaders (data, not code) --------------------------
  // A background "shader" is just a fragment-shader string (+ a name/credit). The loader
  // below compiles any of them onto ONE shared WebGL canvas and feeds a fixed uniform set,
  // so a new shader is a cheap data drop and author "signature" shaders can hot-swap the
  // fragment in place (no context teardown). GLSL text is compiled, not eval'd → CSP-safe
  // on x.com. Every shader gets these uniforms + helpers for free:
  const GLSL_HEADER = [
    'precision highp float;',
    'uniform vec2 u_res;',      // canvas size (px)
    'uniform float u_time;',    // seconds
    'uniform float u_pulse;',   // 1 on each new tweet, decays to 0
    'uniform vec3 u_mood;',     // current mood colour (0..1)
    'uniform float u_moodAmt;', // tint strength (0..0.65; 0 when the mood ring is off)
    'uniform vec2 u_mouse;',    // cursor position, normalised 0..1 (y up); centre (0.5,0.5) when idle
    'uniform vec3 u_brand;',    // brand colour for the ticker shader (0..1); white when unused
    'uniform float u_trend;',   // market trend for the ticker shader: -1 bear .. +1 bull; 0 flat
    'uniform float u_ticker;',  // ticker enrichment amount 0..1 (eases in when a price card lands)
    'uniform sampler2D u_logo;',// the asset's brand logo, bound when u_hasLogo > 0.5
    'uniform float u_hasLogo;', // 1.0 when a logo texture is bound, else 0.0
    '#define PI 3.14159265',
    '#define TAU 6.28318530',
    'float hash(vec2 p){p=fract(p*vec2(123.34,345.45));p+=dot(p,p+34.345);return fract(p.x*p.y);}',
    'float noise(vec2 p){vec2 i=floor(p),f=fract(p);vec2 u=f*f*(3.0-2.0*f);float a=hash(i),b=hash(i+vec2(1.0,0.0)),c=hash(i+vec2(0.0,1.0)),d=hash(i+vec2(1.0,1.0));return mix(mix(a,b,u.x),mix(c,d,u.x),u.y);}',
    'float fbm(vec2 p){float v=0.0,a=0.5;for(int i=0;i<6;i++){v+=a*noise(p);p*=2.03;a*=0.5;}return v;}',
    'mat2 rot(float a){float s=sin(a),c=cos(a);return mat2(c,-s,s,c);}',
    'vec3 applyMood(vec3 col,float k){return mix(col,u_mood*k,u_moodAmt);}', // convention: tint toward the mood
    '',
  ].join('\n');

  // Base pack — pickable in Settings / the dock. Each: { id, label, author, glsl (main) }.
  const SHADER_AURORA = { id: 'aurora', label: 'Aurora', author: '@claudeai', tickerMode: true, glsl: [
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/u_res.xy; vec2 p=uv; p.x*=u_res.x/u_res.y; p*=1.6;',
    ' float t=u_time*0.05;',
    ' vec2 q=vec2(fbm(p+vec2(0.0,t)),fbm(p+vec2(5.2,1.3)-t));',
    ' vec2 r=vec2(fbm(p+2.0*q+vec2(1.7,9.2)+0.15*t),fbm(p+2.0*q+vec2(8.3,2.8)-0.12*t));',
    ' float f=fbm(p+2.6*r+t*0.4);',
    ' vec3 col=vec3(0.015,0.015,0.03);',
    ' col=mix(col,vec3(0.24,0.18,0.70),smoothstep(0.25,0.95,f));',
    ' col=mix(col,vec3(0.06,0.60,0.62),smoothstep(0.30,0.95,length(r)*0.62));',
    ' col=mix(col,vec3(0.52,0.22,0.86),smoothstep(0.45,1.05,q.x*q.y*2.2));',
    ' col*=0.5+0.5*f;',
    ' col=mix(col,u_mood*(0.28+0.9*f)*(0.75+0.4*length(q)),u_moodAmt);',
    ' col+=0.05*u_pulse*(vec3(0.52,0.22,0.86)+vec3(0.06,0.60,0.62));',
    ' col*=smoothstep(1.15,0.15,distance(uv,vec2(0.5,0.46)))*0.92;',
    ' if(u_ticker>0.001){',
    '  vec3 tcol=u_trend>=0.0?vec3(0.15,0.9,0.45):vec3(0.95,0.25,0.32);',
    '  col=mix(col,col*0.55+tcol*(0.45+0.5*f),u_ticker*0.6);',
    '  if(u_hasLogo>0.5){',
    '   vec2 luv=(uv-vec2(0.5,0.46))*vec2(u_res.x/u_res.y,1.0)/0.42+0.5;',
    '   vec4 lg=texture2D(u_logo,clamp(luv,0.0,1.0));',
    '   float edge=smoothstep(0.0,0.12,luv.x)*smoothstep(1.0,0.88,luv.x)*smoothstep(0.0,0.12,luv.y)*smoothstep(1.0,0.88,luv.y);',
    '   float lum=max(lg.r,max(lg.g,lg.b));',                            // brightness masks out the logo-tile background, keeps the mark
    '   float m=edge*lg.a*smoothstep(0.16,0.55,lum)*(0.45+0.6*f);',
    '   col=mix(col,lg.rgb*1.1,m*u_ticker*0.7);',
    '  }',
    ' }',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };
  const SHADER_PLASMA = { id: 'plasma', label: 'Plasma', author: '@claudeai', glsl: [
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/u_res.xy; vec2 p=(uv-0.5); p.x*=u_res.x/u_res.y; p*=3.0;',
    ' float t=u_time*0.5;',
    ' float v=sin(p.x+t)+sin(p.y+t*1.1)+sin((p.x+p.y)*0.7+t*0.9)+sin(length(p)*1.4-t*1.3); v*=0.25;',
    ' vec3 col=0.5+0.5*cos(6.2831*(v+vec3(0.0,0.33,0.66))+t*0.2);',
    ' col*=vec3(0.4,0.35,0.6);',
    ' col=applyMood(col,0.45+0.55*(0.5+0.5*v));',
    ' col+=0.06*u_pulse;',
    ' col*=smoothstep(1.25,0.15,distance(uv,vec2(0.5,0.46)))*0.9;',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };
  const SHADER_NEBULA = { id: 'nebula', label: 'Nebula', author: '@claudeai', glsl: [
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/u_res.xy; vec2 p=uv; p.x*=u_res.x/u_res.y; p*=2.2;',
    ' float t=u_time*0.025;',
    ' float n=pow(fbm(p*1.5+vec2(t,t*0.6)),1.8);',
    ' vec3 col=vec3(0.02,0.02,0.05);',
    ' col=mix(col,vec3(0.18,0.10,0.42),n);',
    ' col=mix(col,vec3(0.10,0.35,0.50),fbm(p*2.0-vec2(t))*n);',
    ' col=applyMood(col+n*0.12,0.3+0.7*n);',
    ' vec2 g=fract(p*8.0)-0.5; float s=hash(floor(p*8.0));',
    ' col+=smoothstep(0.06,0.0,length(g))*step(0.93,s)*(0.6+0.4*sin(u_time*4.0+s*40.0));',
    ' col*=smoothstep(1.35,0.2,distance(uv,vec2(0.5,0.46)));',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };

  const SHADER_TUNNEL = { id: 'tunnel', label: 'Tunnel', author: '@claudeai', glsl: [
    'void main(){',
    ' vec2 p=(gl_FragCoord.xy-0.5*u_res.xy)/u_res.y;',
    ' p+=(u_mouse-0.5)*0.6;',                       // cursor steers the flight
    ' float r=length(p), a=atan(p.y,p.x); float t=u_time*0.6;',
    ' vec2 tc=vec2(a*1.9, 0.25/r + t);',            // polar tunnel coords: angle + depth
    ' float f=fbm(tc*3.0); float g=fbm(tc*6.0+t);',
    ' vec3 col=mix(vec3(0.02,0.02,0.06),vec3(0.4,0.3,0.8),f);',
    ' col=mix(col,vec3(0.1,0.5,0.6),g*0.6);',
    ' col*=r*2.0;',                                  // dark vanishing point, bright walls
    ' col=applyMood(col,0.35+0.5*f);',
    ' col+=0.08*u_pulse;',
    ' col*=smoothstep(1.4,0.05,r);',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };
  const SHADER_KALEIDO = { id: 'kaleido', label: 'Kaleidoscope', author: '@claudeai', glsl: [
    'void main(){',
    ' vec2 p=(gl_FragCoord.xy-0.5*u_res.xy)/u_res.y; float t=u_time*0.25;',
    ' p*=rot(t*0.3);',
    ' float r=length(p), a=atan(p.y,p.x); float seg=TAU/8.0;',
    ' a=mod(a,seg); a=abs(a-seg*0.5);',             // 8-fold mirror symmetry
    ' p=vec2(cos(a),sin(a))*r + (u_mouse-0.5)*0.4;',
    ' float f=fbm(p*4.0+t);',
    ' float d=fbm(p*9.0-t*0.7);',                   // fine detail layer
    ' float edge=smoothstep(0.44,0.56,f);',         // crisp threshold → hard edges
    ' float grain=smoothstep(0.52,0.64,d);',        // crisp speckle
    ' vec3 col=0.5+0.5*cos(TAU*(f*1.6+vec3(0.0,0.33,0.66))+t*0.4);',
    ' col=mix(col*0.28,col*1.35,edge);',            // high-contrast light/dark
    ' col+=grain*0.4;',                             // bright crisp specks
    ' col=applyMood(col,0.4+0.45*f);',
    ' col+=0.08*u_pulse;',
    ' col*=smoothstep(1.3,0.08,r);',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };
  const SHADER_JULIA = { id: 'julia', label: 'Fractal', author: '@claudeai', glsl: [
    'void main(){',
    ' vec2 uv=(gl_FragCoord.xy-0.5*u_res.xy)/u_res.y*2.4;',
    ' vec2 m=(u_mouse-0.5);',
    ' vec2 c=vec2(0.36+0.1*sin(u_time*0.2)+m.x*0.3, 0.36+0.1*cos(u_time*0.17)+m.y*0.3);',
    ' vec2 z=uv; float it=0.0; const float N=48.0;',
    ' for(int i=0;i<48;i++){ z=vec2(z.x*z.x-z.y*z.y,2.0*z.x*z.y)+c; if(dot(z,z)>16.0) break; it+=1.0; }',
    ' float f=it/N;',
    ' vec3 col=0.5+0.5*cos(6.2831*(f*2.0+vec3(0.0,0.4,0.7))+u_time*0.1);',
    ' col*=vec3(0.6,0.5,0.8)*smoothstep(0.0,0.02,f)*(1.0-smoothstep(0.92,1.0,f));', // dark inside + far-out
    ' col=applyMood(col,0.4+0.4*f);',
    ' col+=0.06*u_pulse;',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };

  // Curated import — a Kleinian/IFS fractal raymarch adapted from a twigl "geekest"
  // (WebGL2/300-es) shader into our WebGL1 convention: FC/r/t → gl_FragCoord/u_res/
  // u_time, rotate2D → rot, round() → floor(x+.5), the float raymarch loop → a bounded
  // int loop (100 steps trimmed to 64 for perf), comma-ops split for defined eval order,
  // then coloured + mood/mouse-wired. A hand-reviewed port, not blind ingestion.
  const SHADER_KLEINIAN = { id: 'kleinian', label: 'Kleinian', author: '@zozuar', creditUrl: 'https://x.com/zozuar/status/1512791605593653258', heavy: true, glsl: [
    'void main(){',
    ' vec2 r=u_res.xy; vec4 o=vec4(0.0);',
    ' float i=0.0,s=0.0,e=0.0;',
    ' vec3 p=vec3(0.0),q=vec3(0.0),d=vec3((gl_FragCoord.xy-0.5*r)/r.y,-1.0);',
    ' d.xy+=(u_mouse-0.5)*0.4;',                         // cursor tilts the camera
    ' for(int k=0;k<64;k++){',
    '  i+=1.0;',
    '  p=q+=(i<50.0? d*e : (p-p+1e-4+e));',
    '  p.z+=7.0;',
    '  o+=sqrt(e)/70.0;',
    '  p.xz*=rot(u_time/8.0);',
    '  s=length(p);',
    '  p=vec3(log(s),atan(p.y,p.x),sin(u_time/4.0+p.z/s));',
    '  s=1.0;',
    '  for(int j=0;j<6;j++){',
    '   e=PI/min(dot(p,p),0.8);',
    '   s*=e;',
    '   p=abs(p)*e-3.0;',
    '   p.y-=floor(p.y+0.5);',                            // round() polyfill
    '  }',
    '  e=length(p)/s;',
    ' }',
    ' float g=o.r;',                                      // scalar-accumulated glow (grayscale)
    ' vec3 col=mix(vec3(0.04,0.06,0.14),vec3(0.6,0.75,1.0),clamp(g*1.1,0.0,1.0));',
    ' col+=pow(clamp(g,0.0,2.0),1.6)*vec3(0.7,0.5,1.0)*0.55;', // glowier core
    ' col=applyMood(col,0.4);',
    ' col+=0.06*u_pulse;',
    ' col=1.0-exp(-col*1.3);',                            // soft tonemap: brighter mids, highlights roll off (no harsh clip)
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };

  // Author signature shaders — fire when THAT person's post is read (in anyone's feed),
  // then revert. Keyed by handle (lower-case). Not pickable in the menus. (Example seed.)
  const SIG_ELON = { id: 'sig-elon', label: 'Mars', author: '@elonmusk', signatureFor: ['elonmusk'], glsl: [
    'void main(){',
    ' vec2 uv=gl_FragCoord.xy/u_res.xy; vec2 p=uv; p.x*=u_res.x/u_res.y; p*=2.0;',
    ' float t=u_time*0.04; float n=fbm(p+vec2(t,0.0));',
    ' vec3 col=mix(vec3(0.06,0.02,0.01),vec3(0.55,0.16,0.05),smoothstep(0.3,0.9,n));',
    ' col=mix(col,vec3(0.9,0.5,0.2),smoothstep(0.7,1.0,fbm(p*2.0-t)));',
    ' col*=0.4+0.6*n;',
    ' col=applyMood(col,0.3);',
    ' col+=0.06*u_pulse*vec3(1.0,0.5,0.2);',
    ' col*=smoothstep(1.2,0.15,distance(uv,vec2(0.5,0.46)));',
    ' gl_FragColor=vec4(col,1.0);',
    '}',
  ].join('\n') };

  // Loader: compile any shader spec onto one WebGL canvas; swap() hot-swaps the fragment.
  function startGLSLScene(container, initialSpec) {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    let gl;
    try { gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl'); } catch (e) {}
    if (!gl) { canvas.remove(); return null; }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const mk = (type, src) => { const sh = gl.createShader(type); gl.shaderSource(sh, src); gl.compileShader(sh); return sh; };
    const vsh = mk(gl.VERTEX_SHADER, 'attribute vec2 p;void main(){gl_Position=vec4(p,0.0,1.0);}');
    let prog = null, uRes, uTime, uPulse, uMood, uMoodAmt, uMouse, uBrand, uTrend, uTicker, uLogo, uHasLogo;
    let currentSpec = null, logoTex = null, hasLogo = 0; // ticker mode: current shader + the bound brand-logo texture
    const mouse = [0.5, 0.5]; // normalised, y up; centre when idle
    const onMouse = (e) => { const r = canvas.getBoundingClientRect(); if (r.width && r.height) { mouse[0] = (e.clientX - r.left) / r.width; mouse[1] = 1 - (e.clientY - r.top) / r.height; } };
    window.addEventListener('mousemove', onMouse);
    const compile = (spec) => {
      const fsh = mk(gl.FRAGMENT_SHADER, GLSL_HEADER + '\n' + spec.glsl);
      if (!gl.getShaderParameter(fsh, gl.COMPILE_STATUS)) { console.warn('[Xpeaker] shader compile failed:', spec.id, gl.getShaderInfoLog(fsh)); gl.deleteShader(fsh); return false; }
      const p = gl.createProgram(); gl.attachShader(p, vsh); gl.attachShader(p, fsh); gl.linkProgram(p); gl.deleteShader(fsh);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) { console.warn('[Xpeaker] shader link failed:', spec.id); gl.deleteProgram(p); return false; }
      if (prog) gl.deleteProgram(prog);
      prog = p; gl.useProgram(prog); currentSpec = spec;
      const loc = gl.getAttribLocation(prog, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      uRes = gl.getUniformLocation(prog, 'u_res'); uTime = gl.getUniformLocation(prog, 'u_time'); uPulse = gl.getUniformLocation(prog, 'u_pulse');
      uMood = gl.getUniformLocation(prog, 'u_mood'); uMoodAmt = gl.getUniformLocation(prog, 'u_moodAmt');
      uMouse = gl.getUniformLocation(prog, 'u_mouse');
      uBrand = gl.getUniformLocation(prog, 'u_brand'); uTrend = gl.getUniformLocation(prog, 'u_trend');
      uTicker = gl.getUniformLocation(prog, 'u_ticker'); uLogo = gl.getUniformLocation(prog, 'u_logo'); uHasLogo = gl.getUniformLocation(prog, 'u_hasLogo');
      return true;
    };
    if (!compile(initialSpec)) { canvas.remove(); return null; }
    let dprCap = Math.min(window.devicePixelRatio || 1, 2);
    if (initialSpec && initialSpec.heavy) dprCap *= 0.6; // heavy raymarchers render at reduced res so they don't saturate the GPU and starve TTS
    try { if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) dprCap = Math.min(dprCap, 1); } catch (e) {} // lighter for reduced-motion
    const onResize = () => { canvas.width = Math.floor(canvas.clientWidth * dprCap); canvas.height = Math.floor(canvas.clientHeight * dprCap); gl.viewport(0, 0, canvas.width, canvas.height); };
    onResize(); window.addEventListener('resize', onResize);
    const st = { pulse: 0, raf: 0, stopped: false, mood: [0.4, 0.3, 0.7], moodAmt: 0, moodTarget: [0.4, 0.3, 0.7], moodAmtTarget: 0, brand: [1, 1, 1], trend: 0, brandTarget: [1, 1, 1], trendTarget: 0, ticker: 0, tickerTarget: 0 };
    const setLogoTexture = (img) => {
      if (!img) { hasLogo = 0; return; }
      try {
        if (!logoTex) logoTex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, logoTex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img); // CORS-clean logo → uploadable
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        hasLogo = 1;
      } catch (e) { hasLogo = 0; }
    };
    const ease = (a, b) => a + (b - a) * 0.05;
    const t0 = performance.now();
    const loop = () => {
      if (st.stopped) return;
      const now = performance.now();
      // Adaptive quality: if frames run slow (weak GPU / battery), drop resolution to hold FPS.
      st.frames = (st.frames || 0) + 1;
      const dt = now - (st.lastT || now); st.lastT = now;
      if (st.frames > 90) {
        if (dt > 26) { st.slow = (st.slow || 0) + 1; if (st.slow > 90 && dprCap > 0.7) { dprCap = Math.max(0.7, dprCap - 0.35); onResize(); st.slow = 0; } }
        else st.slow = Math.max(0, (st.slow || 0) - 2);
      }
      st.pulse *= 0.93; st.moodAmt = ease(st.moodAmt, st.moodAmtTarget); st.trend = ease(st.trend, st.trendTarget); st.ticker = ease(st.ticker, st.tickerTarget);
      for (let i = 0; i < 3; i++) { st.mood[i] = ease(st.mood[i], st.moodTarget[i]); st.brand[i] = ease(st.brand[i], st.brandTarget[i]); }
      gl.uniform2f(uRes, canvas.width, canvas.height);
      gl.uniform1f(uTime, (now - t0) / 1000);
      gl.uniform1f(uPulse, st.pulse);
      gl.uniform3f(uMood, st.mood[0], st.mood[1], st.mood[2]);
      gl.uniform1f(uMoodAmt, st.moodAmt);
      gl.uniform2f(uMouse, mouse[0], mouse[1]);
      gl.uniform3f(uBrand, st.brand[0], st.brand[1], st.brand[2]);
      gl.uniform1f(uTrend, st.trend);
      gl.uniform1f(uTicker, st.ticker); gl.uniform1f(uHasLogo, hasLogo);
      if (hasLogo && logoTex) { gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, logoTex); gl.uniform1i(uLogo, 0); }
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      st.raf = requestAnimationFrame(loop);
    };
    loop();
    return {
      glsl: true,
      setMood(mood) { if (mood) { st.moodTarget = mood.rgb; st.moodAmtTarget = Math.max(0, Math.min(0.65, mood.amt || 0)); } else { st.moodAmtTarget = 0; } },
      pulse() { st.pulse = 1; },
      setTicker(info) { // enrich only if the current shader opts in (tickerMode); else return false → tint fallback
        if (!info) { st.tickerTarget = 0; return false; }
        if (!currentSpec || !currentSpec.tickerMode) return false;
        st.tickerTarget = 1; st.trendTarget = info.trend; st.brandTarget = info.rgb || [1, 1, 1];
        setLogoTexture(info.logo);
        return true;
      },
      swap(spec) { compile(spec); }, // hot-swap the fragment on the same context (author signatures / ticker)
      destroy() { st.stopped = true; cancelAnimationFrame(st.raf); window.removeEventListener('resize', onResize); window.removeEventListener('mousemove', onMouse); try { if (logoTex) gl.deleteTexture(logoTex); const ext = gl.getExtension('WEBGL_lose_context'); if (ext) ext.loseContext(); } catch (e) {} canvas.remove(); },
    };
  }

  // Scene #2 — Matrix rain (2D canvas). Falling glyph columns whose colour is the
  // current mood (classic green when no mood); each new-tweet pulse boosts fall speed.
  function startMatrixScene(container) {
    const canvas = document.createElement('canvas');
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return null; }
    const GLYPHS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモ0123456789ΔΣΞ<>*+'.split('');
    const rnd = (a) => a[(Math.random() * a.length) | 0];
    const DEFAULT = [90, 230, 130]; // classic matrix green
    let W = 0, H = 0, cell = 15, cols = 0, rows = 0, col = [];
    let cur = DEFAULT.slice(), tgt = DEFAULT.slice(), pulse = 0, raf = 0, stopped = false;
    const onResize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      W = canvas.width = Math.floor(canvas.clientWidth * dpr);
      H = canvas.height = Math.floor(canvas.clientHeight * dpr);
      cell = Math.round(15 * dpr);
      cols = Math.ceil(W / cell); rows = Math.ceil(H / cell);
      col = Array.from({ length: cols }, () => ({ y: -Math.random() * rows, sp: 0.22 + Math.random() * 0.5, tk: Math.random() }));
      ctx.fillStyle = '#05060a'; ctx.fillRect(0, 0, W, H);
    };
    onResize(); window.addEventListener('resize', onResize);
    const ease = (a, b, k) => a + (b - a) * (k || 0.045);
    // Ticker state (a pure function of the price card): eased tAmt 0→1 takes the rain from
    // mood-only to the asset's bull/bear version — trend colour, direction, speed, glyphs, logo.
    const BULL = [60, 230, 120], BEAR = [240, 70, 80];
    let tAmt = 0, tAmtT = 0, trend = 0, mag = 0, tChars = null, logoImg = null;
    const loop = () => {
      if (stopped) return;
      pulse *= 0.94;
      tAmt = ease(tAmt, tAmtT, 0.03);
      const bull = trend >= 0, trend3 = bull ? BULL : BEAR;
      for (let i = 0; i < 3; i++) cur[i] = ease(cur[i], tgt[i]);
      ctx.fillStyle = 'rgba(5,6,10,0.08)'; ctx.fillRect(0, 0, W, H); // fade → trails
      if (logoImg && tAmt > 0.01) { // brand logo faint behind the rain. Re-stamped each frame; since the trail-fade only
        // removes ~8%/frame, the per-frame alpha must be tiny (≈ target·fade) or the logo accumulates to solid.
        const sz = Math.min(W, H) * 0.5;
        ctx.save(); ctx.globalAlpha = 0.014 * tAmt; // ≈ 0.18·0.08 → settles at a ~18% watermark
        try { ctx.drawImage(logoImg, (W - sz) / 2, (H - sz) / 2, sz, sz); } catch (e) {}
        ctx.restore();
      }
      ctx.font = '600 ' + cell + 'px ui-monospace, "SF Mono", Menlo, monospace';
      ctx.textBaseline = 'top';
      const r = (cur[0] + (trend3[0] - cur[0]) * tAmt) | 0, g = (cur[1] + (trend3[1] - cur[1]) * tAmt) | 0, b = (cur[2] + (trend3[2] - cur[2]) * tAmt) | 0; // mood colour → trend colour
      const boost = 1 + 1.8 * pulse;
      const spd = 1 + tAmt * mag * 2.4;                 // bigger % move → faster rain
      const dirSign = (bull && tAmt > 0.55) ? -1 : 1;   // bull takeover → the rain reverses and rises
      const tkFrac = tAmt * 0.35;                       // share of columns spelling the ticker instead of katakana
      for (let i = 0; i < cols; i++) {
        const c = col[i], yy = Math.floor(c.y) * cell;
        if (c.y >= 0 && yy <= H) {
          ctx.fillStyle = `rgba(${Math.min(255, r + 110)},${Math.min(255, g + 110)},${Math.min(255, b + 110)},0.92)`; // bright head
          ctx.fillText((tChars && c.tk < tkFrac) ? rnd(tChars) : rnd(GLYPHS), i * cell, yy);
        }
        c.y += c.sp * boost * spd * dirSign;
        if (dirSign > 0) { if (c.y > rows && Math.random() > 0.97) c.y = -Math.random() * 8; }
        else if (c.y < 0 && Math.random() > 0.97) c.y = rows + Math.random() * 8;
      }
      raf = requestAnimationFrame(loop);
    };
    loop();
    return {
      setMood(mood) { tgt = mood ? [Math.round(mood.rgb[0] * 255), Math.round(mood.rgb[1] * 255), Math.round(mood.rgb[2] * 255)] : DEFAULT.slice(); },
      pulse() { pulse = 1; },
      setTicker(info) { // {trend, pct, ticker, logo(Image)} to enrich; null to ease back to mood-only. Returns true = handled.
        if (info) { tAmtT = 1; trend = info.trend; mag = Math.min(1, Math.abs(info.pct) / 5); tChars = ('$' + info.ticker).split(''); logoImg = info.logo || null; return true; }
        tAmtT = 0; return false;
      },
      destroy() { stopped = true; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize); canvas.remove(); },
    };
  }

  // Scene #3 — Doodle: draw in the empty margins. Pointer events fall through the
  // stage to this canvas (the content card / dock / nav capture their own regions, so
  // you can't draw over them). Pen colour is the current mood (not user-chosen);
  // strokes persist across tweets; double-click clears.
  function startDoodleScene(container) {
    const canvas = document.createElement('canvas');
    canvas.style.cursor = 'crosshair';
    canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return null; }
    const BG = '#0a0b12', DEF = '#9aa3b2';
    let W = 0, H = 0, dpr = 1, pen = DEF, drawing = false, lx = 0, ly = 0;
    const paint = () => { ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H); };
    const onResize = () => {
      const ndpr = Math.min(window.devicePixelRatio || 1, 2);
      const nw = Math.floor(canvas.clientWidth * ndpr), nh = Math.floor(canvas.clientHeight * ndpr);
      let saved = null; // preserve the drawing across resize
      if (W && H) { saved = document.createElement('canvas'); saved.width = W; saved.height = H; saved.getContext('2d').drawImage(canvas, 0, 0); }
      dpr = ndpr; W = canvas.width = nw; H = canvas.height = nh;
      paint();
      if (saved) ctx.drawImage(saved, 0, 0, saved.width, saved.height, 0, 0, W, H);
    };
    onResize(); window.addEventListener('resize', onResize);
    const at = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    const draw = (x, y) => {
      if (Math.hypot(x - lx, y - ly) < 80 * dpr) { // continuous segment; skip big jumps (e.g. reappearing past the card)
        ctx.strokeStyle = pen; ctx.lineWidth = 3.4 * dpr; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.shadowColor = pen; ctx.shadowBlur = 6 * dpr;
        ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(x, y); ctx.stroke();
      }
      lx = x; ly = y;
    };
    const down = (e) => { if (e.button !== 0) return; drawing = true; [lx, ly] = at(e); draw(lx, ly); };
    const move = (e) => {
      if (!drawing) return;
      if (!(e.buttons & 1)) { drawing = false; return; } // button no longer held (e.g. a missed pointerup) → stop, don't trail the cursor
      const [x, y] = at(e); draw(x, y);
    };
    const up = () => { drawing = false; };
    const clear = () => { paint(); };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    canvas.addEventListener('dblclick', clear);
    return {
      setMood(mood) { pen = mood ? mood.hex : DEF; },
      pulse() {},
      destroy() {
        canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        canvas.removeEventListener('dblclick', clear); window.removeEventListener('resize', onResize); canvas.remove();
      },
    };
  }

  // Scene #4 — Smash: click/drag in the margins to unleash a mood-assigned "weapon"
  // (you don't pick it — the emotion does): 🔥 flamethrower, 🐜 ant swarm, 🪚 chainsaw,
  // 💧 raincloud, 🎆 fireworks, 💣 demolition, 💨 smoke. Each sprays its own particles and
  // burns its own persistent damage. Margins-only routing like Doodle; double-click clears.
  function startSmashScene(container) {
    const canvas = document.createElement('canvas');
    canvas.style.cursor = 'crosshair'; canvas.style.touchAction = 'none';
    container.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) { canvas.remove(); return null; }
    const marks = document.createElement('canvas'); const mctx = marks.getContext('2d'); // persistent damage layer
    const BG = '#08080c';
    let W = 0, H = 0, dpr = 1, parts = [], drawing = false, mood = null, raf = 0, stopped = false;
    const rnd = (a) => a[(Math.random() * a.length) | 0];
    const R = (a, b) => a + Math.random() * (b - a);
    const hexA = (h, a) => { const n = parseInt(h.slice(1), 16); return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`; };
    const push = (o) => { parts.push(o); if (parts.length > 1000) parts.splice(0, parts.length - 1000); };

    // persistent damage marks (drawn to the offscreen `marks` layer)
    const scorch = (x, y, ember, rr) => { const r = (rr || 18) * dpr, g = mctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, 'rgba(0,0,0,0.55)'); g.addColorStop(0.6, hexA(ember, 0.22)); g.addColorStop(1, hexA(ember, 0)); mctx.fillStyle = g; mctx.beginPath(); mctx.arc(x, y, r, 0, 6.2832); mctx.fill(); };
    const glow = (x, y, c) => { const r = 20 * dpr, g = mctx.createRadialGradient(x, y, 0, x, y, r); g.addColorStop(0, hexA(c, 0.5)); g.addColorStop(1, hexA(c, 0)); mctx.fillStyle = g; mctx.beginPath(); mctx.arc(x, y, r, 0, 6.2832); mctx.fill(); };
    const speck = (x, y, c, rr) => { mctx.fillStyle = hexA(c, 0.5); mctx.beginPath(); mctx.arc(x, y, (rr || 2.4) * dpr, 0, 6.2832); mctx.fill(); };
    const gash = (x, y) => { mctx.strokeStyle = 'rgba(0,0,0,0.6)'; mctx.lineWidth = 2.5 * dpr; mctx.lineCap = 'round'; const a = Math.random() * 6.2832, l = R(12, 30) * dpr; mctx.beginPath(); mctx.moveTo(x - Math.cos(a) * l, y - Math.sin(a) * l); mctx.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); mctx.stroke(); };
    const wet = (x, y) => { mctx.fillStyle = 'rgba(74,144,226,0.2)'; mctx.beginPath(); mctx.ellipse(x, y + 8 * dpr, 3 * dpr, R(8, 16) * dpr, 0, 0, 6.2832); mctx.fill(); };

    // weapons: emoji, name, and fire(x,y,mark) that spawns its particles (+ optional damage)
    const WEAPONS = {
      anger: { emoji: '🔥', name: 'FLAMETHROWER', fire(x, y, m) { const C = ['#ff2e12', '#ff6a1f', '#ffab2f', '#ffe05a']; for (let i = 0; i < 15; i++) push({ x: x + R(-8, 8) * dpr, y, vx: R(-1, 1) * dpr, vy: -R(1.4, 4.6) * dpr, grav: -0.012 * dpr, life: R(0.8, 1.2), decay: 0.03, size: R(2, 5.5) * dpr, col: rnd(C), shape: 'dot', shrink: true, jit: 0.3 * dpr }); if (m) scorch(x, y, '#ff6a1f'); } },
      disgust: { emoji: '🐜', name: 'ANT SWARM', fire(x, y, m) { const C = ['#241a10', '#33260f', '#1c2a12']; for (let i = 0; i < 12; i++) { const a = Math.random() * 6.2832, s = R(0.6, 2.2) * dpr; push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 0, life: R(1.4, 2.2), decay: 0.008, size: R(1, 2.2) * dpr, col: rnd(C), shape: 'dot', dark: true, jit: 0.9 * dpr }); } if (m) speck(x, y, '#33260f', 2); } },
      fear: { emoji: '🪚', name: 'CHAINSAW', fire(x, y, m) { const C = ['#ffffff', '#ffe98a', '#ffd21f', '#c6ccd6']; for (let i = 0; i < 18; i++) { const a = Math.random() * 6.2832, s = R(3, 9) * dpr; push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 2 * dpr, grav: 0.22 * dpr, life: R(0.5, 0.8), decay: 0.05, size: R(1.4, 2.8) * dpr, col: rnd(C), shape: 'streak' }); } if (m) gash(x, y); } },
      sadness: { emoji: '💧', name: 'RAINCLOUD', fire(x, y, m) { const C = ['#4a90e2', '#6fa8ff', '#bcd9ff']; for (let i = 0; i < 12; i++) push({ x: x + R(-28, 28) * dpr, y: y - R(0, 12) * dpr, vx: R(-0.8, 0.8) * dpr, vy: R(2.5, 5.5) * dpr, grav: 0.08 * dpr, life: 0.9, decay: 0.02, size: R(1.4, 2.8) * dpr, col: rnd(C), shape: 'streak' }); if (m) wet(x, y); } },
      joy: { emoji: '🎆', name: 'FIREWORKS', fire(x, y, m) { const C = ['#f6c945', '#ff8ac2', '#8f5cee', '#ffffff', '#6fa8ff', '#6fbb5c']; for (let i = 0; i < 26; i++) { const a = Math.random() * 6.2832, s = R(2, 7.5) * dpr; push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 0.06 * dpr, life: R(0.8, 1.3), decay: 0.025, size: R(1.6, 4) * dpr, col: rnd(C), shape: 'dot', shrink: true }); } if (m) glow(x, y, '#f6c945'); } },
      surprise: { emoji: '💣', name: 'DEMOLITION', fire(x, y, m) { const C = ['#ff6a1f', '#ffd84f', '#ffffff', '#fb8ec6']; for (let i = 0; i < 30; i++) { const a = Math.random() * 6.2832, s = R(3, 10) * dpr; push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, grav: 0.1 * dpr, life: R(0.7, 1.1), decay: 0.03, size: R(2, 5) * dpr, col: rnd(C), shape: 'dot', shrink: true }); } push({ x, y, r: 2 * dpr, vr: 7 * dpr, life: 1, decay: 0.05, col: '#ffd84f', shape: 'ring' }); if (m) scorch(x, y, '#ff6a1f', 26); } },
      neutral: { emoji: '💨', name: 'SMOKE', fire(x, y, m) { const C = ['#7a828f', '#9aa3b2', '#5a616e']; for (let i = 0; i < 10; i++) push({ x: x + R(-10, 10) * dpr, y, vx: R(-1, 1) * dpr, vy: -R(0.4, 1.5) * dpr, grav: -0.005 * dpr, life: R(1, 1.6), decay: 0.014, size: R(4, 10) * dpr, col: rnd(C), shape: 'dot', dark: true, soft: true }); if (m) speck(x, y, '#5a616e', 12); } },
    };
    const cur = () => WEAPONS[mood && mood.label] || WEAPONS.neutral;

    const loop = () => {
      if (stopped) return;
      ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = BG; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(marks, 0, 0);
      for (let i = parts.length - 1; i >= 0; i--) {
        const p = parts[i];
        if (p.shape === 'ring') { p.r += p.vr; p.vr *= 0.94; p.life -= p.decay; if (p.life <= 0) { parts.splice(i, 1); continue; } ctx.globalCompositeOperation = 'lighter'; ctx.globalAlpha = Math.max(0, p.life) * 0.8; ctx.strokeStyle = p.col; ctx.lineWidth = 2.5 * dpr; ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, 6.2832); ctx.stroke(); continue; }
        if (p.jit) { p.vx += R(-1, 1) * p.jit; p.vy += R(-1, 1) * p.jit; }
        p.vy += p.grav; p.x += p.vx; p.y += p.vy; p.life -= p.decay;
        if (p.life <= 0) { parts.splice(i, 1); continue; }
        ctx.globalCompositeOperation = p.dark ? 'source-over' : 'lighter';
        ctx.globalAlpha = Math.max(0, Math.min(1, p.life)) * (p.soft ? 0.4 : 1);
        if (p.shape === 'streak') { ctx.strokeStyle = p.col; ctx.lineWidth = p.size; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - p.vx * 2.2, p.y - p.vy * 2.2); ctx.stroke(); }
        else { ctx.fillStyle = p.col; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(0.5, p.size * (p.shrink ? p.life : 1)), 0, 6.2832); ctx.fill(); }
      }
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
      raf = requestAnimationFrame(loop);
    };

    // weapon-name HUD (bottom-centre, above the overlay)
    const hud = document.createElement('div'); hud.className = 'xpeaker-focus-weapon';
    const root = container.closest('.xpeaker-focus'); if (root) root.appendChild(hud);
    const updateHud = () => { const w = cur(); hud.textContent = `${w.emoji}  ${w.name}`; };
    updateHud();

    const onResize = () => {
      const ndpr = Math.min(window.devicePixelRatio || 1, 2);
      const nw = Math.floor(canvas.clientWidth * ndpr), nh = Math.floor(canvas.clientHeight * ndpr);
      let saved = null;
      if (W && H) { saved = document.createElement('canvas'); saved.width = W; saved.height = H; saved.getContext('2d').drawImage(marks, 0, 0); }
      dpr = ndpr; W = canvas.width = nw; H = canvas.height = nh; marks.width = nw; marks.height = nh;
      if (saved) mctx.drawImage(saved, 0, 0, saved.width, saved.height, 0, 0, W, H);
    };
    onResize(); window.addEventListener('resize', onResize); loop();

    const at = (e) => { const r = canvas.getBoundingClientRect(); return [(e.clientX - r.left) * (W / r.width), (e.clientY - r.top) * (H / r.height)]; };
    let sx = 0, sy = 0;
    const down = (e) => { if (e.button !== 0) return; drawing = true; const [x, y] = at(e); sx = x; sy = y; cur().fire(x, y, true); };
    const move = (e) => { if (!drawing) return; if (!(e.buttons & 1)) { drawing = false; return; } const [x, y] = at(e); if (Math.hypot(x - sx, y - sy) > 14 * dpr) { cur().fire(x, y, true); sx = x; sy = y; } }; // throttle strikes along a drag
    const up = () => { drawing = false; };
    const clear = () => { mctx.clearRect(0, 0, W, H); parts = []; };
    canvas.addEventListener('pointerdown', down); canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
    canvas.addEventListener('dblclick', clear);
    return {
      setMood(m) { mood = m; updateHud(); },
      pulse() { const side = Math.random() < 0.5 ? R(0.06, 0.2) : R(0.8, 0.94); cur().fire(side * W, R(0.2, 0.8) * H, false); }, // a small auto-strike in a side margin each tweet (no permanent damage)
      destroy() {
        canvas.removeEventListener('pointerdown', down); canvas.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up);
        canvas.removeEventListener('dblclick', clear); window.removeEventListener('resize', onResize);
        stopped = true; cancelAnimationFrame(raf); hud.remove(); canvas.remove();
      },
    };
  }

  // Registry of Focus background scenes; each factory(container) → { setMood, pulse, destroy }.
  // Registry: GLSL data-shaders (aurora/plasma/nebula) + code scenes (matrix/doodle/smash)
  // + author-signature shaders (not pickable). Each entry: { label, make(container), glsl?,
  // spec?, signature? }. Adding a GLSL shader later = drop a spec into GLSL_PICKABLE.
  const GLSL_PICKABLE = [SHADER_AURORA, SHADER_PLASMA, SHADER_NEBULA, SHADER_TUNNEL, SHADER_KALEIDO, SHADER_JULIA, SHADER_KLEINIAN];
  const SIGNATURES = [SIG_ELON];
  const FOCUS_SCENES = {};
  GLSL_PICKABLE.forEach((spec) => { FOCUS_SCENES[spec.id] = { label: spec.label, author: spec.author, creditUrl: spec.creditUrl, glsl: true, spec, make: (c) => startGLSLScene(c, spec) }; });
  FOCUS_SCENES.matrix = { label: 'Matrix rain', author: '@claudeai', make: startMatrixScene };
  FOCUS_SCENES.doodle = { label: 'Doodle', author: '@claudeai', make: startDoodleScene };
  FOCUS_SCENES.smash = { label: 'Smash', author: '@claudeai', make: startSmashScene };
  SIGNATURES.forEach((spec) => { FOCUS_SCENES[spec.id] = { label: spec.label, glsl: true, spec, signature: true, make: (c) => startGLSLScene(c, spec) }; });
  // signature lookup by author handle (lower-case)
  const SIGNATURE_BY_HANDLE = {};
  SIGNATURES.forEach((spec) => (spec.signatureFor || []).forEach((h) => { SIGNATURE_BY_HANDLE[h.toLowerCase()] = spec; }));
  const pickableScenes = () => Object.keys(FOCUS_SCENES).filter((id) => !FOCUS_SCENES[id].signature);

  // ── Ticker overlay ──────────────────────────────────────────────────────────
  // When a Focus tweet has a $cashtag, synthetically hover it to summon X's price-card
  // popover (a Premium+ feature, portaled outside the tweet), scrape name/ticker/%/logo,
  // pull a brand colour from the CORS-clean logo, and lay a "ticker mode" overlay — a
  // bull/bear brand tint (with the logo in the chip) — over WHATEVER scene is running. No
  // card (non-Premium, translated, or X didn't card it) → plain scene, no effect. No table.
  let focusSigActive = false;   // did a signature claim this tweet? (ticker defers to it)
  let focusTickerToken = 0;     // bumps each tweet; aborts a stale async scrape
  const focusTickerColors = {}; // ticker → [r,g,b], cached for the session
  const tickerSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const CASHTAG_RE = /^\$[A-Za-z]{1,6}$/;
  const cashtagLinks = (el) => [...el.querySelectorAll('a')].filter((a) => CASHTAG_RE.test((a.textContent || '').trim()));
  const HOVER_IN = ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'mousemove', 'pointermove'];
  const HOVER_OUT = ['pointerout', 'pointerleave', 'mouseout', 'mouseleave'];
  function fireHover(elm, types, x, y) {
    const o = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
    types.forEach((t) => { try { elm.dispatchEvent(t[0] === 'p' ? new PointerEvent(t, o) : new MouseEvent(t, o)); } catch (e) {} });
  }
  // The portaled price-card popover, if X has rendered one (it lives OUTSIDE any <article>).
  function findCardPopover() {
    const el = [...document.querySelectorAll('span,div')].find((n) => {
      const t = n.textContent || '';
      return /[+\-]\d+(?:\.\d+)?%/.test(t) && /NASDAQ|NYSE|Crypto|·\s*\$/i.test(t) && t.length < 320 && !n.closest('article');
    });
    if (!el) return null;
    let box = el; for (let i = 0; i < 12 && box.parentElement && !box.querySelector('img'); i++) box = box.parentElement;
    return box.querySelector('img') ? box : null;
  }
  function dismissCards(el) {
    (el ? cashtagLinks(el) : []).forEach((a) => fireHover(a, HOVER_OUT, 4, 4));
    try { document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 3, clientY: 3, view: window })); } catch (e) {}
  }
  // Hover each cashtag until X shows its card; scrape { ticker, name, pct, logoSrc } or null.
  async function readTickerCard(el, token) {
    const links = cashtagLinks(el); if (!links.length) return null;
    for (const a of links.slice(0, 3)) {
      const ticker = (a.textContent || '').trim().slice(1).toUpperCase();
      const r = a.getBoundingClientRect();
      fireHover(a, HOVER_IN, r.x + r.width / 2, r.y + r.height / 2);
      let box = null;
      for (let i = 0; i < 8; i++) { await tickerSleep(200); if (token !== focusTickerToken) { dismissCards(el); return null; } const b = findCardPopover(); if (b && (b.textContent || '').toUpperCase().indexOf(ticker) >= 0) { box = b; break; } } // must be THIS cashtag's card, not a stale popover left over from a prior hover
      if (!box) { fireHover(a, HOVER_OUT, 4, 4); continue; }
      const txt = (box.textContent || '').replace(/\s+/g, ' ').trim();
      const pm = txt.match(/([+\-]?\d+(?:\.\d+)?)\s*%/);
      const logo = box.querySelector('img');
      const out = { ticker, pct: pm ? parseFloat(pm[1]) : 0, logoSrc: (logo && (logo.currentSrc || logo.src)) || '' };
      dismissCards(el);
      return out;
    }
    return null;
  }
  // Dominant brand colour from the (CORS-clean) logo, cached by ticker.
  const focusLogoCache = {}; // src → loaded (CORS-clean) Image, reused for both colour extraction and as a scene texture
  function loadLogo(src) {
    if (!src) return Promise.resolve(null);
    if (focusLogoCache[src]) return Promise.resolve(focusLogoCache[src]);
    return new Promise((res) => {
      const im = new Image(); im.crossOrigin = 'anonymous';
      im.onload = () => { focusLogoCache[src] = im; res(im); };
      im.onerror = () => res(null);
      im.src = src;
    });
  }
  // Dominant brand colour from an already-loaded logo, cached by ticker (sync).
  function logoColor(ticker, img) {
    if (focusTickerColors[ticker]) return focusTickerColors[ticker];
    if (!img) return null;
    let rgb = null;
    try {
      const c = document.createElement('canvas'); c.width = c.height = 24;
      const g = c.getContext('2d'); g.drawImage(img, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;
      let br = 0, bg = 0, bb = 0, bs = -1, ar = 0, ag = 0, ab = 0, n = 0;
      for (let p = 0; p < d.length; p += 4) {
        const R = d[p], G = d[p + 1], B = d[p + 2], A = d[p + 3];
        if (A < 40) continue;
        const mx = Math.max(R, G, B), sat = mx - Math.min(R, G, B);
        if (mx > 24 && mx < 250) { ar += R; ag += G; ab += B; n++; }   // average skips near-black/white
        if (sat > bs && mx > 40) { bs = sat; br = R; bg = G; bb = B; } // most-saturated pixel = brand hue
      }
      if (bs > 40) rgb = [br / 255, bg / 255, bb / 255];
      else if (n) rgb = [ar / n / 255, ag / n / 255, ab / n / 255];
    } catch (e) { rgb = null; }
    if (rgb) focusTickerColors[ticker] = rgb;
    return rgb;
  }
  // Per-tweet: scrape the card (async) and show/hide the overlay. Guarded by focusTickerToken.
  async function applyTicker(el) {
    const my = ++focusTickerToken;
    hideTicker();                                   // reset to the mood-only base first — it shows, then the ticker takes over
    if (!focusEl || settings.tickerShaders === false || focusSigActive || !cashtagLinks(el).length) return;
    const card = await readTickerCard(el, my);
    if (my !== focusTickerToken || !card) return;   // a newer tweet took over, or no card → stays base
    const img = await loadLogo(card.logoSrc);
    if (my !== focusTickerToken) return;
    enrichTicker(card, img, logoColor(card.ticker, img));
  }
  // Apply the ticker state: the chip always; the visual via the scene's OWN ticker mode
  // (setTicker — e.g. Matrix rain goes green/red, reverses, weaves in the ticker + logo)
  // if it has one, else the generic tint overlay.
  function enrichTicker(card, img, rgb) {
    if (!focusEl) return;
    setTickerChip(card);
    const handled = focusScene && focusScene.setTicker && focusScene.setTicker({ trend: card.pct >= 0 ? 1 : -1, pct: card.pct, ticker: card.ticker, logo: img, rgb });
    if (handled) hideTint(); else showTint(card, rgb); // scene rendered it → no DOM tint; else fall back to the tint
  }
  function setTickerChip(card) {
    const lbl = focusEl && focusEl.querySelector('.xpeaker-focus-sig'); if (!lbl) return;
    const bull = card.pct >= 0;
    lbl.dataset.show = '1'; lbl.dataset.kind = bull ? 'bull' : 'bear'; lbl.textContent = '';
    if (card.logoSrc) { const im = document.createElement('img'); im.className = 'xpeaker-focus-sig-logo'; im.src = card.logoSrc; lbl.appendChild(im); }
    lbl.appendChild(document.createTextNode(`$${card.ticker} ${bull ? '▲' : '▼'} ${(card.pct > 0 ? '+' : '') + card.pct}%`));
  }
  function showTint(card, rgb) { // fallback for scenes without a bespoke ticker mode: a DOM tint over the scene
    const wrap = focusEl && focusEl.querySelector('.xpeaker-focus-ticker'); if (!wrap) return;
    const bull = card.pct >= 0;
    const dir = [bull ? 0.15 : 0.95, bull ? 0.85 : 0.2, bull ? 0.4 : 0.28];   // green (bull) / red (bear)
    const tint = rgb ? rgb.map((v, i) => v * 0.32 + dir[i] * 0.68) : dir;      // mostly the trend colour (the logo carries the brand)
    wrap.style.setProperty('--xp-ticker', 'rgb(' + tint.map((v) => Math.round(v * 255)).join(',') + ')');
    wrap.style.setProperty('--xp-ticker-a', (0.12 + Math.min(1, Math.abs(card.pct) / 5) * 0.33).toFixed(3)); // magnitude-scaled
    wrap.dataset.show = '1'; focusEl.dataset.ticker = '1';
  }
  function hideTint() { const wrap = focusEl && focusEl.querySelector('.xpeaker-focus-ticker'); if (wrap) wrap.dataset.show = '0'; if (focusEl) focusEl.dataset.ticker = '0'; }
  function hideTicker() {
    if (!focusEl) return;
    hideTint();
    if (focusScene && focusScene.setTicker) focusScene.setTicker(null); // ease the scene's ticker mode back to base
    const lbl = focusEl.querySelector('.xpeaker-focus-sig');
    if (lbl && lbl.dataset.kind && lbl.dataset.kind !== 'sig') { lbl.dataset.show = '0'; lbl.dataset.kind = ''; } // don't clobber a signature chip
  }

  function makeScene(id, container) {
    const s = FOCUS_SCENES[id] || FOCUS_SCENES.aurora;
    return s.make(container) || (s !== FOCUS_SCENES.aurora ? FOCUS_SCENES.aurora.make(container) : null);
  }
  function makeFocusScene(container) { activeSceneId = settings.focusScene; return makeScene(settings.focusScene, container); }

  // Resolve which scene this post gets: an author signature shader (if any) else the user's
  // chosen scene. GLSL→GLSL is a cheap fragment hot-swap; else a full swap. Sets focusSigActive
  // so the ticker overlay defers to a signature, and drives the signature credit chip.
  function applyTweetScene(el, handle, text) {
    if (!focusEl || !focusScene) return;
    const sig = settings.signatureShaders !== false ? SIGNATURE_BY_HANDLE[(handle || '').toLowerCase()] : null;
    focusSigActive = !!sig;
    const wantId = sig ? sig.id : settings.focusScene;
    if (wantId !== activeSceneId) {
      const bg = focusEl.querySelector('.xpeaker-focus-bg');
      const target = FOCUS_SCENES[wantId];
      if (focusScene.swap && target && target.glsl) focusScene.swap(target.spec); // in-place fragment hot-swap
      else { // full swap (crossing a code scene): mount the new, keep the old drawing until it's up
        const old = focusScene;
        focusScene = makeScene(wantId, bg);
        if (old && old !== focusScene) requestAnimationFrame(() => requestAnimationFrame(() => { try { old.destroy(); } catch (e) {} }));
      }
      activeSceneId = wantId;
      if (focusScene) focusScene.setMood(focusLastMood);
    }
    const lbl = focusEl.querySelector('.xpeaker-focus-sig');
    if (lbl) { if (sig) { lbl.dataset.show = '1'; lbl.dataset.kind = 'sig'; lbl.textContent = `✨ ${sig.author} · ${sig.label}`; } else if (lbl.dataset.kind === 'sig') { lbl.dataset.show = '0'; lbl.dataset.kind = ''; } }
  }

  // Fit the tweet text to one screen: shrink the font from a base size down to a
  // readable floor; if it STILL overflows (very long / expanded posts), let the
  // stage scroll. Short tweets keep the big dramatic type; long ones stay legible.
  function fitFocusText() {
    if (!focusEl) return;
    const stage = focusEl.querySelector('.xpeaker-focus-stage');
    const content = focusEl.querySelector('.xpeaker-focus-content');
    const tx = focusEl.querySelector('.xpeaker-focus-text');
    if (!stage || !content || !tx) return;
    stage.dataset.scroll = '0'; // measure in the non-scrolling layout
    const cs = getComputedStyle(stage);
    const availH = stage.clientHeight - parseFloat(cs.paddingTop || 0) - parseFloat(cs.paddingBottom || 0);
    const FLOOR = 22;
    // With a photo hero present the caption is secondary, so start smaller.
    const hasMedia = content.dataset.media === '1';
    let size = hasMedia ? Math.max(20, Math.min(32, window.innerWidth * 0.024))
                        : Math.max(26, Math.min(52, window.innerWidth * 0.04));
    tx.style.fontSize = size + 'px';
    let guard = 0;
    while (content.offsetHeight > availH && size > FLOOR && guard++ < 40) {
      size = Math.max(FLOOR, size - 2);
      tx.style.fontSize = size + 'px';
    }
    stage.dataset.scroll = content.offsetHeight > availH ? '1' : '0';
    stage.scrollTop = 0;
  }
  function onFocusResize() { if (focusActive) fitFocusText(); }

  // Idle-hide the control pill + top chrome + cursor after inactivity; any mouse
  // move brings them back (mirrors the concept's armHide/onMove).
  function focusArmHide() {
    clearTimeout(focusHideT);
    focusHideT = setTimeout(() => {
      if (!focusEl) return;
      // keep controls up while the cursor rests on an interactive control (even without moving);
      // moving off is itself a mousemove that re-arms this timer, so idle-hide still applies then.
      if (focusEl.querySelector('.xpeaker-focus-nav:hover, .xpeaker-focus-dock:hover, .xpeaker-focus-label:hover')) { focusArmHide(); return; }
      focusEl.dataset.controls = '0';
    }, 2600);
  }
  function onFocusMove() {
    if (!focusEl) return;
    if (focusEl.dataset.controls !== '1') focusEl.dataset.controls = '1';
    if (focusInteractExtend) return; // during the dwell: keep controls up (set above), no auto-hide; taps extend, not moves
    if (focusEl.dataset.done === '1') return; // keep the completion card + cursor visible
    focusArmHide();
  }

  // Render the author avatar. X lazy-mounts the profile <img> after the tweet
  // scrolls into view, so extraction at onTweetStart time often misses it — poll
  // briefly (guarded by focusCurrentEl so a stale retry can't clobber a newer
  // tweet). The initials gradient shows until/unless the image resolves.
  function applyFocusAvatar(el, name, handle) {
    if (!focusEl) return;
    const av = focusEl.querySelector('.xpeaker-focus-avatar');
    if (!av) return;
    const img = av.querySelector('.xpeaker-focus-avatar-img');
    const ini = av.querySelector('.xpeaker-focus-avatar-ini');
    const [c1, c2] = focusGradient(handle);
    av.style.background = `linear-gradient(135deg,${c1},${c2})`;
    if (ini) ini.textContent = focusInitials(name, handle);
    if (!img) return;
    img.removeAttribute('src'); img.style.display = 'none'; // reset for the new tweet
    clearTimeout(focusAvatarTimer);
    let tries = 0;
    const attempt = () => {
      if (!focusEl || focusCurrentEl !== el) return;   // focus closed or tweet advanced
      const raw = extractAvatar(el);
      if (raw) {
        const hi = raw.replace(/_(?:normal|bigger|mini|x96|reasonably_small)\.(jpg|jpeg|png|webp|gif)(?:\?.*)?$/i, '_200x200.$1');
        img.dataset.fallback = raw; img.src = hi; img.style.display = 'block';
        return;
      }
      if (tries++ < 10) focusAvatarTimer = setTimeout(attempt, 200); // ~2s for the lazy image
    };
    attempt();
  }

  // Render the tweet's photo(s) as a hero above the caption, with a dots carousel
  // that auto-advances (and is clickable) when there is more than one. Photos lazy-
  // mount like avatars, so poll briefly (guarded by focusCurrentEl). No photos ⇒
  // the media region is hidden and the tweet renders text-only.
  function renderFocusMedia(el, urls) {
    if (!focusEl || focusCurrentEl !== el) return;
    const media = focusEl.querySelector('.xpeaker-focus-media');
    const img = focusEl.querySelector('.xpeaker-focus-media-img');
    const dots = focusEl.querySelector('.xpeaker-focus-dots');
    const content = focusEl.querySelector('.xpeaker-focus-content');
    if (!media || !img || !dots || !content) return;
    let i = 0;
    const seen = new Set();
    focusMediaComplete = urls.length <= 1; // single image ⇒ no hold; multi ⇒ hold until every photo shown once
    const show = (n) => {
      i = (n + urls.length) % urls.length;
      img.src = urls[i];
      dots.querySelectorAll('span').forEach((d, k) => { d.dataset.on = k === i ? '1' : '0'; });
      seen.add(i); if (seen.size >= urls.length) focusMediaComplete = true;
      if (focusScene) focusScene.pulse();
    };
    dots.innerHTML = urls.length > 1 ? urls.map(() => '<span></span>').join('') : '';
    dots.querySelectorAll('span').forEach((d, k) => d.addEventListener('click', () => { show(k); armMediaTimer(); }));
    content.dataset.media = '1'; media.dataset.show = '1';
    show(0);
    fitFocusText();               // re-fit now that the image occupies space
    clearInterval(focusMediaTimer);
    const armMediaTimer = () => {
      clearInterval(focusMediaTimer);
      if (urls.length > 1) focusMediaTimer = setInterval(() => {
        if (!focusEl || focusCurrentEl !== el) { clearInterval(focusMediaTimer); return; }
        show(i + 1);
      }, 2200);
    };
    armMediaTimer();
  }
  function applyFocusMedia(el) {
    clearInterval(focusMediaTimer);
    const content = focusEl && focusEl.querySelector('.xpeaker-focus-content');
    const media = focusEl && focusEl.querySelector('.xpeaker-focus-media');
    const hideMedia = () => { if (media) media.dataset.show = '0'; if (content) content.dataset.media = '0'; };
    hideMedia();
    // Expect (and hold for) media only if a real photo is present or still loading;
    // video-thumbnail-only tweets render as text with no hold.
    const photoImgs = focusEl ? Array.from(el.querySelectorAll('[data-testid="tweetPhoto"] img')) : [];
    const expectPhotos = photoImgs.some((im) => { const s = im.currentSrc || im.src || ''; return !s || /pbs\.twimg\.com\/media\//.test(s); });
    if (!focusEl || !expectPhotos) { focusMediaComplete = true; return; }
    focusMediaComplete = false; // media expected — the reader holds until it resolves/cycles
    let tries = 0;
    const attempt = () => {
      if (!focusEl || focusCurrentEl !== el) return;
      const urls = extractPhotos(el);
      if (urls.length) { renderFocusMedia(el, urls); return; }
      if (tries++ < 8) focusMediaTimer = setTimeout(attempt, 200); else { hideMedia(); focusMediaComplete = true; }
    };
    attempt();
  }

  // ── Canvas-mirror spike ──────────────────────────────────────────────────
  // A video tweet's <video> is a live, same-origin (blob) element we can draw to
  // a canvas frame-by-frame — no stream URL, no manifest change. We mirror it as a
  // muted b-roll hero with a real timecode bar (currentTime/duration). X may
  // re-render/detach the node when scrolling, so the draw loop re-queries and
  // falls back gracefully. (Spike: audio two-phase / PiP / pill wiring come later.)
  function stopFocusVideo() {
    cancelAnimationFrame(focusVideoRaf); focusVideoRaf = 0;
    focusVideoPaused = false; focusVideoPausedByUser = false; focusVideoAudio = false;
    if (focusVideoEl) { try { focusVideoEl.pause(); focusVideoEl.muted = true; } catch (e) {} focusVideoEl = null; }
    const region = focusEl && focusEl.querySelector('.xpeaker-focus-video');
    if (region) region.dataset.show = '0';
  }
  // The live <video> for a tweet, resolved fresh (X swaps nodes) via findById.
  function liveVideo(el) {
    const id = tweetId(el);
    const art = (id && findById(id)) || (el && el.isConnected ? el : null);
    return art ? extractVideo(art) : null;
  }
  // A video player container/poster is present even before X lazy-mounts the <video>
  // (via IntersectionObserver after scrollIntoView). Lets us decide whether it's worth
  // waiting for the node, rather than polling on every text tweet.
  function liveVideoPending(el) {
    const id = tweetId(el);
    const art = (id && findById(id)) || (el && el.isConnected ? el : null);
    if (!art) return false;
    let qWrap = null;
    art.querySelectorAll('div[role="link"][tabindex]').forEach((w) => { if (!qWrap && w.querySelector('[data-testid="User-Name"]') && w.querySelector('[data-testid="tweetText"]')) qWrap = w; });
    for (const c of art.querySelectorAll('[data-testid="videoPlayer"], [data-testid="videoComponent"]')) { if (!(qWrap && qWrap.contains(c))) return true; }
    return false;
  }
  // Whether this tweet should play WITH SOUND (and in which order) — Focus only,
  // enabled, has a video, and short enough to be a "clip" (long videos stay b-roll).
  function focusVideoPlan(el) {
    if (!focusActive || settings.videoSound === false || focusSilenceSession) return { audio: false };
    const v = liveVideo(el);
    if (!v) return { audio: false };
    if (isFinite(v.duration) && v.duration > videoAudioMax()) return { audio: false }; // longer than the sound cap → muted b-roll only
    return { audio: true, order: settings.videoOrder || 'read' };
  }
  // Play the clip WITH SOUND from the start; resolves when it ends / is capped /
  // interrupted (next-prev-stop) / the user chooses silent at the prompt. If the
  // browser blocks unmuted autoplay, surface a one-time tap-to-enable card.
  async function focusPlayAudio(el, gen) {
    if (!liveVideo(el)) return;
    const cap = videoAudioMax(); // seconds
    focusVideoAudio = true; focusVideoPaused = false;
    let prompted = false, promptedAt = 0;
    const tryUnmute = () => { const v = liveVideo(el); if (!v) return; try { v.currentTime = 0; v.loop = false; } catch (e) {} v.muted = false; const p = v.play(); if (p && p.catch) p.catch(() => maybePrompt()); };
    const maybePrompt = () => {
      if (prompted || settings.videoSound === false || focusSilenceSession || !focusActive) return;
      prompted = true; promptedAt = Date.now();
      showAudioPrompt(
        () => { const v = liveVideo(el); if (v) { try { v.currentTime = 0; } catch (e) {} v.muted = false; v.play().catch(() => {}); } }, // gesture-bound retry
        () => { focusSilenceSession = true; } // silence this session only; user re-enables via Settings or a reload
      );
    };
    tryUnmute();
    // detect a silent block (play resolved but element stayed paused/muted)
    setTimeout(() => { if (gen === threadGen && !prompted) { const v = liveVideo(el); if (v && (v.paused || v.muted)) maybePrompt(); } }, 450);
    const startT = Date.now(); let maxT = 0;
    while (gen === threadGen && !navRequest) {
      if (isPaused) { await waitWhilePaused(); if (gen !== threadGen) break; }
      const v = liveVideo(el);
      if (!v || v.ended) break;
      // X loops autoplay clips (so 'ended' never fires) — break once it wraps back to the start after a full pass.
      if (maxT > 2 && v.currentTime + 1 < maxT) break;
      maxT = Math.max(maxT, v.currentTime);
      if (!isPaused && v.paused && !v.ended) { try { v.loop = false; v.muted = false; v.play().catch(() => {}); } catch (e) {} } // keep it rolling (picks up once the tap grants activation)
      if (isFinite(v.duration) && v.duration && v.currentTime >= Math.min(v.duration, cap) - 0.3) break;
      if ((settings.videoSound === false || focusSilenceSession) && prompted) break; // chose "keep silent"
      if (prompted && promptedAt && Date.now() - promptedAt > 25000) break; // prompt ignored → move on (silent this tweet)
      if (Date.now() - startT > (cap + 20) * 1000) break; // absolute backstop
      await sleep(150);
    }
    hideAudioPrompt();
    focusVideoAudio = false; focusVideoPaused = true; // freeze on last frame; next tweet resets via applyFocusVideo
    const v = liveVideo(el); if (v) { try { v.pause(); v.muted = true; } catch (e) {} }
  }
  function showAudioPrompt(onEnable, onSilent) {
    if (!focusEl) return;
    audioAskEnable = onEnable; audioAskSilent = onSilent;
    const c = focusEl.querySelector('.xpeaker-focus-audioask'); if (c) c.dataset.show = '1';
    focusEl.dataset.controls = '1'; clearTimeout(focusHideT);
  }
  function hideAudioPrompt() {
    const c = focusEl && focusEl.querySelector('.xpeaker-focus-audioask'); if (c) c.dataset.show = '0';
    audioAskEnable = null; audioAskSilent = null;
  }
  function applyFocusVideo(el) {
    stopFocusVideo();
    if (!focusEl) return false;
    const id = tweetId(el);
    // Re-resolve the LIVE article by id each time — X re-renders/detaches nodes, so
    // the captured `el` (and any cached <video>) goes stale; findById returns the
    // current node. Also disambiguates when several video tweets are on screen.
    const findVid = () => { const art = (id && findById(id)) || (el.isConnected ? el : null); return art ? extractVideo(art) : null; };
    if (!findVid()) return false; // not a video tweet
    const region = focusEl.querySelector('.xpeaker-focus-video');
    const canvas = focusEl.querySelector('.xpeaker-focus-video-canvas');
    const timeEl = focusEl.querySelector('.xpeaker-focus-video-time');
    const prog = focusEl.querySelector('.xpeaker-focus-video-prog');
    const vidnote = focusEl.querySelector('.xpeaker-focus-vidnote');
    const content = focusEl.querySelector('.xpeaker-focus-content');
    if (!region || !canvas || !content) return false;
    const ctx = canvas.getContext('2d');
    const fmt = (s) => { s = Math.max(0, s | 0); return ((s / 60) | 0) + ':' + String(s % 60).padStart(2, '0'); };
    let started = false, misses = 0;
    const draw = () => {
      if (!focusEl || focusCurrentEl !== el) { stopFocusVideo(); return; }
      let vid = focusVideoEl;
      if (!vid || !vid.isConnected || !vid.videoWidth) { const nv = findVid(); if (nv) focusVideoEl = vid = nv; }
      if (vid) {
        misses = 0;
        if (!started) { started = true; region.dataset.show = '1'; content.dataset.media = '1'; fitFocusText(); }
        try {
          if (!focusVideoAudio && vid.muted !== true) vid.muted = true;   // b-roll stays muted; audio phase owns muting
          if (!focusVideoAudio && !focusVideoPaused && vid.paused && !vid.ended) vid.play().catch(() => {}); // b-roll only; audio phase drives its own play (no 60fps fight)
          if (vid.playbackRate !== rate()) vid.playbackRate = rate();     // speed control drives the clip too
        } catch (e) {}
        if (vid.videoWidth) {
          const maxW = 1280, sc = vid.videoWidth > maxW ? maxW / vid.videoWidth : 1;
          const cw = Math.round(vid.videoWidth * sc), ch = Math.round(vid.videoHeight * sc);
          if (canvas.width !== cw) { canvas.width = cw; canvas.height = ch; }
          try { ctx.drawImage(vid, 0, 0, cw, ch); } catch (e) {}
          if (vid.duration && isFinite(vid.duration)) {
            if (timeEl) timeEl.textContent = fmt(vid.currentTime) + ' / ' + fmt(vid.duration);
            if (prog) prog.style.width = Math.min(100, (vid.currentTime / vid.duration) * 100) + '%';
          }
        }
        // Warn when a clip plays silently because it's over the auto-sound length cap.
        if (vidnote) {
          const overCap = settings.videoSound !== false && !focusVideoAudio && isFinite(vid.duration) && vid.duration > videoAudioMax();
          vidnote.dataset.show = overCap ? '1' : '0';
          if (overCap) { const t = vidnote.querySelector('.xpeaker-focus-vidnote-txt'); const mn = Math.round(videoAudioMax() / 60 * 10) / 10; if (t && t.textContent !== `Silent — clip over ${mn} min · Change in Settings`) t.textContent = `Silent — clip over ${mn} min · Change in Settings`; }
        }
      } else if (++misses > 300) { stopFocusVideo(); return; } // video vanished for good (~5s)
      focusVideoRaf = requestAnimationFrame(draw);
    };
    focusVideoRaf = requestAnimationFrame(draw);
    return true;
  }

  // ── Interaction pause ────────────────────────────────────────────────────
  // When enabled, after each tweet finishes we hold with a like/repost/bookmark/
  // reply bar (countdown that any interaction resets) before advancing. Actions
  // click X's own live action buttons — state lives in the testid (like↔unlike).
  const ACT_ICON = {
    like: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 21.6l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.79L12 21.6z"/></svg>',
    retweet: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 3.88l3.64 3.64-1.43 1.43-1.18-1.18V15c0 .55.45 1 1 1h4v2h-4c-1.66 0-3-1.34-3-3V7.77L2.34 8.95.91 7.52 4.5 3.88zM17.5 6h-4V4h4c1.66 0 3 1.34 3 3v7.23l1.18-1.18 1.43 1.43-3.59 3.64-3.64-3.64 1.43-1.43 1.18 1.18V7c0-.55-.45-1-1-1z"/></svg>',
    bookmark: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 3h12c.55 0 1 .45 1 1v17l-7-4.16L5 21V4c0-.55.45-1 1-1z"/></svg>',
    reply: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M4 3.5h16c.55 0 1 .45 1 1v11c0 .55-.45 1-1 1H9.5L4 21V4.5c0-.55.45-1 1-1z"/></svg>',
  };
  function liveArticle(el) { const id = tweetId(el); return (id && findById(id)) || (el && el.isConnected ? el : null); }
  function countFromLabel(btn) {
    if (!btn) return '';
    const m = (btn.getAttribute('aria-label') || '').replace(/,/g, '').match(/^(\d+)/);
    const n = m ? parseInt(m[1], 10) : 0;
    return !n ? '' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'K' : String(n);
  }
  function populateActions(el) {
    if (!focusEl) return;
    const bar = focusEl.querySelector('.xpeaker-focus-dock'); if (!bar) return;
    clearTimeout(focusRetweetTimer); // tweet changed → drop any pending retweet-disarm from the previous tweet
    focusInteractEl = el;
    const art = liveArticle(el); const q = (s) => art && art.querySelector(s);
    const set = (x, on, cntBtn) => { const b = bar.querySelector(`[data-x="${x}"]`); if (!b) return; b.dataset.on = on ? '1' : '0'; b.dataset.confirm = '0'; const c = b.querySelector('.cnt'); if (c) c.textContent = countFromLabel(cntBtn); };
    set('like', !!q('[data-testid="unlike"]'), q('[data-testid="like"]') || q('[data-testid="unlike"]'));
    set('retweet', !!q('[data-testid="unretweet"]'), q('[data-testid="retweet"]') || q('[data-testid="unretweet"]'));
    set('bookmark', !!q('[data-testid="removeBookmark"]'), null);
  }
  function doRetweet(art) {
    const already = !!art.querySelector('[data-testid="unretweet"]');
    const trigger = art.querySelector(already ? '[data-testid="unretweet"]' : '[data-testid="retweet"]');
    if (!trigger) return;
    trigger.click(); // opens X's menu (behind our overlay) — confirm item is clickable by testid
    setTimeout(() => {
      const c = document.querySelector(already ? '[data-testid="unretweetConfirm"]' : '[data-testid="retweetConfirm"]');
      if (c) c.click(); else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      setTimeout(() => populateActions(focusInteractEl), 300);
    }, 150);
  }
  function openReply(art) {
    const a = art.querySelector('a[href*="/status/"]');
    const m = a && (a.getAttribute('href') || '').match(/\/([^/]+)\/status\/(\d+)/);
    if (m) window.open(`https://x.com/${m[1]}/status/${m[2]}`, '_blank', 'noopener');
    pause(); // hold Focus in place while you reply in the other tab
  }
  // Follow the author via X's "···" menu (which opens behind our overlay, unseen).
  // We match "Follow @handle" by text (the menu item has no testid); selecting it
  // both follows AND closes the menu. Fallback: toggle the caret shut.
  function doFollow(btn) {
    if (!btn || btn.dataset.state === 'following') return;
    const startEl = focusInteractEl;                    // the tweet this follow targets
    const art = liveArticle(startEl); if (!art) return;
    const caret = art.querySelector('[data-testid="caret"]'); if (!caret) return;
    caret.click();
    setTimeout(() => {
      const menu = document.querySelector('[data-testid="Dropdown"], [role="menu"]');
      const item = menu && [...menu.querySelectorAll('[role="menuitem"]')].find((x) => /^follow @/i.test((x.innerText || '').trim()));
      // Only stamp the (singleton) button if the reader hasn't advanced to another tweet
      // since — else we'd mislabel the new author as followed.
      if (item) { item.click(); if (focusInteractEl === startEl) { btn.dataset.state = 'following'; btn.textContent = 'Following'; } }
      else { caret.click(); } // already following / not found → close the menu
    }, 550);
  }
  function focusAction(kind) {
    focusInteractLastTap = Date.now();          // a tap (even during playback) grants dwell grace
    if (focusInteractExtend) focusInteractExtend();
    const art = liveArticle(focusInteractEl); if (!art) return;
    const click = (sel) => { const b = art.querySelector(sel); if (b) b.click(); };
    if (kind === 'like') click('[data-testid="like"],[data-testid="unlike"]');
    else if (kind === 'bookmark') click('[data-testid="bookmark"],[data-testid="removeBookmark"]');
    else if (kind === 'reply') { openReply(art); return; }
    else if (kind === 'retweet') {
      const rtBtn = focusEl.querySelector('.xpeaker-focus-dock [data-x="retweet"]');
      clearTimeout(focusRetweetTimer);
      if (rtBtn.dataset.confirm === '1') { rtBtn.dataset.confirm = '0'; doRetweet(art); }
      else { rtBtn.dataset.confirm = '1'; focusRetweetTimer = setTimeout(() => { if (rtBtn) rtBtn.dataset.confirm = '0'; }, 3000); return; } // deliberate 2-step for the public repost
    }
    setTimeout(() => populateActions(focusInteractEl), 300);
  }
  // Keep each tweet on screen at least FOCUS_INTERACT_MS from when it appeared, so
  // short tweets don't zip past and there's always a moment to interact. A long
  // tweet (playback already past the floor) advances right away; tapping an action
  // resets the floor so you can do several.
  async function focusDwellHold(el, gen) {
    const bar = focusEl && focusEl.querySelector('.xpeaker-focus-dock');
    const prog = bar && bar.querySelector('.xpeaker-focus-actions-prog');
    let deadline = Math.max(focusTweetStart + FOCUS_INTERACT_MS, focusInteractLastTap + FOCUS_INTERACT_MS, Date.now() + (settings.postGapMs || 200));
    const willWait = deadline - Date.now() > 400; // short tweet / recent tap → visibly linger; long tweet → advance now
    if (willWait && focusEl) { focusEl.dataset.controls = '1'; clearTimeout(focusHideT); }
    focusInteractExtend = () => { deadline = Math.max(deadline, Date.now() + FOCUS_INTERACT_MS); };
    if (bar) bar.dataset.counting = willWait ? '1' : '0';
    while (gen === threadGen && !navRequest) {
      if (isPaused) { await waitWhilePaused(); if (gen !== threadGen) break; deadline = Date.now() + FOCUS_INTERACT_MS; }
      const remain = deadline - Date.now();
      if (prog) prog.style.width = Math.max(0, Math.min(100, (remain / FOCUS_INTERACT_MS) * 100)) + '%';
      if (remain <= 0) break;
      await sleep(80);
    }
    focusInteractExtend = null;
    if (bar) bar.dataset.counting = '0';
  }

  // The tweet's timestamp for the author block — absolute date + time from the <time>'s
  // datetime attr (falls back to its display text, e.g. "3h", if parsing fails).
  function focusTweetDate(el) {
    const t = el.querySelector('a[href*="/status/"] time') || el.querySelector('time');
    if (!t) return '';
    const dt = t.getAttribute('datetime');
    const d = dt ? new Date(dt) : null;
    if (d && !isNaN(d.getTime())) {
      try { return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) + ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) {}
    }
    return (t.textContent || '').trim();
  }

  // Rendering consumer installed on the reader seam while Focus is active.
  const focusRenderHooks = {
    onTweetStart(el, text, author, index) {
      if (!focusEl) return;
      const name = (author && author.name) || '';
      const handle = (author && author.handle) || '';
      focusCurrentEl = el;
      focusTweetStart = Date.now();
      const dock = focusEl.querySelector('.xpeaker-focus-dock');
      if (dock) {
        dock.dataset.show = '1'; dock.dataset.counting = '0';
        dock.dataset.open = dock.matches(':hover') ? '1' : '0'; // collapse now unless the cursor is still on it
        const ap = dock.querySelector('.xpeaker-focus-actions-prog'); if (ap) ap.style.width = '100%';
      }
      populateActions(el); // like/repost/bookmark state for this tweet — bar is visible throughout
      applyFocusAvatar(el, name, handle);
      applyFocusMedia(el);
      applyFocusVideo(el); // canvas-mirror spike (video tweets; no-op otherwise)
      applyFocusQuote(el); // nested quote-tweet card (or hidden)
      const nm = focusEl.querySelector('.xpeaker-focus-name'); if (nm) nm.textContent = name || (handle ? '@' + handle : '');
      const hd = focusEl.querySelector('.xpeaker-focus-handle'); if (hd) hd.textContent = handle ? '@' + handle : '';
      const liveEl = liveArticle(el) || el; // the reader's el can be detached after React churn → use the live node for fresh DOM + fiber
      const dtEl = focusEl.querySelector('.xpeaker-focus-date'); if (dtEl) dtEl.textContent = focusTweetDate(liveEl); // the post's timestamp
      const badge = focusEl.querySelector('.xpeaker-focus-badge');
      if (badge) { badge.innerHTML = ''; const vs = extractVerified(liveEl); if (vs) badge.appendChild(vs.cloneNode(true)); } // blue/gold/grey check, if verified
      applyFocusFollow(el, handle); // offer Follow only when confirmed not-following (polls; falls back to any live tweet by this author if the reader's node is detached)
      applyFocusMood(el, text); // colour the ambient field to this post's emotion (opt-in; on-device; async)
      applyTweetScene(el, handle, text); // author signature shader, else the chosen scene (sets focusSigActive)
      applyTicker(liveEl); // $cashtag → hover-scrape X's price card → logo + bull/bear overlay (async; Premium+)
      const tx = focusEl.querySelector('.xpeaker-focus-text'); if (tx) tx.textContent = focusDisplayText(el, text);
      const ct = focusEl.querySelector('.xpeaker-focus-count'); if (ct) ct.textContent = 'READING ' + String(index).padStart(2, '0');
      // Re-trigger the fade-in animation on each new tweet.
      fitFocusText(); // scale to fit one screen (or enable scroll for very long posts)
      const content = focusEl.querySelector('.xpeaker-focus-content');
      if (content) { content.style.animation = 'none'; void content.offsetWidth; content.style.animation = ''; }
      if (focusScene) focusScene.pulse(); // flash the ambient field on each new tweet
      updateFocusPill();
    },
    onTweetEnd() { /* runThread advances; nothing to render until the next start */ },
    onThreadEnd(count) {
      if (!focusEl) return;
      const title = focusEl.querySelector('.xpeaker-focus-done-title');
      if (title) title.textContent = count === 1 ? 'You read one post.' : `You read ${count} posts.`;
      focusEl.dataset.done = '1';                 // hides pill/top, reveals the card
      const card = focusEl.querySelector('.xpeaker-focus-done'); if (card) card.dataset.show = '1';
      focusEl.dataset.controls = '1'; clearTimeout(focusHideT); clearInterval(focusMediaTimer); stopFocusVideo(); hideAudioPrompt(); // reachable + stop media
    },
  };

  function buildFocusOverlay() {
    const root = document.createElement('div');
    root.className = 'xpeaker-focus';
    root.innerHTML =
      `<div class="xpeaker-focus-bg"></div>` +
      `<div class="xpeaker-focus-ticker" data-show="0"><div class="xpeaker-focus-ticker-tint"></div></div>` +
      `<div class="xpeaker-focus-scrim"></div>` +
      `<div class="xpeaker-focus-moodvig"></div>` +
      `<div class="xpeaker-focus-top"><button class="xpeaker-focus-label" title="Exit focus (Esc)" aria-label="Exit focus"><span class="lbl-rest">FOCUS</span><span class="lbl-exit">✕ EXIT</span></button><span class="xpeaker-focus-count"></span></div>` +
      `<div class="xpeaker-focus-hud">` +
        `<div class="xpeaker-focus-mood" data-show="0"><span class="dot"></span><span class="txt"></span></div>` +
        `<div class="xpeaker-focus-sig" data-show="0"></div>` +
        `<button class="xpeaker-focus-credit" data-fx="credit" type="button" data-show="0" title="Open this shader's author on X (new tab)"></button>` +
      `</div>` +
      `<button class="xpeaker-focus-nav prev" data-fx="nav-prev" title="Previous" aria-label="Previous">${CHEV_L}</button>` +
      `<button class="xpeaker-focus-nav next" data-fx="nav-next" title="Next" aria-label="Next">${CHEV_R}</button>` +
      `<div class="xpeaker-focus-stage"><div class="xpeaker-focus-content">` +
        `<div class="xpeaker-focus-media" data-show="0"><img class="xpeaker-focus-media-img" alt=""><div class="xpeaker-focus-dots"></div></div>` +
        `<div class="xpeaker-focus-video" data-show="0"><canvas class="xpeaker-focus-video-canvas"></canvas>` +
          `<button class="xpeaker-focus-vidnote" data-show="0" type="button" title="This clip is longer than your auto-sound limit, so it plays silently. Click to change the limit in Settings.">${WARN_TRI}<span class="xpeaker-focus-vidnote-txt"></span></button>` +
          `<div class="xpeaker-focus-video-bar"><span class="xpeaker-focus-video-time">0:00 / 0:00</span><div class="xpeaker-focus-video-track"><div class="xpeaker-focus-video-prog"></div></div></div></div>` +
        `<div class="xpeaker-focus-author"><div class="xpeaker-focus-avatar"><span class="xpeaker-focus-avatar-ini"></span><img class="xpeaker-focus-avatar-img" alt=""></div>` +
          `<div class="xpeaker-focus-meta"><div class="xpeaker-focus-nameline"><span class="xpeaker-focus-name"></span><span class="xpeaker-focus-badge"></span><button class="xpeaker-focus-follow" data-show="0" title="Follow this author">Follow</button></div><span class="xpeaker-focus-handle"></span><span class="xpeaker-focus-date"></span></div></div>` +
        `<div class="xpeaker-focus-text"></div>` +
        `<div class="xpeaker-focus-quote" data-show="0">` +
          `<div class="xpeaker-focus-quote-head"><div class="xpeaker-focus-quote-av"><span class="ini"></span><img class="qav" alt=""></div><span class="xpeaker-focus-quote-name"></span><span class="xpeaker-focus-quote-handle"></span></div>` +
          `<div class="xpeaker-focus-quote-text"></div>` +
          `<img class="xpeaker-focus-quote-img" alt="">` +
        `</div>` +
      `</div></div>` +
      `<div class="xpeaker-focus-dock" data-show="0">` +
        `<button class="xpeaker-focus-act" data-x="like" title="Like">${ACT_ICON.like}<span class="cnt"></span></button>` +
        `<div class="xpeaker-focus-dock-rest">` +
          `<button class="xpeaker-focus-act" data-x="retweet" title="Repost (tap twice)">${ACT_ICON.retweet}<span class="cnt"></span></button>` +
          `<button class="xpeaker-focus-act" data-x="bookmark" title="Bookmark">${ACT_ICON.bookmark}</button>` +
          `<button class="xpeaker-focus-act" data-x="reply" title="Reply / open in new tab">${ACT_ICON.reply}</button>` +
          `<span class="xpeaker-focus-pill-sep"></span>` +
          `<button class="xpeaker-focus-btn" data-fx="prev" title="Previous">${BAR_ICON.prev}</button>` +
          `<button class="xpeaker-focus-btn primary" data-fx="pp" title="Play / pause">${SVG.play}</button>` +
          `<button class="xpeaker-focus-btn" data-fx="next" title="Next">${BAR_ICON.next}</button>` +
          `<span class="xpeaker-focus-pill-sep"></span>` +
          `<button class="xpeaker-focus-btn speed" data-fx="speed" title="Speed">1×</button>` +
          `<button class="xpeaker-focus-btn" data-fx="scene" title="Background scene">${BAR_ICON.scene}</button>` +
          `<button class="xpeaker-focus-btn" data-fx="settings" title="Settings">${BAR_ICON.gear}</button>` +
          `<button class="xpeaker-focus-btn" data-fx="newtab" title="Open this post in a new tab (keeps reading)">${BAR_ICON.newtab}</button>` +
          `<button class="xpeaker-focus-btn" data-fx="exit" title="Exit focus (Esc)" aria-label="Exit focus">${FOCUS_X}</button>` +
        `</div>` +
        `<div class="xpeaker-focus-actions-track"><div class="xpeaker-focus-actions-prog"></div></div>` +
      `</div>` +
      `<div class="xpeaker-focus-done" data-show="0">` +
        `<div class="xpeaker-focus-done-title"></div>` +
        `<div class="xpeaker-focus-done-sub">Focus mode ended.</div>` +
        `<div class="xpeaker-focus-done-actions">` +
          `<button class="xpeaker-focus-done-btn primary" data-fx="reenter">RE-ENTER</button>` +
          `<button class="xpeaker-focus-done-btn" data-fx="done">Done</button>` +
        `</div>` +
      `</div>` +
      `<div class="xpeaker-focus-audioask" data-show="0">` +
        `<div class="xpeaker-focus-done-title">Play video sound?</div>` +
        `<div class="xpeaker-focus-done-sub">This clip has audio. Enable it for this session?</div>` +
        `<div class="xpeaker-focus-done-actions">` +
          `<button class="xpeaker-focus-done-btn primary" data-fx="aud-on">Enable sound</button>` +
          `<button class="xpeaker-focus-done-btn" data-fx="aud-off">Keep silent</button>` +
        `</div>` +
      `</div>`;
    const dock = root.querySelector('.xpeaker-focus-dock');
    // Once opened by hover, the dock STAYS open (survives mouse-leave); it only
    // collapses at the next tweet if the cursor isn't over it then (see onTweetStart).
    dock.addEventListener('mouseenter', () => { dock.dataset.open = '1'; });
    dock.querySelector('[data-fx="prev"]').addEventListener('click', prevPost);
    dock.querySelector('[data-fx="pp"]').addEventListener('click', togglePause);
    dock.querySelector('[data-fx="next"]').addEventListener('click', skipNext);
    dock.querySelector('[data-fx="speed"]').addEventListener('click', cycleSpeed);
    dock.querySelector('[data-fx="scene"]').addEventListener('click', cycleScene);
    dock.querySelector('[data-fx="newtab"]').addEventListener('click', () => { // open this post in a BACKGROUND tab; reading continues undisturbed
      const cur = focusCurrentEl && (liveArticle(focusCurrentEl) || focusCurrentEl);
      const timeA = cur && cur.querySelector('a[href*="/status/"] time');
      const link = (timeA && timeA.closest('a')) || (cur && cur.querySelector('a[href*="/status/"]'));
      const url = link && link.href;
      if (url && contextValid()) { try { chrome.runtime.sendMessage({ t: 'openTab', url }); } catch (e) { markOrphaned(); } }
    });
    dock.querySelector('[data-fx="exit"]').addEventListener('click', () => toggleFocus(false));
    dock.querySelector('[data-fx="settings"]').addEventListener('click', () => { pause(); if (orphaned || !contextValid()) { markOrphaned(); return; } try { chrome.runtime.sendMessage({ t: 'openOptions' }); } catch (e) { markOrphaned(); } }); // hold the read while you're in the options tab
    root.querySelector('.xpeaker-focus-vidnote').addEventListener('click', () => { pause(); if (orphaned || !contextValid()) { markOrphaned(); return; } try { chrome.runtime.sendMessage({ t: 'openOptions', focus: 'video' }); } catch (e) { markOrphaned(); } }); // deep-link to the video-sound setting
    root.querySelector('[data-fx="reenter"]').addEventListener('click', reenterFocus);
    root.querySelector('[data-fx="done"]').addEventListener('click', () => toggleFocus(false));
    root.querySelector('.xpeaker-focus-label').addEventListener('click', () => toggleFocus(false)); // FOCUS label doubles as exit (kept visible on hover via CSS :has)
    root.querySelector('.xpeaker-focus-credit').addEventListener('click', (e) => { // open the shader author's X page (tweet or profile) in a background tab; reading continues
      const url = e.currentTarget.dataset.url;
      if (url && contextValid()) { try { chrome.runtime.sendMessage({ t: 'openTab', url }); } catch (err) { markOrphaned(); } }
    });
    root.querySelector('[data-fx="nav-prev"]').addEventListener('click', prevPost); // slideshow arrows on the page edges
    root.querySelector('[data-fx="nav-next"]').addEventListener('click', skipNext);
    const followBtn = root.querySelector('.xpeaker-focus-follow');
    if (followBtn) followBtn.addEventListener('click', () => doFollow(followBtn));
    root.querySelectorAll('.xpeaker-focus-dock [data-x]').forEach((b) => b.addEventListener('click', () => focusAction(b.dataset.x)));
    // Audio prompt buttons — the CLICK is the user gesture that unlocks unmuted play.
    root.querySelector('[data-fx="aud-on"]').addEventListener('click', () => { const f = audioAskEnable; hideAudioPrompt(); if (f) f(); });
    root.querySelector('[data-fx="aud-off"]').addEventListener('click', () => { const f = audioAskSilent; hideAudioPrompt(); if (f) f(); });
    // Avatar image error: fall back to the known-good DOM src once, then to initials.
    const avImg = root.querySelector('.xpeaker-focus-avatar-img');
    if (avImg) avImg.addEventListener('error', function () {
      const fb = this.dataset.fallback;
      if (fb && this.src !== fb) { this.src = fb; } else { this.style.display = 'none'; }
    });
    // Quote avatar / image error: hide so the initials / no-image state shows.
    const qav = root.querySelector('.xpeaker-focus-quote-av .qav'); if (qav) qav.addEventListener('error', function () { this.style.display = 'none'; });
    const qim = root.querySelector('.xpeaker-focus-quote-img'); if (qim) qim.addEventListener('error', function () { this.style.display = 'none'; });
    // Media image error: give up on the media region for this tweet → text-only.
    const mdImg = root.querySelector('.xpeaker-focus-media-img');
    if (mdImg) mdImg.addEventListener('error', function () {
      const md = root.querySelector('.xpeaker-focus-media'); if (md) md.dataset.show = '0';
      const ct = root.querySelector('.xpeaker-focus-content'); if (ct) ct.dataset.media = '0';
      clearInterval(focusMediaTimer); fitFocusText();
    });
    return root;
  }
  // Dismiss the completion card and re-read the thread from the current view.
  function reenterFocus() {
    if (!focusEl) return;
    const card = focusEl.querySelector('.xpeaker-focus-done'); if (card) card.dataset.show = '0';
    focusEl.dataset.done = '0';
    focusArmHide();
    const startEl = focusedTweet();
    if (startEl) runThread(startEl); else setBarState('idle', 'No post in view');
  }
  // Keep the pill's play/pause icon + speed label in sync with reader state.
  function updateFocusPill() {
    if (!focusEl) return;
    const pp = focusEl.querySelector('[data-fx="pp"]'); if (pp) pp.innerHTML = isPaused ? SVG.play : BAR_ICON.pause;
    const sp = focusEl.querySelector('[data-fx="speed"]'); if (sp) sp.textContent = `${Math.round(settings.speed * 100) / 100}×`;
  }
  function onFocusKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); toggleFocus(false); }
  }
  function enterFocus() {
    if (focusActive) return;
    focusActive = true;
    // Force thread mode BEFORE reading so the whole thread is enumerated and the
    // pill's prev/next actually work — skipNext/prevPost no-op unless mode==='thread'
    // (mirrors startThreadFromFocus). Stash the prior mode to restore on exit.
    priorMode = settings.mode;
    if (settings.mode !== 'thread') { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); }
    focusEl = buildFocusOverlay();
    focusEl.dataset.controls = '1';
    document.body.appendChild(focusEl);
    requestAnimationFrame(() => { if (focusEl) focusEl.dataset.on = '1'; });
    focusScene = makeFocusScene(focusEl.querySelector('.xpeaker-focus-bg'));
    updateSceneBtn();
    focusEl.addEventListener('mousemove', onFocusMove);
    window.addEventListener('resize', onFocusResize);
    focusArmHide();
    document.addEventListener('keydown', onFocusKey, true);
    setFocusHooks(focusRenderHooks);
    updateBarControls();
    updateFocusPill();
    focusEnterT = performance.now(); focusFirstWordLogged = false; // measure enter → first audible word (focusDebug)
    // Warm the mood model now (during entry) so its one-time load doesn't compete with
    // the FIRST tweet's TTS — that was the initial-speak delay. Fire-and-forget.
    if (settings.moodRing && contextValid()) { try { chrome.runtime.sendMessage({ t: 'moodPreload' }, () => { void chrome.runtime.lastError; }); } catch (e) {} }
    // Start reading once a tweet is available — right after entering Focus the target
    // tweet may not be in the DOM yet, so poll briefly rather than giving up immediately.
    (function startReader(tries) {
      if (!focusActive || !focusEl) return;
      const el = focusedTweet();
      if (el) { runThread(el); return; }
      if (tries < 15) setTimeout(() => startReader(tries + 1), 200); // ~3s grace
      else setBarState('idle', 'No post in view');
    })(0);
  }
  function exitFocus() {
    if (!focusActive) return;
    focusActive = false;
    setFocusHooks(NO_FOCUS_HOOKS);         // stop rendering before we tear the reader down
    document.removeEventListener('keydown', onFocusKey, true);
    clearTimeout(focusHideT); focusHideT = null;
    clearTimeout(focusAvatarTimer); clearInterval(focusMediaTimer); clearTimeout(focusQuoteTimer); clearTimeout(focusFollowTimer); focusMediaComplete = true; focusCurrentEl = null;
    focusTickerToken++; focusSigActive = false; // abort any in-flight ticker scrape (it self-dismisses on the token change)
    stopFocusVideo(); hideAudioPrompt(); focusInteractExtend = null; focusInteractEl = null;
    window.removeEventListener('resize', onFocusResize);
    if (focusScene) { focusScene.destroy(); focusScene = null; }
    fullStop();                            // stop the reader started on entry
    const el = focusEl; focusEl = null;    // fade out, then remove
    if (el) { el.dataset.on = '0'; el.removeEventListener('mousemove', onFocusMove); setTimeout(() => el.remove(), 320); }
    // Restore the mode we changed on entry (only if the user hasn't since changed it).
    if (priorMode && priorMode !== settings.mode) { settings.mode = priorMode; saveSettings(); updateBarControls(); applyModeToButtons(); }
    priorMode = null;
    updateBarControls();
  }
  // Enter/exit Focus in THIS tab only. Focus is per-tab, in-memory state (focusActive) —
  // never persisted — so it can't leak to other x.com tabs or survive a page refresh.
  // Pass an explicit boolean to force a target state (e.g. Esc -> false).
  function toggleFocus(on) {
    const next = (typeof on === 'boolean') ? on : !focusActive;
    if (next && !focusActive) enterFocus();
    else if (!next && focusActive) exitFocus();
  }

  // --------------------------------------------------------------------------
  // Floating player bar
  // --------------------------------------------------------------------------
  let barEl = null;
  function setBarState(state) { if (barEl) barEl.dataset.state = state; } // data-state tints the anchor/dot (playing → blue); no text status anymore
  function setDot(state) {
    if (orphaned) return; // keep the "refresh to reconnect" hint once disconnected
    const d = barEl && barEl.querySelector('.xpeaker-dot.tts');
    if (d) { d.dataset.s = state; d.title = state === 'ok' ? 'Supertonic voices: available' : (state === 'down' ? 'No Supertonic voices — click to install' : 'Checking voices…'); }
  }
  function bumpSpeed(d) { settings.speed = clamp(Math.round((settings.speed + d) * 100) / 100, 0.7, 2); saveSettings(); updateBarControls(); }
  function cycleSpeed() { let i = SPEED_PRESETS.findIndex((p) => p >= settings.speed - 0.001); i = (i + 1) % SPEED_PRESETS.length; settings.speed = SPEED_PRESETS[i]; saveSettings(); updateBarControls(); }
  // Cycle the Focus background scene from the dock; saveSettings() → storage listener live-swaps it.
  function cycleScene() {
    const keys = pickableScenes(); // signatures aren't in the cycle
    const i = keys.indexOf(settings.focusScene);
    settings.focusScene = keys[(i + 1) % keys.length];
    saveSettings();
    updateSceneBtn();
  }
  function updateSceneBtn() {
    if (!focusEl) return;
    const s = FOCUS_SCENES[settings.focusScene] || FOCUS_SCENES.aurora;
    const b = focusEl.querySelector('[data-fx="scene"]');
    if (b) b.title = `Background: ${s.label}${s.author ? ` — by ${s.author}` : ''} · click to change`;
    const cr = focusEl.querySelector('.xpeaker-focus-credit');
    if (cr) { if (s.author) { cr.dataset.show = '1'; cr.dataset.url = s.creditUrl || ('https://x.com/' + s.author.replace(/^@/, '')); cr.textContent = `🎨 ${s.label}`; cr.title = `${s.label} — by ${s.author} (open on X)`; } else { cr.dataset.show = '0'; cr.dataset.url = ''; } }
  }
  function setMode(m) {
    if (!MODES.includes(m) || m === settings.mode) return;
    stopThread(); ttsStop(); clearActiveBtn(); isPaused = false; setBarState('idle');
    settings.mode = m; saveSettings(); updateBarControls(); applyModeToButtons();
  }
  function cycleMode() { setMode(MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]); }

  function updateBarControls() {
    if (!barEl) return;
    const m = settings.mode, thread = m === 'thread';
    const seg = barEl.querySelector('.xpeaker-bar-modeseg');
    if (seg) seg.querySelectorAll('[data-mode]').forEach((b) => { b.dataset.active = b.dataset.mode === m ? '1' : '0'; });
    const dirBtn = barEl.querySelector('[data-act="dir"]');
    if (dirBtn) { const up = settings.direction === 'up'; dirBtn.innerHTML = up ? BAR_ICON.up : BAR_ICON.down; dirBtn.title = up ? 'Direction: up (newer)' : 'Direction: down (older)'; dirBtn.style.display = thread ? 'inline-flex' : 'none'; }
    barEl.querySelectorAll('[data-act="prev"],[data-act="next"]').forEach((b) => { b.style.display = thread ? 'inline-flex' : 'none'; });
    const speedBtn = barEl.querySelector('[data-act="speed"]');
    if (speedBtn) { speedBtn.textContent = `${Math.round(settings.speed * 100) / 100}×`; speedBtn.title = 'Speed (click to cycle; Alt+↑/↓ to fine-tune)'; }
    const focusBtn = barEl.querySelector('[data-act="focus"]');
    if (focusBtn) { focusBtn.dataset.on = focusActive ? '1' : '0'; focusBtn.title = focusActive ? 'Exit focus mode' : 'Focus mode'; }
    updateFocusPill(); // keep the Focus overlay pill in sync (pause/resume/speed)
  }

  function createControlBar() {
    if (barEl) return;
    barEl = document.createElement('div'); barEl.className = 'xpeaker-bar'; barEl.dataset.state = 'idle';
    // Collapsed dock (mirrors the Focus-mode dock): the Xpeaker mark is the fixed left
    // anchor. Clicking it ARMS a direction chooser (Newer ↑ / Older ↓); picking one sets
    // the reading direction and enters Focus. Clicking the mark again — or leaving the
    // bar — cancels. Hovering the pill unfolds `.xpeaker-bar-rest` (transport); Settings
    // sits at its far end.
    barEl.innerHTML =
      `<button class="xpeaker-bar-anchor" data-act="focus" title="Focus mode — pick a reading direction">${BAR_ICON.xpeaker}<span class="xpeaker-bar-anchor-label">Focus Mode</span></button>` +
      `<div class="xpeaker-bar-arm">` +
        `<button class="xpeaker-bar-btn wide" data-dir="up" title="Focus — read upward (newer posts)">${BAR_ICON.up}<span class="xpeaker-bar-label">Newer</span></button>` +
        `<button class="xpeaker-bar-btn wide" data-dir="down" title="Focus — read downward (older posts)">${BAR_ICON.down}<span class="xpeaker-bar-label">Older</span></button>` +
      `</div>` +
      `<div class="xpeaker-bar-rest">` +
        `<span class="xpeaker-dot tts" title="Checking voices…"></span>` +
        `<div class="xpeaker-bar-modeseg" role="group" aria-label="Reading mode">` +
          `<button class="xpeaker-bar-segbtn" data-mode="single" title="Single — read one post">${BAR_ICON.speaker}<span class="xpeaker-bar-label">Single</span></button>` +
          `<button class="xpeaker-bar-segbtn" data-mode="thread" title="Thread — read continuously">${BAR_ICON.play}<span class="xpeaker-bar-label">Thread</span></button>` +
        `</div>` +
        `<button class="xpeaker-bar-btn" data-act="dir"></button>` +
        `<span class="xpeaker-bar-sep"></span>` +
        `<button class="xpeaker-bar-btn" data-act="prev" title="Previous post">${BAR_ICON.prev}</button>` +
        `<button class="xpeaker-bar-btn" data-act="next" title="Skip to next post">${BAR_ICON.next}</button>` +
        `<button class="xpeaker-bar-btn" data-act="stop" title="Stop">${BAR_ICON.stop}</button>` +
        `<button class="xpeaker-bar-btn speed" data-act="speed"></button>` +
        `<span class="xpeaker-bar-sep"></span>` +
        `<button class="xpeaker-bar-btn wide" data-act="settings" title="Open settings">${BAR_ICON.gear}<span class="xpeaker-bar-label">Settings</span></button>` +
      `</div>`;
    barEl.querySelector('.xpeaker-dot.tts').addEventListener('click', () => { if (!supertonicAvailable) window.open(SUPERTONIC_INSTALL_URL, '_blank', 'noopener'); else refreshVoices(); });
    barEl.querySelectorAll('.xpeaker-bar-modeseg [data-mode]').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));
    barEl.querySelector('[data-act="dir"]').addEventListener('click', () => { settings.direction = settings.direction === 'up' ? 'down' : 'up'; saveSettings(); updateBarControls(); applyModeToButtons(); });
    barEl.querySelector('[data-act="prev"]').addEventListener('click', prevPost);
    barEl.querySelector('[data-act="next"]').addEventListener('click', skipNext);
    barEl.querySelector('[data-act="stop"]').addEventListener('click', fullStop);
    barEl.querySelector('[data-act="speed"]').addEventListener('click', cycleSpeed);
    // Two-phase Focus entry: click the mark to ARM the direction chooser (toggle);
    // picking Newer/Older sets the direction and enters. Leaving the bar cancels.
    barEl.querySelector('[data-act="focus"]').addEventListener('click', () => { barEl.dataset.arming = barEl.dataset.arming === '1' ? '0' : '1'; });
    barEl.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => {
      settings.direction = b.dataset.dir; saveSettings(); updateBarControls(); applyModeToButtons();
      barEl.dataset.arming = '0';
      toggleFocus(true);
    }));
    barEl.addEventListener('mouseleave', () => { barEl.dataset.arming = '0'; });
    barEl.querySelector('[data-act="settings"]').addEventListener('click', () => { if (orphaned || !contextValid()) { markOrphaned(); return; } try { chrome.runtime.sendMessage({ t: 'openOptions' }); } catch (e) { markOrphaned(); } });
    document.body.appendChild(barEl);
    updateBarControls();
    refreshVoices();
    setInterval(refreshVoices, 20000);
  }

  // --------------------------------------------------------------------------
  // Keyboard shortcuts
  // --------------------------------------------------------------------------
  let lastHoveredTweet = null, cursorTweet = null;
  document.addEventListener('mouseover', (e) => { const a = e.target.closest && e.target.closest('article[data-testid="tweet"]'); if (a) lastHoveredTweet = a; }, true);
  function focusedTweet() {
    if (lastHoveredTweet && document.contains(lastHoveredTweet)) return lastHoveredTweet;
    const list = getTimelineTweets(); const cy = window.innerHeight / 2; let best = null, bd = Infinity;
    for (const el of list) { const r = el.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - cy); if (d < bd) { bd = d; best = el; } }
    return best;
  }
  function startThreadFromFocus() { const el = focusedTweet(); if (el) { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); runThread(el); } }
  // Vim J/K: step to the visually next/previous post (relative to the last-read post) and read it.
  function readStep(dir) {
    const base = (cursorTweet && document.contains(cursorTweet)) ? cursorTweet : focusedTweet();
    if (!base) return;
    const target = neighbor(base, dir, null) || base;
    cursorTweet = target;
    try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
    readSinglePost(target);
  }
  function defaultKey(code) {
    switch (code) {
      case 'KeyR': readSinglePost(focusedTweet()); return true;
      case 'KeyT': startThreadFromFocus(); return true;
      case 'KeyS': fullStop(); return true;
      case 'KeyN': skipNext(); return true;
      case 'KeyB': prevPost(); return true;
      case 'Space': if (focusActive) { togglePause(); return true; } return false; // pause is Focus-only now
      case 'ArrowUp': bumpSpeed(0.25); return true;
      case 'ArrowDown': bumpSpeed(-0.25); return true;
    }
    return false;
  }
  function vimKey(code) {
    switch (code) {
      case 'KeyP': readSinglePost(focusedTweet()); return true;
      case 'KeyJ': if (settings.mode === 'thread' && threadActive) skipNext(); else readStep('down'); return true;
      case 'KeyK': if (settings.mode === 'thread' && threadActive) prevPost(); else readStep('up'); return true;
      case 'KeyT': startThreadFromFocus(); return true;
      case 'Space': if (focusActive) { togglePause(); return true; } return false; // pause is Focus-only now
      case 'KeyS': fullStop(); return true;
      case 'KeyL': bumpSpeed(0.25); return true;
      case 'KeyH': bumpSpeed(-0.25); return true;
    }
    return false;
  }
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const handled = settings.keymap === 'vim' ? vimKey(e.code) : defaultKey(e.code);
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // --------------------------------------------------------------------------
  // Auto-duck: pause reader when the user plays an AUDIBLE video; resume on end/pause.
  // --------------------------------------------------------------------------
  function maybeDuckOnMedia(v) {
    if (focusActive) return; // Focus orchestrates its own clip audio — auto-duck would fight it (play/pause loop)
    if (!settings.pauseOnVideo) return;
    if (!(v instanceof HTMLMediaElement) || v.muted || v.volume === 0 || v.paused) return;
    if (!(activeBtn || threadActive) || isPaused) return;
    pausedForVideo = true; pause();
    detachWatch(); watchedVideo = v;
    v.addEventListener('ended', onWatchEnd); v.addEventListener('pause', onWatchEnd);
  }
  document.addEventListener('play', (e) => maybeDuckOnMedia(e.target), true);
  document.addEventListener('volumechange', (e) => maybeDuckOnMedia(e.target), true);

  // --------------------------------------------------------------------------
  // Commands from the service worker (context menu) and popup
  // --------------------------------------------------------------------------
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.t === 'focusState') { sendResponse({ active: focusActive }); return; } // popup asks THIS tab whether it's in Focus
    if (!msg || msg.t !== 'cmd') return;
    switch (msg.cmd) {
      case 'cycle': cycleMode(); break;
      case 'readTop': { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); const s = pickUnseen(settings.direction, new Set()); if (s) runThread(s); break; }
      case 'focus': toggleFocus(); break;
      case 'stop': fullStop(); break;
    }
  });

  // --------------------------------------------------------------------------
  // Boot
  // --------------------------------------------------------------------------
  function scan(root) { const scope = root && root.querySelectorAll ? root : document; scope.querySelectorAll('article[data-testid="tweet"]').forEach(addButtonToTweet); }
  async function init() {
    await loadSettings();
    connectBridge();
    const observer = new MutationObserver((mutations) => { for (const m of mutations) for (const node of m.addedNodes) if (node.nodeType === 1) scan(node); });
    observer.observe(document.body, { childList: true, subtree: true });
    scan(document);
    createControlBar();
    // Focus Mode does NOT auto-enter on load — it's per-tab/session state, so a refresh
    // (or a new tab, e.g. the ↗ "open post" button) always starts in a clean, non-Focus view.
    console.log(`[Xpeaker] active — chrome.tts + Supertonic voices (mode ${settings.mode})`);
  }
  init();
})();

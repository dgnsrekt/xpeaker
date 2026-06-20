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

  // X Pro / TweetDeck = the multi-column board. Reuses the same tweet testids, but tweets
  // live inside columns, so navigation becomes 2-D (see the board section below).
  const isXPro = /(^|\.)pro\.x\.com$/i.test(location.hostname) || /(^|\.)tweetdeck\.twitter\.com$/i.test(location.hostname);

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
  function saveSettings() {
    try { chrome.storage.local.set({ settings }); } catch (e) { console.error('[Xpeaker] save failed', e); }
  }
  // React to changes made by the popup / options page.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    settings = XP.mergeSettings(changes.settings.newValue);
    updateBarControls(); applyModeToButtons(); applyDensity();
  });

  function rate() { return clamp(settings.speed, 0.1, 10); }

  // --------------------------------------------------------------------------
  // Speak bridge (client side) — replaces the old fetch + AudioContext pipeline
  // --------------------------------------------------------------------------
  let port = null, seq = 0;
  const waiters = new Map();       // reqId -> { resolve, onStart, onWord }
  const voiceWaiters = new Map();  // reqId -> resolve

  function connectBridge() {
    port = chrome.runtime.connect({ name: 'xpeaker' });
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
    });
  }
  function ensurePort() { if (!port) connectBridge(); return port; }

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
  // Promoted/ad posts — skipped during continuous (thread) reading.
  function isPromoted(tweetEl) {
    if (!tweetEl) return false;
    if (tweetEl.querySelector('[data-testid="placementTracking"]')) return true;
    return Array.from(tweetEl.querySelectorAll('span')).some((s) => /^(ad|promoted)$/i.test((s.textContent || '').trim()));
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
    if (mode === 'off') return { word() {}, end() {} };
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
  // Playback control flags (AudioContext logic removed; routes to chrome.tts)
  // --------------------------------------------------------------------------
  let activeBtn = null, isPaused = false, pausedForVideo = false, resumeWaiters = [], watchedVideo = null;
  function pause() {
    if (isPaused || !(activeBtn || threadActive)) return;
    isPaused = true; ttsPause();
    if (activeBtn) setBtnState(activeBtn, 'paused');
    updateBarControls();
  }
  function resume() {
    if (!isPaused) return;
    isPaused = false; pausedForVideo = false; ttsResume();
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
    const reason = await speakBridge(text, voiceArg(extractAuthor(tweetEl).handle), rate(), {
      onStart: () => { if (activeBtn === btn) setBtnState(btn, 'playing'); },
      onWord: (m) => hl.word(m),
    });
    hl.end();
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
  // Phase 2 — on X Pro a thread (Snapshot) read is scoped to ONE column.
  let threadScope = null; // { contentEl } of the column being read; null = whole document
  function scopeColumn() {
    if (!(isXPro && threadScope && threadScope.contentEl && document.contains(threadScope.contentEl))) return null;
    const contentEl = threadScope.contentEl;
    let region = contentEl; while (region && !(region.matches && region.matches('section[role="region"]'))) region = region.parentElement;
    let scrollEl = contentEl, h = 0; while (scrollEl && h < 6) { const o = getComputedStyle(scrollEl).overflowY; if (o === 'auto' || o === 'scroll') break; scrollEl = scrollEl.parentElement; h++; }
    return { contentEl, region: region || contentEl, scrollEl: scrollEl || contentEl, label: (region && region.getAttribute('aria-label')) || 'Column' };
  }
  // Click a column's "See new posts" pill to append batched new arrivals.
  function flushNewPosts(col) {
    const pill = col && col.region && col.region.querySelector('[data-testid="pillLabel"]');
    if (!pill) return false;
    const clickable = pill.closest('[role="button"],button,a') || pill;
    try { clickable.click(); return true; } catch (e) { return false; }
  }
  function getTimelineTweets() { const c = scopeColumn(); return Array.from((c ? c.contentEl : document).querySelectorAll('article[data-testid="tweet"]')); }
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
    const c = scopeColumn();
    if (c) {
      if (dir === 'up') flushNewPosts(c); // newer posts arrive batched behind the pill
      try { c.scrollEl.scrollBy(0, Math.round(c.scrollEl.clientHeight * 0.85) * (dir === 'down' ? 1 : -1)); } catch (e) {}
    } else {
      window.scrollBy(0, Math.round(window.innerHeight * 0.85) * (dir === 'down' ? 1 : -1));
    }
    await sleep(650);
    for (const id of getTimelineTweets().map(tweetId)) if (id && !before.has(id)) return true;
    return false;
  }
  async function runThread(startEl) {
    stopThread(); ttsStop(); clearActiveBtn(); isPaused = false;
    threadScope = isXPro ? { contentEl: startEl && startEl.closest && startEl.closest('[data-testid="multi-column-layout-column-content"]') } : null;
    if (!(supertonicAvailable || settings.fallbackToNative)) { setBarState('idle', 'Install Supertonic voices'); showInstallToast(); refreshVoices(); return; }
    claimReader();
    const gen = ++threadGen; threadActive = true; navRequest = null;
    const dir = settings.direction; const seen = new Set(); const order = [];
    const scope = scopeColumn(); if (scope) { try { scope.region.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} }
    setBarState('playing', scope ? `${scope.label}…` : 'Reading…');
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
          if (text) {
            try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
            highlight(el, true);
            const btn = el.querySelector('.xpeaker-speak-btn');
            activeBtn = btn; if (btn) setBtnState(btn, 'playing'); // reflect on the post button too
            setBarState('playing', scope ? `${scope.label} · ${order.length}` : `Reading ${order.length}`);
            const hl = startHighlight(el, text);
            const reason = await speakBridge(text, voiceArg(extractAuthor(el).handle), rate(), { onWord: (m) => hl.word(m) });
            hl.end();
            if (gen !== threadGen) return; // superseded: stopThread() cleared highlights, clearActiveBtn() the button
            highlight(el, false);
            if (activeBtn === btn) { setBtnState(btn, 'idle'); activeBtn = null; }
            if (!navRequest && reason !== 'stopped' && settings.postGapMs) { await sleep(settings.postGapMs); if (gen !== threadGen) return; }
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
          if (dryLoads >= 2 || !next) { setBarState('idle', 'Done'); return; }
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
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 5.5 8.5 12 15 18.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
    collapse: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5.5 15.5 12 9 18.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"></path></svg>',
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
      if (settings.mode === 'thread') { runThread(tweetEl); return; }
      const st = btn.dataset.state;
      if (st === 'paused') { resume(); return; }
      if (st === 'playing' || st === 'loading') { ttsStop(); if (activeBtn === btn) activeBtn = null; setBtnState(btn, 'idle'); return; }
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
  // Floating player bar
  // --------------------------------------------------------------------------
  let barEl = null, barStatusEl = null;
  function setBarState(state, text) { if (!barEl) return; barEl.dataset.state = state; if (barStatusEl) barStatusEl.textContent = text || (state === 'playing' ? 'Reading…' : 'Xpeaker'); }
  function setDot(state) {
    const d = barEl && barEl.querySelector('.xpeaker-dot.tts');
    if (d) { d.dataset.s = state; d.title = state === 'ok' ? 'Supertonic voices: available' : (state === 'down' ? 'No Supertonic voices — click to install' : 'Checking voices…'); }
  }
  function bumpSpeed(d) { settings.speed = clamp(Math.round((settings.speed + d) * 100) / 100, 0.7, 2); saveSettings(); updateBarControls(); }
  function cycleSpeed() { let i = SPEED_PRESETS.findIndex((p) => p >= settings.speed - 0.001); i = (i + 1) % SPEED_PRESETS.length; settings.speed = SPEED_PRESETS[i]; saveSettings(); updateBarControls(); }
  function cycleMode() { stopThread(); ttsStop(); clearActiveBtn(); isPaused = false; setBarState('idle'); settings.mode = MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]; saveSettings(); updateBarControls(); applyModeToButtons(); }

  function updateBarControls() {
    if (!barEl) return;
    const m = settings.mode, thread = m === 'thread';
    const modeBtn = barEl.querySelector('[data-act="mode"]');
    if (modeBtn) {
      modeBtn.dataset.mode = m;
      const ic = thread ? BAR_ICON.play : BAR_ICON.speaker;
      const lbl = thread ? 'Thread' : 'Single';
      modeBtn.innerHTML = ic + `<span class="xpeaker-bar-label">${lbl}</span>`;
      modeBtn.title = `Mode: ${lbl} — click to switch (single ↔ thread)`;
    }
    const dirBtn = barEl.querySelector('[data-act="dir"]');
    if (dirBtn) { const up = settings.direction === 'up'; dirBtn.innerHTML = up ? BAR_ICON.up : BAR_ICON.down; dirBtn.title = up ? 'Direction: up (newer)' : 'Direction: down (older)'; dirBtn.style.display = thread ? 'inline-flex' : 'none'; }
    const pauseBtn = barEl.querySelector('[data-act="pause"]');
    if (pauseBtn) { pauseBtn.innerHTML = isPaused ? BAR_ICON.play : BAR_ICON.pause; pauseBtn.title = isPaused ? 'Resume' : 'Pause'; }
    barEl.querySelectorAll('[data-act="prev"],[data-act="next"]').forEach((b) => { b.style.display = thread ? 'inline-flex' : 'none'; });
    const speedBtn = barEl.querySelector('[data-act="speed"]');
    if (speedBtn) { speedBtn.textContent = `${Math.round(settings.speed * 100) / 100}×`; speedBtn.title = 'Speed (click to cycle; Alt+↑/↓ to fine-tune)'; }
  }

  function createControlBar() {
    if (barEl) return;
    barEl = document.createElement('div'); barEl.className = 'xpeaker-bar'; barEl.dataset.state = 'idle';
    barEl.innerHTML =
      `<div class="xpeaker-bar-info"></div>` +
      `<button class="xpeaker-bar-btn" data-act="density"></button>` +
      `<span class="xpeaker-dot tts" title="Checking voices…"></span>` +
      `<button class="xpeaker-bar-btn wide" data-act="mode"></button>` +
      `<button class="xpeaker-bar-btn" data-act="dir"></button>` +
      `<span class="xpeaker-bar-sep"></span>` +
      `<button class="xpeaker-bar-btn" data-act="pause"></button>` +
      `<button class="xpeaker-bar-btn" data-act="prev" title="Previous post">${BAR_ICON.prev}</button>` +
      `<button class="xpeaker-bar-btn" data-act="next" title="Skip to next post">${BAR_ICON.next}</button>` +
      `<button class="xpeaker-bar-btn" data-act="stop" title="Stop">${BAR_ICON.stop}</button>` +
      `<button class="xpeaker-bar-btn speed" data-act="speed"></button>` +
      `<span class="xpeaker-bar-status">Xpeaker</span>` +
      `<button class="xpeaker-bar-btn" data-act="settings" title="Settings">${BAR_ICON.gear}</button>`;
    barStatusEl = barEl.querySelector('.xpeaker-bar-status');
    barEl.querySelector('.xpeaker-dot.tts').addEventListener('click', () => { if (!supertonicAvailable) window.open(SUPERTONIC_INSTALL_URL, '_blank', 'noopener'); else refreshVoices(); });
    barEl.querySelector('[data-act="mode"]').addEventListener('click', cycleMode);
    barEl.querySelector('[data-act="dir"]').addEventListener('click', () => { settings.direction = settings.direction === 'up' ? 'down' : 'up'; saveSettings(); updateBarControls(); applyModeToButtons(); });
    barEl.querySelector('[data-act="pause"]').addEventListener('click', togglePause);
    barEl.querySelector('[data-act="prev"]').addEventListener('click', prevPost);
    barEl.querySelector('[data-act="next"]').addEventListener('click', skipNext);
    barEl.querySelector('[data-act="stop"]').addEventListener('click', fullStop);
    barEl.querySelector('[data-act="speed"]').addEventListener('click', cycleSpeed);
    barEl.querySelector('[data-act="settings"]').addEventListener('click', () => chrome.runtime.sendMessage({ t: 'openOptions' }));
    barEl.querySelector('[data-act="density"]').addEventListener('click', () => { settings.barDensity = settings.barDensity === 'expanded' ? 'compact' : 'expanded'; saveSettings(); applyDensity(); });
    document.body.appendChild(barEl);
    updateBarControls();
    applyDensity();
    refreshVoices();
    setInterval(refreshVoices, 20000);
  }

  function shortcutsHTML() {
    const km = KEYMAPS[settings.keymap] || KEYMAPS.default;
    const chips = km.keys.map(([k, l]) => `<span class="xpeaker-kbd"><kbd>⌥${k}</kbd>${l}</span>`).join('');
    return `<span class="xpeaker-kbd label">${km.label} keys</span>${chips}`;
  }
  function applyDensity() {
    if (!barEl) return;
    const exp = settings.barDensity === 'expanded';
    barEl.dataset.density = exp ? 'expanded' : 'compact';
    const btn = barEl.querySelector('[data-act="density"]');
    if (btn) { btn.innerHTML = exp ? BAR_ICON.collapse : BAR_ICON.expand; btn.title = exp ? 'Collapse bar' : 'Expand bar (show shortcuts)'; }
    const info = barEl.querySelector('.xpeaker-bar-info');
    if (info) info.innerHTML = exp ? shortcutsHTML() : '';
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
  function startThreadFromFocus() { const el = isXPro ? boardFocused() : focusedTweet(); if (el) { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); runThread(el); } }
  // Vim J/K: step to the visually next/previous post (relative to the last-read post) and read it.
  function readStep(dir) {
    const base = (cursorTweet && document.contains(cursorTweet)) ? cursorTweet : focusedTweet();
    if (!base) return;
    const target = neighbor(base, dir, null) || base;
    cursorTweet = target;
    try { target.scrollIntoView({ block: 'center' }); } catch (e) {}
    readSinglePost(target);
  }
  // --------------------------------------------------------------------------
  // X Pro board navigation (Phase 1 — manual cursor)
  // Move a focus ring across the 2-D board: Alt+J/K within a column, Alt+[ /]
  // between columns, Alt+P/R reads the focused post. Columns reuse the same
  // tweet testids, so extraction/reading is unchanged — only navigation is new.
  // --------------------------------------------------------------------------
  let boardCursor = null; // the focused tweet element on an X Pro board
  function boardColumns() {
    return Array.from(document.querySelectorAll('[data-testid="multi-column-layout-column-content"]')).map((contentEl) => {
      let region = contentEl;
      while (region && !(region.matches && region.matches('section[role="region"]'))) region = region.parentElement;
      let scrollEl = contentEl, hops = 0;
      while (scrollEl && hops < 6) { const o = getComputedStyle(scrollEl).overflowY; if (o === 'auto' || o === 'scroll') break; scrollEl = scrollEl.parentElement; hops++; }
      const rect = (region || contentEl).getBoundingClientRect();
      return { contentEl, region: region || contentEl, scrollEl: scrollEl || contentEl, label: (region && region.getAttribute('aria-label')) || 'Column', x: rect.x };
    }).sort((a, b) => a.x - b.x);
  }
  function columnTweets(col) { return col ? Array.from(col.contentEl.querySelectorAll('article[data-testid="tweet"]')) : []; }
  function columnOf(tweetEl) {
    const content = tweetEl && tweetEl.closest('[data-testid="multi-column-layout-column-content"]');
    const cols = boardColumns();
    const idx = content ? cols.findIndex((c) => c.contentEl === content) : -1;
    return { cols, idx, col: cols[idx] || null };
  }
  function nearestByY(tweets, refEl) {
    if (!tweets.length) return null;
    const r = refEl.getBoundingClientRect(); const y = r.top + r.height / 2;
    let best = tweets[0], bd = Infinity;
    for (const t of tweets) { const tr = t.getBoundingClientRect(); const d = Math.abs(tr.top + tr.height / 2 - y); if (d < bd) { bd = d; best = t; } }
    return best;
  }
  function boardFocused() {
    if (boardCursor && document.contains(boardCursor)) return boardCursor;
    if (lastHoveredTweet && document.contains(lastHoveredTweet)) return lastHoveredTweet;
    for (const c of boardColumns()) { const ts = columnTweets(c); if (ts.length) return ts[0]; }
    return null;
  }
  function setBoardFocus(el, opts) {
    if (boardCursor) boardCursor.classList.remove('xpeaker-focus');
    boardCursor = (el && document.contains(el)) ? el : null;
    if (!boardCursor) return;
    boardCursor.classList.add('xpeaker-focus');
    if (opts && opts.col) { const { col } = columnOf(boardCursor); if (col) { try { col.region.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} } }
    try { boardCursor.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch (e) {}
    if (barEl && barEl.dataset.state === 'idle') { const { cols, idx, col } = columnOf(boardCursor); if (col) { const ts = columnTweets(col); setBarState('idle', `▸ ${idx + 1}/${cols.length} ${col.label} · ${ts.indexOf(boardCursor) + 1}/${ts.length}`); } }
  }
  function boardMove(dir) {
    const had = boardCursor && document.contains(boardCursor);
    const cur = boardFocused(); if (!cur) return;
    if (!had) { setBoardFocus(cur, { col: true }); return; } // first press just lands the ring
    const { cols, idx, col } = columnOf(cur);
    if (idx === -1) { setBoardFocus(cur); return; }
    if (dir === 'down' || dir === 'up') {
      const ts = columnTweets(col); const i = ts.indexOf(cur);
      if (i === -1) { setBoardFocus(ts[0] || cur); return; }
      const ni = i + (dir === 'down' ? 1 : -1);
      if (ni < 0) { try { col.scrollEl.scrollBy(0, -Math.round(col.scrollEl.clientHeight * 0.8)); } catch (e) {} setBoardFocus(ts[0]); return; }
      if (ni >= ts.length) { try { col.scrollEl.scrollBy(0, Math.round(col.scrollEl.clientHeight * 0.8)); } catch (e) {} setBoardFocus(ts[ts.length - 1]); return; }
      setBoardFocus(ts[ni]);
    } else {
      let ni = idx + (dir === 'right' ? 1 : -1);
      ni = Math.max(0, Math.min(cols.length - 1, ni));
      if (ni === idx) return;
      const ts = columnTweets(cols[ni]);
      if (ts.length) setBoardFocus(nearestByY(ts, cur) || ts[0], { col: true });
      else { try { cols[ni].region.scrollIntoView({ inline: 'center', block: 'nearest' }); } catch (e) {} }
    }
  }
  function boardKey(code) {
    switch (code) {
      // While a Snapshot is reading, J/K skip/prev within the read; idle, they move the cursor.
      case 'KeyJ': if (threadActive) skipNext(); else boardMove('down'); return true;
      case 'KeyK': if (threadActive) prevPost(); else boardMove('up'); return true;
      case 'BracketLeft': boardMove('left'); return true;
      case 'BracketRight': boardMove('right'); return true;
      case 'KeyP': case 'KeyR': { const el = boardFocused(); if (el) { setBoardFocus(el); readSinglePost(el); } return true; }
    }
    return false;
  }

  function defaultKey(code) {
    switch (code) {
      case 'KeyR': readSinglePost(focusedTweet()); return true;
      case 'KeyT': startThreadFromFocus(); return true;
      case 'KeyS': fullStop(); return true;
      case 'KeyN': skipNext(); return true;
      case 'KeyB': prevPost(); return true;
      case 'Space': togglePause(); return true;
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
      case 'Space': togglePause(); return true;
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
    // On X Pro, board navigation (J/K move, [ ] columns, P/R read) takes priority;
    // anything it doesn't claim (T thread, S stop, Space pause, speed) falls through.
    let handled = isXPro && boardKey(e.code);
    if (!handled) handled = settings.keymap === 'vim' ? vimKey(e.code) : defaultKey(e.code);
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }, true);

  // --------------------------------------------------------------------------
  // Auto-duck: pause reader when the user plays an AUDIBLE video; resume on end/pause.
  // --------------------------------------------------------------------------
  function maybeDuckOnMedia(v) {
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
  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.t !== 'cmd') return;
    switch (msg.cmd) {
      case 'cycle': cycleMode(); break;
      case 'readTop': { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); const s = isXPro ? boardFocused() : pickUnseen(settings.direction, new Set()); if (s) runThread(s); break; }
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
    console.log(`[Xpeaker] active — chrome.tts + Supertonic voices (mode ${settings.mode})`);
  }
  init();
})();

// Xpeaker — content script (x.com / twitter.com)
// Ported from the tweet-reader-supertonic userscript. DOM work + UI live here; all speech
// goes through the service-worker "speak bridge" (chrome.tts isn't available in content
// scripts). v1: single + thread modes, dynamic Supertonic voices, no host server.

(function () {
  'use strict';

  const SPEED_PRESETS = [1, 1.25, 1.5, 1.75, 2];
  const MODES = ['single', 'thread', 'summary'];
  const SUPERTONIC_INSTALL_URL =
    'https://chromewebstore.google.com/detail/supertonic-text-to-speech/mdoplmghlkjcnegkdhocjbjcncocbdhk';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Dynamic voice state (filled from chrome.tts.getVoices via the bridge)
  let VOICES = [];               // array of voiceName strings (engine/Supertonic voices), sorted
  let supertonicAvailable = false;
  let installToastShown = false;

  // --------------------------------------------------------------------------
  // Settings (chrome.storage.local)
  // --------------------------------------------------------------------------
  const DEFAULTS = {
    voice: '', speed: 1.0,
    announceAuthor: false, readAltText: true,
    authorVoices: {}, autoVoices: false,
    mode: 'single', direction: 'up', postGapMs: 250, maxChars: 4000,
    pauseOnVideo: true, fallbackToNative: false,
    // On-device AI (transformers.js) — cleanup/translate/summary; no server
    aiEnabled: false, aiModel: 'onnx-community/gemma-3-1b-it-ONNX', aiBackend: 'auto',
    aiCleanup: false, aiTranslate: false,
    highlight: 'caption', // 'off' | 'caption' | 'both'
  };
  let settings = Object.assign({}, DEFAULTS);

  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.local.get('settings', (res) => {
        const saved = (res && res.settings) || {};
        settings = Object.assign({}, DEFAULTS, saved, {
          authorVoices: Object.assign({}, saved.authorVoices || {}),
        });
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
    const saved = changes.settings.newValue || {};
    settings = Object.assign({}, DEFAULTS, saved, { authorVoices: Object.assign({}, saved.authorVoices || {}) });
    updateBarControls(); applyModeToButtons();
  });

  function rate() { return clamp(settings.speed, 0.1, 10); }

  // --------------------------------------------------------------------------
  // Speak bridge (client side) — replaces the old fetch + AudioContext pipeline
  // --------------------------------------------------------------------------
  let port = null, seq = 0;
  const waiters = new Map();       // reqId -> { resolve, onStart, onWord }
  const voiceWaiters = new Map();  // reqId -> resolve
  const llmWaiters = new Map();    // reqId -> { resolve, onProgress }

  function connectBridge() {
    port = chrome.runtime.connect({ name: 'xpeaker' });
    port.onMessage.addListener((m) => {
      if (!m) return;
      if (m.t === 'voices') {
        const r = voiceWaiters.get(m.reqId);
        if (r) { voiceWaiters.delete(m.reqId); r(m.voices || []); }
        return;
      }
      if (m.t === 'llm') {
        const w = llmWaiters.get(m.reqId);
        if (w) { llmWaiters.delete(m.reqId); w.resolve(m.error ? '' : (m.result || '')); }
        return;
      }
      if (m.t === 'llm-progress') {
        const w = llmWaiters.get(m.reqId);
        if (w && w.onProgress) w.onProgress(m.progress);
        return;
      }
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
  // On-device AI generation via SW → offscreen (transformers.js). Resolves '' on failure.
  function callLLMBridge(system, user, maxTokens, onProgress) {
    const reqId = ++seq;
    return new Promise((resolve) => {
      llmWaiters.set(reqId, { resolve, onProgress });
      try {
        ensurePort().postMessage({
          t: 'llm', reqId, system, user, maxTokens,
          model: settings.aiModel, backend: settings.aiBackend,
        });
      } catch (e) { llmWaiters.delete(reqId); resolve(''); }
      // generous timeout: first call may download the model
      setTimeout(() => { if (llmWaiters.has(reqId)) { llmWaiters.delete(reqId); resolve(''); } }, 600000);
    });
  }

  // Prefer voices whose name/engine mentions Supertonic; otherwise any ttsEngine-provided
  // voice (extension engines carry extensionId; native OS voices don't). See README note —
  // verify the exact voiceName/extensionId via chrome.tts.getVoices once installed.
  function pickEngineVoices(all) {
    const named = all.filter((v) => /supertonic/i.test(v.voiceName || '') || /supertonic/i.test(v.extensionId || ''));
    if (named.length) return named;
    return all.filter((v) => !!v.extensionId);
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

  // --------------------------------------------------------------------------
  // On-device AI transform (cleanup / translate) before TTS — via the bridge
  // --------------------------------------------------------------------------
  const textCache = new Map();
  const textInflight = new Map();
  function aiActive() { return settings.aiEnabled && (settings.aiCleanup || settings.aiTranslate); }
  function barProgress(pr) {
    if (!pr || pr.status !== 'progress' || !pr.total) return;
    const pct = Math.round((pr.loaded / pr.total) * 100);
    if (Number.isFinite(pct)) setBarState('playing', `Loading model ${pct}%`);
  }
  async function aiTransform(base) {
    if (!base || !aiActive()) return base;
    const key = `${settings.aiCleanup ? 'c' : ''}${settings.aiTranslate ? 't' : ''}|${settings.aiModel}|${base}`;
    if (textCache.has(key)) return textCache.get(key);
    if (textInflight.has(key)) return textInflight.get(key);
    const tasks = [];
    if (settings.aiTranslate) tasks.push('translate it into natural English if it is not already English');
    if (settings.aiCleanup) tasks.push('expand slang and acronyms and replace emoji with a brief spoken description');
    const sys = `You prepare social-media posts to be read aloud by a TTS engine. Rewrite the user's text: ${tasks.join('; ')}. Keep it faithful and concise. Output ONLY the rewritten text — no preamble, no quotes, no notes.`;
    const p = callLLMBridge(sys, base, 256, barProgress)
      .then((out) => { const v = (out || '').trim() || base; textCache.set(key, v); textInflight.delete(key); return v; })
      .catch(() => { textInflight.delete(key); return base; });
    textInflight.set(key, p);
    return p;
  }
  async function spokenTextFor(tweetEl) {
    const base = buildSpokenText(tweetEl);
    return aiActive() ? aiTransform(base) : base;
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
    if (mode === 'both' && !aiActive()) {
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
    isPaused = true; ttsPause(); updateBarControls();
  }
  function resume() {
    if (!isPaused) return;
    isPaused = false; pausedForVideo = false; ttsResume();
    const w = resumeWaiters; resumeWaiters = []; w.forEach((r) => r());
    updateBarControls();
  }
  function togglePause() { if (isPaused) resume(); else pause(); }
  function waitWhilePaused() { return isPaused ? new Promise((r) => resumeWaiters.push(r)) : Promise.resolve(); }
  function fullStop() {
    stopThread(); ttsStop(); activeBtn = null;
    isPaused = false; pausedForVideo = false;
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
    stopThread(); setBarState('idle'); ttsStop(); isPaused = false;
    if (!canSpeak(btn)) return;
    setBtnState(btn, 'loading'); activeBtn = btn;
    const text = await spokenTextFor(tweetEl);
    if (activeBtn !== btn) return;
    if (!text) { flashError(btn); if (activeBtn === btn) activeBtn = null; return; }
    const hl = startHighlight(tweetEl, text);
    const reason = await speakBridge(text, voiceArg(extractAuthor(tweetEl).handle), rate(), {
      onStart: () => { if (activeBtn === btn) setBtnState(btn, 'playing'); },
      onWord: (m) => hl.word(m),
    });
    hl.end();
    if (activeBtn !== btn) return;
    if (reason === 'error') flashError(btn);
    else if (btn.dataset.state === 'playing' || btn.dataset.state === 'loading') setBtnState(btn, 'idle');
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
    stopThread(); ttsStop(); isPaused = false;
    if (!(supertonicAvailable || settings.fallbackToNative)) { setBarState('idle', 'Install Supertonic voices'); showInstallToast(); refreshVoices(); return; }
    const gen = ++threadGen; threadActive = true; navRequest = null;
    const dir = settings.direction; const seen = new Set(); const order = [];
    setBarState('playing', 'Reading…');
    let el = startEl, dryLoads = 0;
    try {
      while (gen === threadGen && el) {
        navRequest = null;
        if (isPaused) { await waitWhilePaused(); if (gen !== threadGen) return; }
        const id = tweetId(el);
        if (!id || !seen.has(id)) {
          if (id) { seen.add(id); order.push(id); }
          const text = await spokenTextFor(el);
          if (gen !== threadGen) { highlight(el, false); return; }
          if (text) {
            try { el.scrollIntoView({ block: 'center' }); } catch (e) {}
            highlight(el, true);
            setBarState('playing', `Reading ${order.length}`);
            // Prefetch the next post's AI transform so its latency hides under this read.
            if (aiActive()) { const nb = neighbor(el, dir, seen); if (nb) spokenTextFor(nb).catch(() => {}); }
            const hl = startHighlight(el, text);
            const reason = await speakBridge(text, voiceArg(extractAuthor(el).handle), rate(), { onWord: (m) => hl.word(m) });
            hl.end();
            highlight(el, false);
            if (gen !== threadGen) return;
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
  // Summary mode (on-device AI): digest the thread from here, then read it aloud
  // --------------------------------------------------------------------------
  async function summarizeFrom(tweetEl) {
    stopThread(); ttsStop(); isPaused = false;
    if (!settings.aiEnabled) { setBarState('idle', 'Enable on-device AI in settings'); chrome.runtime.sendMessage({ t: 'openOptions' }); return; }
    if (!(supertonicAvailable || settings.fallbackToNative)) { setBarState('idle', 'Install Supertonic voices'); showInstallToast(); refreshVoices(); return; }
    const gen = ++threadGen; threadActive = true;
    setBarState('playing', 'Summarizing…');
    try {
      const dir = settings.direction;
      let list = getTimelineTweets(); if (dir === 'up') list = list.slice().reverse();
      const startIdx = list.indexOf(tweetEl);
      const slice = startIdx >= 0 ? list.slice(startIdx) : list;
      const items = []; const seen = new Set();
      for (const el of slice) {
        const id = tweetId(el); if (id && seen.has(id)) continue; if (id) seen.add(id);
        const { name } = extractAuthor(el); const txt = buildSpokenText(el);
        if (txt) items.push(`${name || 'Someone'}: ${txt}`);
        if (items.length >= 40) break;
      }
      if (!items.length) { setBarState('idle', 'Nothing to summarize'); return; }
      const sys = 'You summarize an X/Twitter thread for someone who will listen to it. Give a concise spoken summary (2-5 sentences) capturing the key points and any conclusion or disagreement. Output ONLY the summary, no preamble.';
      const raw = await callLLMBridge(sys, items.join('\n'), 320, barProgress);
      if (gen !== threadGen) return;
      let summary = (raw || '').trim();
      if (!summary) { setBarState('idle', 'No summary (model error?)'); return; }
      if (!/[.!?…]$/.test(summary)) summary += '.';
      setBarState('playing', 'Reading summary');
      const hl = startHighlight(null, summary);
      const reason = await speakBridge(summary, voiceArg(''), rate(), { onWord: (m) => hl.word(m) });
      hl.end();
      if (gen === threadGen && reason !== 'stopped') setBarState('idle', `Summary (${items.length})`);
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
    summary: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h10v2H4z"></path></svg>',
  };
  const BAR_ICON = {
    play: SVG.play, stop: SVG.playing, speaker: SVG.speaker, summary: SVG.summary,
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 6h3v12H7zM14 6h3v12h-3z"></path></svg>',
    next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14l8-7zM16 5h2.2v14H16z"></path></svg>',
    prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14l-8-7zM7.8 5H5.6v14h2.2z"></path></svg>',
    up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4l-8 8h5v8h6v-8h5z"></path></svg>',
    down: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20l8-8h-5V4H9v8H4z"></path></svg>',
    gear: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm0 6a2 2 0 1 1 0-4 2 2 0 0 1 0 4zm9-2c0-.5-.05-1-.13-1.47l1.86-1.45-2-3.46-2.2.9a7.5 7.5 0 0 0-1.27-.74l-.33-2.35h-4l-.33 2.35c-.45.2-.87.45-1.27.74l-2.2-.9-2 3.46 1.86 1.45A8 8 0 0 0 6 12c0 .5.05 1 .13 1.47L4.27 14.9l2 3.46 2.2-.9c.4.3.82.55 1.27.74l.33 2.35h4l.33-2.35c.45-.2.87-.44 1.27-.74l2.2.9 2-3.46-1.86-1.45c.08-.46.13-.96.13-1.45z"></path></svg>',
  };

  function idleIcon() { return settings.mode === 'summary' ? SVG.summary : settings.mode === 'thread' ? SVG.play : SVG.speaker; }
  function setBtnState(btn, state) {
    if (!btn) return;
    btn.dataset.state = state;
    const wrap = btn.querySelector('.xp-iconwrap');
    const icon = state === 'idle' ? idleIcon() : (SVG[state] || idleIcon());
    if (wrap) wrap.innerHTML = icon;
    const label = state === 'playing' ? 'Stop'
      : settings.mode === 'summary' ? 'Summarize the thread from here'
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
      if (settings.mode === 'summary') { summarizeFrom(tweetEl); return; }
      if (settings.mode === 'thread') { runThread(tweetEl); return; }
      const st = btn.dataset.state;
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
  function cycleMode() { stopThread(); ttsStop(); isPaused = false; setBarState('idle'); settings.mode = MODES[(MODES.indexOf(settings.mode) + 1) % MODES.length]; saveSettings(); updateBarControls(); applyModeToButtons(); }

  function updateBarControls() {
    if (!barEl) return;
    const m = settings.mode, thread = m === 'thread', usesDir = m === 'thread' || m === 'summary';
    const modeBtn = barEl.querySelector('[data-act="mode"]');
    if (modeBtn) {
      modeBtn.dataset.mode = m;
      const ic = m === 'summary' ? BAR_ICON.summary : m === 'thread' ? BAR_ICON.play : BAR_ICON.speaker;
      const lbl = m === 'summary' ? 'Summary' : m === 'thread' ? 'Thread' : 'Single';
      modeBtn.innerHTML = ic + `<span class="xpeaker-bar-label">${lbl}</span>`;
      modeBtn.title = `Mode: ${lbl} — click to switch (single → thread → summary)`;
    }
    const dirBtn = barEl.querySelector('[data-act="dir"]');
    if (dirBtn) { const up = settings.direction === 'up'; dirBtn.innerHTML = up ? BAR_ICON.up : BAR_ICON.down; dirBtn.title = up ? 'Direction: up (newer)' : 'Direction: down (older)'; dirBtn.style.display = usesDir ? 'inline-flex' : 'none'; }
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
    document.body.appendChild(barEl);
    updateBarControls();
    refreshVoices();
    setInterval(refreshVoices, 20000);
  }

  // --------------------------------------------------------------------------
  // Keyboard shortcuts
  // --------------------------------------------------------------------------
  let lastHoveredTweet = null;
  document.addEventListener('mouseover', (e) => { const a = e.target.closest && e.target.closest('article[data-testid="tweet"]'); if (a) lastHoveredTweet = a; }, true);
  function focusedTweet() {
    if (lastHoveredTweet && document.contains(lastHoveredTweet)) return lastHoveredTweet;
    const list = getTimelineTweets(); const cy = window.innerHeight / 2; let best = null, bd = Infinity;
    for (const el of list) { const r = el.getBoundingClientRect(); const d = Math.abs(r.top + r.height / 2 - cy); if (d < bd) { bd = d; best = el; } }
    return best;
  }
  document.addEventListener('keydown', (e) => {
    if (!e.altKey || e.metaKey || e.ctrlKey) return;
    const t = e.target;
    if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    let handled = true;
    switch (e.code) {
      case 'KeyR': readSinglePost(focusedTweet()); break;
      case 'KeyT': { const el = focusedTweet(); if (el) { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); runThread(el); } break; }
      case 'KeyS': fullStop(); break;
      case 'KeyN': skipNext(); break;
      case 'KeyB': prevPost(); break;
      case 'Space': togglePause(); break;
      case 'ArrowUp': bumpSpeed(0.25); break;
      case 'ArrowDown': bumpSpeed(-0.25); break;
      default: handled = false;
    }
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
      case 'readTop': { settings.mode = 'thread'; saveSettings(); updateBarControls(); applyModeToButtons(); const s = pickUnseen(settings.direction, new Set()); if (s) runThread(s); break; }
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
    console.log(`[Xpeaker] v1.1.0 active — chrome.tts + Supertonic voices, on-device AI ${settings.aiEnabled ? 'on' : 'off'} (mode ${settings.mode})`);
  }
  init();
})();

// Xpeaker — service worker
// Sole owner of chrome.tts (content scripts can't call it). Acts as the "speak bridge"
// server: content scripts open a long-lived Port and send speak/stop/pause/resume/getVoices
// messages; we relay chrome.tts onEvent callbacks back over the same Port.

'use strict';

// ----------------------------------------------------------------------------
// Port bridge (one per content-script instance / tab)
// ----------------------------------------------------------------------------
const ports = new Set(); // all connected content-script ports (one per tab)
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'xpeaker') return;
  ports.add(port);
  port.onMessage.addListener((msg) => handlePortMessage(port, msg));
  port.onDisconnect.addListener(() => ports.delete(port));
});

function handlePortMessage(port, msg) {
  switch (msg && msg.t) {
    case 'speak': {
      const { reqId, text, voiceName, rate } = msg;
      try { chrome.tts.stop(); } catch (e) {}
      const opts = {
        enqueue: false,
        rate: typeof rate === 'number' ? rate : 1.0,
        onEvent: (e) => {
          try {
            port.postMessage({
              t: 'tts', reqId, ev: e.type,
              charIndex: e.charIndex, length: e.length, message: e.errorMessage,
            });
          } catch (_) { /* port closed */ }
        },
      };
      if (voiceName) opts.voiceName = voiceName;
      try {
        chrome.tts.speak(text, opts);
      } catch (err) {
        try { port.postMessage({ t: 'tts', reqId, ev: 'error', message: String(err) }); } catch (_) {}
      }
      break;
    }
    case 'claim': {
      // Only one tab reads at a time — tell every other tab to stop its reader.
      for (const p of ports) { if (p !== port) { try { p.postMessage({ t: 'yield' }); } catch (_) {} } }
      break;
    }
    case 'stop':   { try { chrome.tts.stop(); } catch (e) {} break; }
    case 'pause':  { try { chrome.tts.pause(); } catch (e) {} break; }
    case 'resume': { try { chrome.tts.resume(); } catch (e) {} break; }
    case 'getVoices': {
      chrome.tts.getVoices((voices) => {
        try { port.postMessage({ t: 'voices', reqId: msg.reqId, voices: voices || [] }); } catch (_) {}
      });
      break;
    }
  }
}

// ----------------------------------------------------------------------------
// One-shot messages (from options/popup pages)
// ----------------------------------------------------------------------------
// Offscreen document — hosts the on-device model (WASM needs a DOM context).
let offscreenReady = null;
async function ensureOffscreen() {
  const existing = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (existing && existing.length) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run the on-device emotion classifier (WASM) for the tweet mood ring.',
    }).catch((e) => { if (!/single offscreen/i.test(String(e))) throw e; }); // ignore "already exists" race
  }
  await offscreenReady;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false; // offscreen doc handles its own
  if (msg.t === 'openOptions') {
    if (msg.focus) chrome.tabs.create({ url: chrome.runtime.getURL('options/options.html#' + encodeURIComponent(String(msg.focus))) }); // deep-link to a setting
    else chrome.runtime.openOptionsPage();
    return false;
  }
  if (msg.t === 'getVoices') { chrome.tts.getVoices((v) => sendResponse(v || [])); return true; }
  if (msg.t === 'stop') { try { chrome.tts.stop(); } catch (e) {} return false; }
  if (msg.t === 'classify' || msg.t === 'moodPing') {
    (async () => {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', t: msg.t === 'moodPing' ? 'ping' : 'classify', text: msg.text });
        sendResponse(res || { ok: false, error: 'no response from offscreen' });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true; // async
  }
  return false;
});

// ----------------------------------------------------------------------------
// Context menus (replace the userscript's GM_registerMenuCommand items)
// ----------------------------------------------------------------------------
const MENU = [
  ['xpeaker-settings', 'Xpeaker: Settings'],
  ['xpeaker-cycle', 'Xpeaker: Cycle mode (single / thread)'],
  ['xpeaker-readtop', 'Xpeaker: Read from top of view'],
  ['xpeaker-focus', 'Xpeaker: Toggle Focus mode'],
  ['xpeaker-stop', 'Xpeaker: Stop'],
];
function buildMenus() {
  chrome.contextMenus.removeAll(() => {
    for (const [id, title] of MENU) {
      chrome.contextMenus.create({
        id, title, contexts: ['all'],
        documentUrlPatterns: ['https://x.com/*', 'https://twitter.com/*'],
      });
    }
  });
}
chrome.runtime.onInstalled.addListener(buildMenus);
chrome.runtime.onStartup.addListener(buildMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const map = {
    'xpeaker-settings': 'settings',
    'xpeaker-cycle': 'cycle',
    'xpeaker-readtop': 'readTop',
    'xpeaker-focus': 'focus',
    'xpeaker-stop': 'stop',
  };
  const cmd = map[info.menuItemId];
  if (!cmd) return;
  if (cmd === 'settings') { chrome.runtime.openOptionsPage(); return; }
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { t: 'cmd', cmd }, () => void chrome.runtime.lastError);
  }
});

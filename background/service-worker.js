// Xpeaker — service worker
// Sole owner of chrome.tts (content scripts can't call it). Acts as the "speak bridge"
// server: content scripts open a long-lived Port and send speak/stop/pause/resume/getVoices
// messages; we relay chrome.tts onEvent callbacks back over the same Port.

'use strict';

// ----------------------------------------------------------------------------
// Offscreen document (on-device transformers.js engine) orchestration
// ----------------------------------------------------------------------------
const llmPorts = new Map(); // reqId -> content Port awaiting an llm result

let offscreenReady = null;
async function ensureOffscreen() {
  let has = false;
  try { has = await chrome.offscreen.hasDocument(); } catch (e) {}
  if (has) return;
  if (!offscreenReady) {
    offscreenReady = chrome.offscreen.createDocument({
      url: 'offscreen/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Run on-device text AI (transformers.js) for TTS cleanup, translate, and summary.',
    }).catch((e) => { if (!String(e).includes('single offscreen')) throw e; })
      .finally(() => { offscreenReady = null; });
  }
  await offscreenReady;
}
// Retry while the offscreen document finishes loading its module + listener.
async function sendToOffscreen(message) {
  for (let i = 0; i < 50; i++) {
    try { return await chrome.runtime.sendMessage(message); }
    catch (e) {
      if (!String(e).includes('Receiving end does not exist')) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error('offscreen not responding');
}

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
    case 'llm': {
      const { reqId } = msg;
      llmPorts.set(reqId, port);
      ensureOffscreen()
        .then(() => sendToOffscreen({
          target: 'offscreen', t: 'ai-generate', reqId,
          payload: {
            system: msg.system, user: msg.user, maxTokens: msg.maxTokens,
            model: msg.model, backend: msg.backend,
          },
        }))
        .then((res) => {
          llmPorts.delete(reqId);
          try { port.postMessage({ t: 'llm', reqId, result: (res && res.ok) ? res.text : '', error: res && res.error }); } catch (_) {}
        })
        .catch((e) => {
          llmPorts.delete(reqId);
          try { port.postMessage({ t: 'llm', reqId, result: '', error: String((e && e.message) || e) }); } catch (_) {}
        });
      break;
    }
  }
}

// ----------------------------------------------------------------------------
// One-shot messages (from options/popup pages)
// ----------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false; // not for us
  if (msg.t === 'openOptions') { chrome.runtime.openOptionsPage(); return false; }
  if (msg.t === 'getVoices') { chrome.tts.getVoices((v) => sendResponse(v || [])); return true; }
  if (msg.t === 'stop') { try { chrome.tts.stop(); } catch (e) {} return false; }
  if (msg.t === 'ai-progress') {
    // Forward model-download progress to the awaiting content port (for the bar).
    const p = llmPorts.get(msg.reqId);
    if (p) { try { p.postMessage({ t: 'llm-progress', reqId: msg.reqId, progress: msg.progress }); } catch (_) {} }
    return false; // also reaches the options page, which listens directly
  }
  return false;
});

// ----------------------------------------------------------------------------
// Context menus (replace the userscript's GM_registerMenuCommand items)
// ----------------------------------------------------------------------------
const MENU = [
  ['xpeaker-settings', 'Xpeaker: Settings'],
  ['xpeaker-cycle', 'Xpeaker: Cycle mode (single / thread / summary)'],
  ['xpeaker-readtop', 'Xpeaker: Read from top of view'],
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
    'xpeaker-stop': 'stop',
  };
  const cmd = map[info.menuItemId];
  if (!cmd) return;
  if (cmd === 'settings') { chrome.runtime.openOptionsPage(); return; }
  if (tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { t: 'cmd', cmd }, () => void chrome.runtime.lastError);
  }
});

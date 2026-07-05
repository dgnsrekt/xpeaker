// Xpeaker offscreen worker — runs the on-device emotion classifier (Transformers.js /
// ONNX-Runtime WASM) that can't run in a content script (x.com CSP) or the service
// worker (no DOM). Loaded by the service worker via chrome.offscreen; answers
// { target:'offscreen', t:'classify'|'ping', text } messages.
//
// Transformers.js is loaded via DYNAMIC import (not a top-level one) so a load/CSP
// failure surfaces as a caught classify error instead of silently killing this whole
// module (which would drop the message listener → "receiving end does not exist").

const MODEL = 'onnx-community/emotion-english-distilroberta-base-ONNX';

let tjPromise = null;
function loadTransformers() {
  if (!tjPromise) {
    tjPromise = import('../vendor/transformers/transformers.min.js').then((m) => {
      m.env.allowLocalModels = false;
      m.env.backends.onnx.wasm.wasmPaths = chrome.runtime.getURL('vendor/transformers/');
      m.env.backends.onnx.wasm.numThreads = 1;
      return m;
    });
  }
  return tjPromise;
}

let clfPromise = null;
async function getClassifier() {
  const { pipeline } = await loadTransformers();
  if (!clfPromise) clfPromise = pipeline('text-classification', MODEL, { device: 'wasm', dtype: 'q8' });
  return clfPromise;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return;
  if (msg.t === 'ping') { sendResponse({ ok: true, pong: true }); return; }
  if (msg.t === 'classify') {
    (async () => {
      const t0 = performance.now();
      try {
        const clf = await getClassifier();
        const result = await clf(msg.text, { top_k: null });
        sendResponse({ ok: true, result, ms: Math.round(performance.now() - t0) });
      } catch (e) {
        console.error('[Xpeaker:offscreen] classify failed', e);
        sendResponse({ ok: false, error: String((e && e.stack) || (e && e.message) || e) });
      }
    })();
    return true; // async response
  }
});
console.log('[Xpeaker:offscreen] ready');

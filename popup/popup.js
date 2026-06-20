// Xpeaker popup — quick controls. Writes settings to storage (content reacts via onChanged);
// Stop is routed to the service worker (chrome.tts.stop) and the active tab (halt thread loop).
'use strict';

const SUPERTONIC_INSTALL_URL = XP.SUPERTONIC_URL;
const SPEED_PRESETS = XP.SPEED_PRESETS;
const pickEngineVoices = XP.pickEngineVoices;

let settings = Object.assign({}, XP.DEFAULTS);
const $ = (id) => document.getElementById(id);

function load() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (res) => {
      settings = XP.mergeSettings(res && res.settings);
      resolve();
    });
  });
}
function save() { chrome.storage.local.set({ settings }); }

function render() {
  $('mode').innerHTML = `Mode: <b>${settings.mode === 'thread' ? 'Thread' : 'Single'}</b>`;
  $('dir').innerHTML = `Dir: <b>${settings.direction}</b>`;
  $('dir').style.opacity = settings.mode === 'thread' ? '1' : '.5';
  $('speed').innerHTML = `Speed: <b>${Math.round(settings.speed * 100) / 100}×</b>`;
}

function checkVoices() {
  chrome.tts.getVoices((all) => {
    const engine = pickEngineVoices(all || []);
    const dot = $('dot');
    if (engine.length) {
      dot.dataset.s = 'ok'; dot.title = `${engine.length} Supertonic voices`;
      $('voicesMsg').innerHTML = '';
    } else {
      dot.dataset.s = 'down'; dot.title = 'No Supertonic voices';
      $('voicesMsg').innerHTML = `No Supertonic voices. <a href="${SUPERTONIC_INSTALL_URL}" target="_blank" rel="noopener">Install →</a>`;
    }
  });
}

function bind() {
  $('mode').onclick = () => { settings.mode = settings.mode === 'thread' ? 'single' : 'thread'; save(); render(); };
  $('dir').onclick = () => { settings.direction = settings.direction === 'up' ? 'down' : 'up'; save(); render(); };
  $('speed').onclick = () => {
    let i = SPEED_PRESETS.findIndex((p) => p >= settings.speed - 0.001);
    i = (i + 1) % SPEED_PRESETS.length; settings.speed = SPEED_PRESETS[i]; save(); render();
  };
  $('stop').onclick = () => {
    chrome.runtime.sendMessage({ t: 'stop' });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs[0] && tabs[0].id != null) {
        chrome.tabs.sendMessage(tabs[0].id, { t: 'cmd', cmd: 'stop' }, () => void chrome.runtime.lastError);
      }
    });
  };
  $('settings').onclick = () => chrome.runtime.openOptionsPage();
}

async function main() { await load(); bind(); render(); checkVoices(); }
main();

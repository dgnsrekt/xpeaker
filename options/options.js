// Xpeaker options page. Extension page → chrome.tts + chrome.storage available directly.
'use strict';

const DEFAULTS = XP.DEFAULTS;
const SUPERTONIC_INSTALL_URL = XP.SUPERTONIC_URL;
const pickEngineVoices = XP.pickEngineVoices;
const SAMPLE = 'This is a sample of this voice reading a tweet aloud. The quick brown fox jumps over the lazy dog.';

function renderKbd() {
  const el = document.getElementById('kbdHelp'); if (!el) return;
  const km = XP.KEYMAPS[settings.keymap] || XP.KEYMAPS.default;
  el.innerHTML = km.keys.map(([k, l]) => `<code>Alt+${k}</code> ${l}`).join(' · ');
}

let settings = Object.assign({}, DEFAULTS);
let allVoices = [];        // raw chrome.tts voices
let engineVoices = [];     // filtered Supertonic / engine voices (objects)
let voiceMeta = {};        // voiceName -> { lang, gender }

const $ = (id) => document.getElementById(id);

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get('settings', (res) => {
      settings = XP.mergeSettings(res && res.settings);
      resolve();
    });
  });
}
function save() { chrome.storage.local.set({ settings }); }

function getVoices() {
  return new Promise((resolve) => { chrome.tts.getVoices((v) => resolve(v || [])); });
}

// ---- preview ----------------------------------------------------------------
function stopPreview() { try { chrome.tts.stop(); } catch (e) {} }
function preview(voiceName) {
  stopPreview();
  const opts = { rate: Number(settings.speed) || 1.0, enqueue: false };
  if (voiceName) opts.voiceName = voiceName;
  try { chrome.tts.speak(SAMPLE, opts); } catch (e) { console.error('[Xpeaker] preview failed', e); }
}

function voiceLabel(v) {
  const lang = v.lang ? ` (${v.lang})` : '';
  const gender = v.gender ? ` · ${v.gender}` : '';
  return `${v.voiceName}${lang}${gender}`;
}
function voiceOptionsHTML(selected) {
  let html = `<option value=""${selected ? '' : ' selected'}>Default (engine picks)</option>`;
  const list = engineVoices.length ? engineVoices : allVoices;
  for (const v of list) {
    const name = v.voiceName || '';
    if (!name) continue;
    const sel = name === selected ? ' selected' : '';
    html += `<option value="${name.replace(/"/g, '&quot;')}"${sel}>${voiceLabel(v)}</option>`;
  }
  return html;
}

function renderStatus() {
  const el = $('status');
  if (engineVoices.length) {
    el.className = 'status ok';
    el.textContent = `✓ ${engineVoices.length} Supertonic voice${engineVoices.length === 1 ? '' : 's'} available.`;
  } else {
    el.className = 'status down';
    el.innerHTML = `No Supertonic voices found. <a href="${SUPERTONIC_INSTALL_URL}" target="_blank" rel="noopener">Install the Supertonic voices extension</a>, then reload this page. ` +
      (allVoices.length ? `Meanwhile you can enable the browser-voice fallback below.` : '');
  }
}

function renderVoiceSelect() { $('voice').innerHTML = voiceOptionsHTML(settings.voice); }

function renderAutoNote() {
  const note = $('autoNote');
  if (settings.autoVoices) {
    note.textContent = 'Auto-voice is ON, so the default voice is only used for posts with no detectable author — each author otherwise gets a hashed voice. Use ▶ Test to preview the exact voice you select.';
  } else {
    note.textContent = 'The “gender” shown next to each voice is what the Supertonic engine reports. Use ▶ Test to hear the selected voice.';
  }
}

function addAuthorRow(handle, voice) {
  const row = document.createElement('div'); row.className = 'row';
  row.innerHTML = `<span class="at">@</span>` +
    `<input type="text" placeholder="handle" />` +
    `<select>${voiceOptionsHTML(voice || '')}</select>` +
    `<button class="btn secondary small test" type="button" title="Preview">▶</button>` +
    `<button class="btn secondary small del" type="button" title="Remove">✕</button>`;
  const input = row.querySelector('input');
  const sel = row.querySelector('select');
  input.value = handle || '';
  row.querySelector('.del').onclick = () => { row.remove(); commitAuthors(); };
  row.querySelector('.test').onclick = () => preview(sel.value);
  input.addEventListener('input', commitAuthors);
  sel.addEventListener('change', commitAuthors);
  $('authorRows').appendChild(row);
}
function commitAuthors() {
  const map = {};
  $('authorRows').querySelectorAll('.row').forEach((r) => {
    const h = (r.querySelector('input').value || '').trim().replace(/^@/, '').toLowerCase();
    const v = r.querySelector('select').value;
    if (h && v) map[h] = v;
  });
  settings.authorVoices = map; save();
}

function bind() {
  $('voice').addEventListener('change', (e) => { settings.voice = e.target.value; save(); });
  $('testVoice').addEventListener('click', () => preview($('voice').value));
  $('stopTest').addEventListener('click', stopPreview);

  const speed = $('speed');
  const updS = () => { $('speedLabel').textContent = `Speed — ${Number(speed.value).toFixed(2)}×`; };
  speed.value = String(settings.speed); updS();
  speed.addEventListener('input', updS);
  speed.addEventListener('change', () => { settings.speed = Number(speed.value); save(); });

  for (const key of ['autoVoices', 'announceAuthor', 'readAltText', 'pauseOnVideo', 'fallbackToNative']) {
    const el = $(key); el.checked = !!settings[key];
    el.addEventListener('change', () => { settings[key] = el.checked; save(); if (key === 'autoVoices') renderAutoNote(); });
  }

  const hl = $('highlight'); if (hl) { if (settings.highlight) hl.value = settings.highlight; hl.addEventListener('change', () => { settings.highlight = hl.value; save(); }); }
  const kmEl = $('keymap'); if (kmEl) { kmEl.value = settings.keymap; kmEl.addEventListener('change', () => { settings.keymap = kmEl.value; save(); renderKbd(); }); }

  $('addAuthor').addEventListener('click', () => addAuthorRow('', settings.voice));
  window.addEventListener('beforeunload', stopPreview);
}

async function main() {
  await loadSettings();
  allVoices = await getVoices();
  engineVoices = pickEngineVoices(allVoices);
  for (const v of allVoices) voiceMeta[v.voiceName] = { lang: v.lang, gender: v.gender };
  bind();
  renderVoiceSelect();
  renderAutoNote();
  renderKbd();
  renderStatus();
  Object.entries(settings.authorVoices).forEach(([h, v]) => addAuthorRow(h, v));
}
main();

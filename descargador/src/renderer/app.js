'use strict';
const $ = (id) => document.getElementById(id);
const api = window.descargador;
const unwrap = async (promise) => {
  const r = await promise;
  if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
  return r.data;
};
const state = { url: null, format: 'mp3', busy: false, path: null };

const show = (...ids) => { for (const id of ['found', 'options', 'working', 'done']) $(id).hidden = !ids.includes(id); };
const notice = (msg) => { const n = $('notice'); n.textContent = msg || ''; n.hidden = !msg; };
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

async function recognize(raw) {
  notice('');
  if (!raw.trim()) { show(); return; }
  try {
    const info = await unwrap(api.probe(raw.trim()));
    state.url = info.url;
    $('title').textContent = info.title;
    $('meta').textContent = [info.artist, fmtTime(info.durationSec)].filter(Boolean).join(' · ');
    const t = $('thumb');
    if (info.thumbnail) { t.src = info.thumbnail; t.hidden = false; } else t.hidden = true;
    $('folder').textContent = await unwrap(api.folder());
    show('found', 'options');
  } catch (e) { state.url = null; show(); notice(e.message); }
}

$('paste').addEventListener('click', async () => {
  try { const t = (await unwrap(api.readClipboard())).trim(); if (t) { $('link').value = t; recognize(t); } else notice('No hay nada copiado.'); }
  catch (e) { notice(e.message); }
});
$('form').addEventListener('submit', (e) => { e.preventDefault(); recognize($('link').value); });
$('link').addEventListener('change', () => recognize($('link').value));

document.querySelectorAll('.seg-btn').forEach((b) => b.addEventListener('click', () => {
  state.format = b.dataset.format;
  document.querySelectorAll('.seg-btn').forEach((x) => { const on = x === b; x.classList.toggle('is-active', on); x.setAttribute('aria-checked', String(on)); });
}));
$('change').addEventListener('click', async () => { try { $('folder').textContent = await unwrap(api.chooseFolder()); } catch (e) { notice(e.message); } });

$('go').addEventListener('click', async () => {
  if (!state.url || state.busy) return;
  state.busy = true; notice('');
  $('fill').style.width = '0%'; $('pct').textContent = '0 %'; $('stage').textContent = 'Descargando…';
  show('found', 'working');
  try {
    const r = await unwrap(api.download({ url: state.url, format: state.format }, (evt) => {
      if (evt.event !== 'progress') return;
      if (evt.stage === 'convert') { $('stage').textContent = 'Convirtiendo…'; $('fill').style.width = '100%'; $('pct').textContent = ''; }
      else { $('fill').style.width = `${evt.pct}%`; $('pct').textContent = `${Math.round(evt.pct)} %`; }
    }));
    state.path = r.path;
    $('done-name').textContent = r.path.split(/[\\/]/).pop();
    show('found', 'done');
  } catch (e) { show('found', 'options'); if (e.code !== 'cancelled') notice(e.message); }
  finally { state.busy = false; }
});
$('cancel').addEventListener('click', () => unwrap(api.cancel()).catch(() => {}));
$('show').addEventListener('click', () => state.path && unwrap(api.show(state.path)).catch(() => {}));
$('again').addEventListener('click', () => { $('link').value = ''; state.url = null; notice(''); show(); $('link').focus(); });
show();

// Aviso de versión nueva (solo avisa; no instala nada solo)
(async () => {
  try {
    const r = await window.descargador.checkUpdate();
    if (r && r.ok && r.data.available) {
      document.getElementById('update-text').textContent = 'Hay una versión nueva disponible.';
      document.getElementById('update').hidden = false;
      document.getElementById('update-go').addEventListener('click', () => window.descargador.openUpdate());
    }
  } catch { /* sin conexión: no pasa nada */ }
})();

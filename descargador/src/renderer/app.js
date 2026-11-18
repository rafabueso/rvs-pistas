'use strict';
const $ = (id) => document.getElementById(id);
const api = window.descargador;
const unwrap = async (promise) => {
  const r = await promise;
  if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
  return r.data;
};
const state = { url: null, busy: false, first: null, want: { original: true, karaoke: true, voz: false } };

const show = (...ids) => { for (const id of ['found', 'options', 'working', 'done']) $(id).hidden = !ids.includes(id); };
const notice = (msg) => { const n = $('notice'); n.textContent = msg || ''; n.hidden = !msg; };
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
const baseName = (p) => p.split(/[\\/]/).pop();
const plural = (n) => (n === 1 ? '1 archivo' : `${n} archivos`);

// Iconos de trazo (solo cadenas fijas de la app; los nombres de archivo van siempre con textContent)
const ICONS = {
  check: '<path d="M5 12.5 10 17.5 19 7"/>', circle: '<circle cx="12" cy="12" r="8"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  music: '<path d="M9 18V6l10-2v12"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="16" r="2.5"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5.5 11a6.5 6.5 0 0 0 13 0"/><path d="M12 17.5V21"/>',
  wave: '<path d="M4 10v4"/><path d="M8 7v10"/><path d="M12 4v16"/><path d="M16 8v8"/><path d="M20 10.5v3"/>',
  folder: '<path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  download: '<path d="M12 4v11"/><path d="M7.5 11 12 15.5 16.5 11"/><path d="M5 19h14"/>',
};
const svg = (name, cls = 'ic') => {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('class', cls); s.setAttribute('aria-hidden', 'true'); s.innerHTML = ICONS[name]; return s;
};

// ---- Enlace ----
async function recognize(raw) {
  notice('');
  $('clear').hidden = !raw.trim();
  if (!raw.trim()) { show(); return; }
  try {
    const info = await unwrap(api.probe(raw.trim()));
    state.url = info.url;
    $('title').textContent = info.title;
    $('meta').textContent = [info.artist, fmtTime(info.durationSec)].filter(Boolean).join(' · ');
    const t = $('thumb');
    if (info.thumbnail) { t.src = info.thumbnail; t.hidden = false; } else t.hidden = true;
    $('folder').textContent = baseName(await unwrap(api.folder()));
    updateGo();
    show('found', 'options');
  } catch (e) { state.url = null; show(); notice(e.message); }
}
$('paste').addEventListener('click', async () => {
  try { const t = (await unwrap(api.readClipboard())).trim(); if (t) { $('link').value = t; recognize(t); } else notice('No hay nada copiado.'); }
  catch (e) { notice(e.message); }
});
$('form').addEventListener('submit', (e) => { e.preventDefault(); recognize($('link').value); });
$('link').addEventListener('change', () => recognize($('link').value));
$('link').addEventListener('input', () => { $('clear').hidden = !$('link').value; });
$('clear').addEventListener('click', () => { $('link').value = ''; state.url = null; notice(''); $('clear').hidden = true; show(); $('link').focus(); });

// ---- Qué guardar ----
function updateGo() {
  const n = Object.values(state.want).filter(Boolean).length;
  const files = n;
  $('go').disabled = n === 0;
  $('go-text').textContent = n === 0 ? 'Marca algo para guardar' : `Descargar · ${plural(files)}`;
}
document.querySelectorAll('.toggle').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.want; state.want[k] = !state.want[k];
  b.classList.toggle('is-on', state.want[k]); b.setAttribute('aria-checked', String(state.want[k]));
  const mark = b.querySelector('.mark'); mark.innerHTML = state.want[k] ? ICONS.check : ICONS.circle;
  updateGo();
}));
$('change').addEventListener('click', async () => { try { $('folder').textContent = baseName(await unwrap(api.chooseFolder())); } catch (e) { notice(e.message); } });

// ---- Pasos del trabajo ----
let steps = [];
function renderSteps() {
  const ul = $('steps'); ul.textContent = '';
  for (const s of steps) {
    const li = document.createElement('li'); li.className = `step is-${s.state}`;
    const line = document.createElement('div'); line.className = 'step-line';
    line.append(svg(s.state === 'done' ? 'check' : s.state === 'now' ? 'clock' : 'circle'));
    const label = document.createElement('span'); label.className = 'label'; label.textContent = s.label;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = s.state === 'done' ? 'Hecho' : s.state === 'now' ? 'En marcha' : 'En espera';
    line.append(label, tag); li.append(line);
    if (s.state === 'now') {
      const row = document.createElement('div'); row.className = 'bar-row';
      const bar = document.createElement('div'); bar.className = 'bar'; bar.setAttribute('role', 'progressbar'); bar.setAttribute('aria-valuemin', '0'); bar.setAttribute('aria-valuemax', '100'); bar.setAttribute('aria-valuenow', String(Math.round(s.pct)));
      const fill = document.createElement('div'); fill.className = 'fill'; fill.style.width = `${s.pct}%`; bar.append(fill);
      const pct = document.createElement('span'); pct.className = 'pct'; pct.textContent = s.pct ? `${Math.round(s.pct)} %` : '';
      row.append(bar, pct); li.append(row);
    }
    ul.append(li);
  }
}
const sepLabel = (karaoke, voz) => (karaoke && voz ? 'Haciendo el karaoke y la solo voz' : karaoke ? 'Haciendo el karaoke' : 'Sacando la voz');
function startSteps(withDownload, karaoke, voz) {
  steps = [];
  if (withDownload) steps.push({ key: 'download', label: 'Descargando el audio', state: 'now', pct: 0 });
  if (karaoke || voz) steps.push({ key: 'sep', label: sepLabel(karaoke, voz), state: withDownload ? 'wait' : 'now', pct: 0 });
  $('working-title').textContent = 'Preparando tus archivos';
  renderSteps();
}
function onProgress(evt) {
  if (evt.event !== 'progress') return;
  const key = evt.step || 'sep';
  const i = steps.findIndex((s) => s.key === key); if (i < 0) return;
  steps.forEach((s, j) => { if (j < i) s.state = 'done'; });
  steps[i].state = 'now';
  if (evt.stage === 'convert') steps[i].pct = 100; else steps[i].pct = evt.pct;
  if (evt.message && key === 'sep' && evt.stage === 'model') steps[i].label = 'Preparando el modelo (solo la primera vez)';
  else if (key === 'sep') steps[i].label = sepLabel(...steps[i].mode);
  renderSteps();
}

// ---- Resultado ----
function showDone(paths, folderName) {
  state.first = paths[0];
  $('done-title').textContent = `Listo · ${plural(paths.length)} en ${folderName}`;
  const ul = $('done-files'); ul.textContent = '';
  paths.forEach((p) => {
    const li = document.createElement('li'); const n = baseName(p);
    li.append(svg(/\(karaoke\)/i.test(n) ? 'mic' : /\(solo voz\)/i.test(n) ? 'wave' : 'music'));
    const t = document.createElement('span'); t.textContent = n; li.append(t); ul.append(li);
  });
  show('found', 'done');
}

$('go').addEventListener('click', async () => {
  if (!state.url || state.busy) return;
  const w = { ...state.want };
  if (!w.original && !w.karaoke && !w.voz) return;
  state.busy = true; notice(''); setRecentBusy(true);
  startSteps(true, w.karaoke, w.voz);
  steps.forEach((s) => { s.mode = [w.karaoke, w.voz]; });
  show('found', 'working');
  try {
    const r = await unwrap(api.make({ url: state.url, format: $('format').value, want: w }, onProgress));
    showDone(r.paths, baseName(r.folder));
  } catch (e) { show('found', 'options'); if (e.code !== 'cancelled') notice(e.message); }
  finally { state.busy = false; setRecentBusy(false); loadRecent(); }
});
$('cancel').addEventListener('click', () => unwrap(api.cancel()).catch(() => {}));
$('show').addEventListener('click', () => state.first && unwrap(api.show(state.first)).catch(() => {}));
$('again').addEventListener('click', () => { $('link').value = ''; state.url = null; notice(''); $('clear').hidden = true; show(); $('link').focus(); });

// ---- Últimas descargas ----
async function makeFrom(path, mode) {
  if (state.busy) return;
  state.busy = true; notice(''); setRecentBusy(true);
  startSteps(false, mode === 'karaoke', mode === 'voz');
  steps.forEach((s) => { s.mode = [mode === 'karaoke', mode === 'voz']; });
  show('working');
  try {
    const r = await unwrap(api.karaoke({ path, mode }, onProgress));
    showDone(r.paths || [r.path], baseName(r.path.replace(/[\\/][^\\/]*$/, '')));
  } catch (e) { show(); if (e.code !== 'cancelled') notice(e.message); }
  finally { state.busy = false; setRecentBusy(false); loadRecent(); }
}
function setRecentBusy(b) { document.querySelectorAll('#recent .chip, #recent .icon-btn').forEach((x) => { x.disabled = b; }); }
function chip(text, icon, cls, onClick) {
  const b = document.createElement('button'); b.type = 'button'; b.className = `chip ${cls || ''}`; b.append(svg(icon)); b.append(document.createTextNode(text)); b.addEventListener('click', onClick); return b;
}
function renderRecent(items) {
  $('recent').hidden = false;
  const ul = $('recent-list'); ul.textContent = '';
  if (!items.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = 'Aquí aparecerán tus descargas.'; ul.append(li); return; }
  for (const it of items.slice(0, 5)) {
    const li = document.createElement('li'); li.className = 'recent-row';
    li.append(svg('music'));
    const name = document.createElement('span'); name.className = 'recent-name'; name.textContent = it.name;
    const acts = document.createElement('span'); acts.className = 'recent-actions';
    if (!it.processed) {
      acts.append(it.karaoke ? chip('Karaoke listo', 'check', 'is-ready', () => api.showRecent(it.path, 'karaoke')) : chip('Karaoke', 'mic', '', () => makeFrom(it.path, 'karaoke')));
      acts.append(it.voz ? chip('Solo voz listo', 'check', 'is-ready is-voz', () => api.showRecent(it.path, 'voz')) : chip('Solo voz', 'wave', 'is-voz', () => makeFrom(it.path, 'voz')));
    }
    const f = document.createElement('button'); f.type = 'button'; f.className = 'icon-btn'; f.setAttribute('aria-label', 'Mostrar en la carpeta'); f.append(svg('folder'));
    f.addEventListener('click', () => api.showRecent(it.path, 'orig'));
    acts.append(f);
    li.append(name, acts); ul.append(li);
  }
  setRecentBusy(state.busy);
}
async function loadRecent() { try { renderRecent(await unwrap(api.recent())); } catch { /* sin lista */ } }
$('pick').addEventListener('click', async () => { try { const p = await unwrap(api.pickFile()); if (p) await loadRecent(); } catch (e) { notice(e.message); } });
show(); updateGo(); loadRecent();

// Aviso de versión nueva (solo avisa; no instala nada solo)
(async () => {
  try {
    const r = await window.descargador.checkUpdate();
    if (r && r.ok && r.data.available) {
      $('update-text').textContent = 'Hay una versión nueva disponible.';
      $('update').hidden = false;
      $('update-go').addEventListener('click', () => window.descargador.openUpdate());
    }
  } catch { /* sin conexión: no pasa nada */ }
})();

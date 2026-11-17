import { Player, decodeStems } from './player.js';
import { renderToWav } from './vendor/dsp.js';

const $ = (id) => document.getElementById(id);

// Convierte { ok, data | error } del puente en un valor o un Error con código.
const unwrap = async (promise) => {
  const r = await promise;
  if (!r.ok) { const e = new Error(r.error.message); e.code = r.error.code; throw e; }
  return r.data;
};
const api = {
  readClipboard: () => unwrap(window.pistas.readClipboard()),
  probe: (u) => unwrap(window.pistas.probe(u)),
  pickFile: () => unwrap(window.pistas.pickFile()),
  process: (o, cb) => unwrap(window.pistas.process(o, cb)),
  cancel: (id) => unwrap(window.pistas.cancel(id)),
  library: () => unwrap(window.pistas.library()),
  remove: (id) => unwrap(window.pistas.remove(id)),
  saveExport: (w, f, n) => unwrap(window.pistas.saveExport(w, f, n)),
};
const NOTES = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];
const TRACKS = [
  { id: 'voz', label: '🎤 Voz principal', cls: 't-voz', wave: '#1550a6' },
  { id: 'coros', label: '👥 Coros', cls: 't-coros', wave: '#a83f06' },
  { id: 'musica', label: '🎸 Música', cls: 't-musica', wave: '#082a49' },
];

const state = {
  project: null, player: null, peaks: [], seconds: 0,
  gains: [1, 1, 1], muted: [false, false, false], solo: [false, false, false],
  tempo: 1, semitones: 0, pos: 0, found: null, jobId: null, busy: false, exporting: false,
};

// ---------- utilidades ----------
const fmtTime = (s) => { s = Math.max(0, Math.floor(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const keyName = (key, shift = 0) => `${NOTES[(((key.tonic + shift) % 12) + 12) % 12]} ${key.mode}`;

let noticeTimer = null;
function notice(text, kind = 'error') {
  const el = $('notice');
  el.textContent = text;
  el.className = `notice${kind === 'info' ? ' info' : ''}`;
  el.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.hidden = true; }, kind === 'info' ? 5000 : 12000);
}
const clearNotice = () => { $('notice').hidden = true; };
const errText = (e) => (e && e.message) || 'Ha ocurrido un error inesperado.';

function show(view) {
  for (const v of ['home', 'working', 'player', 'library']) $(`view-${v}`).hidden = v !== view;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.go === (view === 'library' ? 'library' : 'home')));
  window.scrollTo(0, 0);
}

function songCard(p, onOpen, onDelete) {
  const card = document.createElement('div');
  card.className = 'song';
  const title = document.createElement('b'); title.textContent = p.title;
  const artist = document.createElement('span'); artist.className = 'muted'; artist.textContent = p.artist || 'Sin artista';
  const meta = document.createElement('span'); meta.className = 'tag';
  meta.textContent = `${fmtTime(p.durationSec)} · ${keyName(p.key)} · ${Math.round(p.bpm)} BPM`;
  const actions = document.createElement('div'); actions.className = 'song-actions';
  const openBtn = document.createElement('button'); openBtn.type = 'button'; openBtn.className = 'btn btn-soft'; openBtn.textContent = 'Abrir';
  openBtn.addEventListener('click', () => onOpen(p));
  actions.append(openBtn);
  if (onDelete) {
    const del = document.createElement('button'); del.type = 'button'; del.className = 'link'; del.textContent = 'Borrar';
    del.addEventListener('click', () => onDelete(p));
    actions.append(del);
  }
  card.append(title, artist, meta, actions);
  return card;
}

async function refreshLibrary() {
  let list = [];
  try { list = await api.library(); } catch (e) { notice(errText(e)); }
  const lib = $('library-list'); lib.replaceChildren();
  list.forEach((p) => lib.append(songCard(p, openProject, async (x) => {
    if (!confirm(`¿Borrar «${x.title}» de la biblioteca? No se puede deshacer.`)) return;
    await api.remove(x.id); refreshLibrary();
  })));
  $('library-empty').hidden = list.length > 0;
  const recent = $('recent-list'); recent.replaceChildren();
  list.slice(0, 3).forEach((p) => recent.append(songCard(p, openProject)));
  $('recent').hidden = list.length === 0;
}

// ---------- inicio: reconocer enlace ----------
async function recognize(raw) {
  clearNotice();
  $('found').hidden = true; state.found = null;
  const btn = $('recognize'); btn.disabled = true; btn.textContent = 'Reconociendo…';
  try {
    const info = await api.probe(raw);
    state.found = info;
    $('found-title').textContent = info.title;
    $('found-meta').textContent = `${info.artist ? info.artist + ' · ' : ''}${fmtTime(info.durationSec)}`;
    const img = $('found-thumb');
    if (info.thumbnail) { img.src = info.thumbnail; img.hidden = false; } else { img.removeAttribute('src'); img.hidden = true; }
    $('found').hidden = false;
  } catch (e) { notice(errText(e)); } finally { btn.disabled = false; btn.textContent = 'Reconocer'; }
}

$('link-form').addEventListener('submit', (e) => { e.preventDefault(); const v = $('link').value.trim(); if (v) recognize(v); });
$('paste').addEventListener('click', async () => {
  try { const t = (await api.readClipboard()).trim(); if (t) { $('link').value = t; recognize(t); } else notice('No hay nada copiado.', 'info'); }
  catch (e) { notice(errText(e)); }
});
$('found-go').addEventListener('click', () => startJob({ url: state.found.url }, state.found.title));

// ---------- inicio: archivos ----------
async function pickFile() {
  try { const p = await api.pickFile(); if (p) startJob({ filePath: p }, p.split(/[\\/]/).pop().replace(/\.[^.]+$/, '')); }
  catch (e) { notice(errText(e)); }
}
$('pick').addEventListener('click', (e) => { e.stopPropagation(); pickFile(); });
$('drop').addEventListener('click', pickFile);
$('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pickFile(); } });
['dragenter', 'dragover'].forEach((t) => $('drop').addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.add('is-over'); }));
['dragleave', 'drop'].forEach((t) => $('drop').addEventListener(t, (e) => { e.preventDefault(); $('drop').classList.remove('is-over'); }));
$('drop').addEventListener('drop', (e) => {
  const f = e.dataTransfer.files[0];
  if (!f) return;
  const p = window.pistas.pathForFile(f);
  if (p) startJob({ filePath: p }, f.name.replace(/\.[^.]+$/, ''));
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- procesar ----------
const STAGE_ORDER = ['download', 'decode', 'separate', 'split', 'save'];
const STAGE_TEXT = { download: 'Descargando el audio', decode: 'Leyendo el audio', separate: 'Separando la voz de la música', split: 'Separando coros y voz principal', save: 'Guardando las pistas', analyze: 'Calculando tempo y tonalidad', done: 'Listo' };

function paintProgress(evt, fromUrl) {
  const stage = evt.stage === 'analyze' || evt.stage === 'done' ? 'save' : evt.stage;
  $('bar-fill').style.width = `${evt.pct}%`;
  $('bar').setAttribute('aria-valuenow', String(Math.round(evt.pct)));
  $('work-stage').textContent = `${STAGE_TEXT[evt.stage] || evt.message || 'Trabajando'} · ${Math.round(evt.pct)} %`;
  const idx = STAGE_ORDER.indexOf(stage);
  document.querySelectorAll('#steps li').forEach((li) => {
    const i = STAGE_ORDER.indexOf(li.dataset.stage);
    li.hidden = li.dataset.stage === 'download' && !fromUrl;
    li.classList.toggle('is-done', i < idx || evt.stage === 'done');
    li.classList.toggle('is-now', i === idx && evt.stage !== 'done');
  });
}

async function startJob(source, title) {
  if (state.busy) return;
  state.busy = true; clearNotice();
  state.jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const fromUrl = !!source.url;
  $('work-title').textContent = title || 'Tu canción';
  paintProgress({ stage: fromUrl ? 'download' : 'decode', pct: 0 }, fromUrl);
  show('working');
  try {
    const project = await api.process({ jobId: state.jobId, ...source, title }, (evt) => { if (evt.event === 'progress') paintProgress(evt, fromUrl); });
    state.busy = false;
    await refreshLibrary();
    await openProject(project);
  } catch (e) {
    state.busy = false;
    show('home');
    if (e.code !== 'cancelled') notice(errText(e));
  }
}
$('cancel').addEventListener('click', () => { if (state.jobId) api.cancel(state.jobId); });

// ---------- reproductor ----------
function buildTracks() {
  const root = $('tracks'); root.replaceChildren();
  TRACKS.forEach((t, i) => {
    const row = document.createElement('div'); row.className = `track ${t.cls}`;
    const ctl = document.createElement('div'); ctl.className = 'track-ctl';
    const name = document.createElement('span'); name.className = 'track-name'; name.textContent = t.label;
    const btns = document.createElement('div'); btns.className = 'track-btns';
    const m = document.createElement('button'); m.type = 'button'; m.className = 'pill m'; m.textContent = 'Silenciar'; m.setAttribute('aria-pressed', 'false'); m.id = `mute-${i}`;
    const s = document.createElement('button'); s.type = 'button'; s.className = 'pill s'; s.textContent = 'Solo'; s.setAttribute('aria-pressed', 'false'); s.id = `solo-${i}`;
    btns.append(m, s);
    const vol = document.createElement('input'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.value = '100'; vol.id = `vol-${i}`;
    vol.setAttribute('aria-label', `Volumen de ${t.label.slice(3)}`);
    ctl.append(name, btns, vol);
    const wave = document.createElement('div'); wave.className = 'wave'; wave.id = `wave-${i}`;
    const canvas = document.createElement('canvas'); const head = document.createElement('div'); head.className = 'playhead'; head.id = `head-${i}`;
    wave.append(canvas, head);
    row.append(ctl, wave); root.append(row);
    m.addEventListener('click', () => { state.muted[i] = !state.muted[i]; applyGains(); });
    s.addEventListener('click', () => { state.solo[i] = !state.solo[i]; applyGains(); });
    vol.addEventListener('input', () => { state.gains[i] = Number(vol.value) / 100; applyGains(); });
    wave.addEventListener('click', (e) => { const r = wave.getBoundingClientRect(); seekTo(((e.clientX - r.left) / r.width) * state.seconds); });
  });
}

const effectiveGain = (i) => {
  const anySolo = state.solo.some(Boolean);
  if (anySolo ? !state.solo[i] : state.muted[i]) return 0;
  return state.gains[i];
};
function applyGains() {
  TRACKS.forEach((_, i) => {
    state.player.setGain(i, effectiveGain(i));
    $(`mute-${i}`).setAttribute('aria-pressed', String(state.muted[i]));
    $(`solo-${i}`).setAttribute('aria-pressed', String(state.solo[i]));
    $(`wave-${i}`).style.opacity = effectiveGain(i) === 0 ? '0.4' : '1';
  });
}

function drawWaves() {
  TRACKS.forEach((t, i) => {
    const wave = $(`wave-${i}`); const canvas = wave.querySelector('canvas');
    const w = wave.clientWidth, h = wave.clientHeight, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h); g.fillStyle = t.wave;
    const p = state.peaks[i]; const max = Math.max(0.05, ...p);
    const bw = w / p.length;
    for (let x = 0; x < p.length; x++) {
      const amp = Math.max(1, (p[x] / max) * (h / 2 - 2));
      g.fillRect(x * bw, h / 2 - amp, Math.max(1, bw - 0.4), amp * 2);
    }
  });
}

function setPosition(seconds) {
  state.pos = seconds;
  const pct = state.seconds ? Math.min(100, (seconds / state.seconds) * 100) : 0;
  TRACKS.forEach((_, i) => { $(`head-${i}`).style.left = `${pct}%`; });
  $('time').textContent = `${fmtTime(seconds)} / ${fmtTime(state.seconds)}`;
}
function seekTo(seconds) { state.player.seek(Math.max(0, Math.min(state.seconds, seconds))); setPosition(seconds); }

function setPlayIcon(playing) { $('play').textContent = playing ? '⏸' : '▶'; $('play').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir'); }

async function openProject(p) {
  clearNotice();
  if (state.player) { state.player.dispose(); state.player = null; }
  state.project = p; state.gains = [1, 1, 1]; state.muted = [false, false, false]; state.solo = [false, false, false];
  state.tempo = 1; state.semitones = 0;
  $('song-title').textContent = p.title; $('song-artist').textContent = p.artist || '';
  $('chip-key').textContent = keyName(p.key); $('chip-bpm').textContent = `${Math.round(p.bpm)} BPM`;
  $('speed').value = '100'; buildTracks(); refreshControls();
  $('export-status').textContent = ''; setPlayIcon(false);
  show('player');
  $('time').textContent = 'Cargando pistas…';
  try {
    const player = new Player((s) => setPosition(s), () => { setPlayIcon(false); seekTo(0); });
    state.player = player;
    const { peaks, seconds } = await player.load(p.id);
    state.peaks = peaks; state.seconds = seconds;
    drawWaves(); applyGains(); setPosition(0);
  } catch (e) { notice(errText(e)); show('library'); refreshLibrary(); }
}

function refreshControls() {
  const p = state.project; if (!p) return;
  const pct = Math.round(state.tempo * 100);
  $('speed-out').textContent = `${pct} %`;
  $('speed-bpm').textContent = `≈ ${Math.round(p.bpm * state.tempo)} BPM`;
  const s = state.semitones;
  $('pitch-val').textContent = s > 0 ? `+${s}` : String(s);
  $('pitch-out').textContent = s === 0 ? 'original' : `${s > 0 ? '+' : ''}${s} semitonos`;
  $('pitch-key').textContent = s === 0 ? keyName(p.key) : `${keyName(p.key)} → ${keyName(p.key, s)}`;
  $('pitch-down').disabled = s <= -6; $('pitch-up').disabled = s >= 6;
}

$('play').addEventListener('click', async () => {
  const pl = state.player; if (!pl || !pl.node) return;
  if (pl.playing) { pl.pause(); setPlayIcon(false); } else { await pl.play(); setPlayIcon(true); }
});
$('restart').addEventListener('click', () => state.player && seekTo(0));
$('speed').addEventListener('input', () => { state.tempo = Number($('speed').value) / 100; state.player.setTempo(state.tempo); refreshControls(); });
$('speed-reset').addEventListener('click', () => { $('speed').value = '100'; state.tempo = 1; state.player.setTempo(1); refreshControls(); });
const setPitch = (v) => { state.semitones = Math.max(-6, Math.min(6, v)); state.player.setSemitones(state.semitones); refreshControls(); };
$('pitch-down').addEventListener('click', () => setPitch(state.semitones - 1));
$('pitch-up').addEventListener('click', () => setPitch(state.semitones + 1));
document.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => {
  const k = b.dataset.preset;
  state.solo = [false, false, false];
  state.muted = k === 'all' ? [false, false, false] : k === 'karaoke' ? [true, true, false] : k === 'backing' ? [true, false, false] : [false, true, true];
  applyGains();
}));
window.addEventListener('keydown', (e) => {
  if ($('view-player').hidden || !state.player) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (e.key === ' ' && tag !== 'BUTTON' && tag !== 'INPUT') { e.preventDefault(); $('play').click(); }
  else if (e.key === 'ArrowLeft' && tag !== 'INPUT') seekTo(state.pos - 5);
  else if (e.key === 'ArrowRight' && tag !== 'INPUT') seekTo(state.pos + 5);
});

// ---------- exportar ----------
async function exportMix(format) {
  if (state.exporting || !state.player) return;
  state.exporting = true;
  const buttons = [$('export-wav'), $('export-mp3')]; buttons.forEach((b) => { b.disabled = true; });
  const status = $('export-status');
  try {
    status.textContent = 'Preparando las pistas…';
    const ctx = new AudioContext({ sampleRate: 44100 });
    let stems;
    try { stems = await decodeStems(state.project.id, ctx); } finally { ctx.close().catch(() => {}); }
    const blob = await renderToWav(stems, {
      gains: [0, 1, 2].map(effectiveGain), tempo: state.tempo, semitones: state.semitones, sampleRate: 44100,
      onProgress: (p) => { status.textContent = `Creando la mezcla… ${Math.round(p * 100)} %`; },
    });
    status.textContent = 'Elige dónde guardarla…';
    const parts = [state.project.title];
    if (state.tempo !== 1) parts.push(`${Math.round(state.tempo * 100)}%`);
    if (state.semitones !== 0) parts.push(`${state.semitones > 0 ? '+' : ''}${state.semitones}st`);
    const path = await api.saveExport(await blob.arrayBuffer(), format, parts.join(' · '));
    status.textContent = path ? 'Guardada ✓' : '';
    if (path) notice('Mezcla guardada.', 'info');
  } catch (e) { status.textContent = ''; notice(errText(e)); } finally { state.exporting = false; buttons.forEach((b) => { b.disabled = false; }); }
}
$('export-wav').addEventListener('click', () => exportMix('wav'));
$('export-mp3').addEventListener('click', () => exportMix('mp3'));

// ---------- navegación ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  if (state.busy) return;
  if (t.dataset.go === 'library') { refreshLibrary(); show('library'); } else show('home');
}));
$('back').addEventListener('click', () => { if (state.player) { state.player.pause(); setPlayIcon(false); } refreshLibrary(); show('library'); });
window.addEventListener('resize', () => { if (!$('view-player').hidden && state.peaks.length) drawWaves(); });

refreshLibrary();

// Aviso de versión nueva (solo avisa; no instala nada solo)
(async () => {
  try {
    const r = await window.pistas.checkUpdate();
    if (r && r.ok && r.data.available) {
      document.getElementById('update-text').textContent = 'Hay una versión nueva disponible.';
      document.getElementById('update').hidden = false;
      document.getElementById('update-go').addEventListener('click', () => window.pistas.openUpdate());
    }
  } catch { /* sin conexión: no pasa nada */ }
})();

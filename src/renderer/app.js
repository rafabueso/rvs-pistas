import { Player, decodeStems } from './player.js';
import { renderToWav, detectStart, voicePhrases, makeSorpresa, makeAyuda, estimateBeats, normalizeZones, addZone, snapTime, zonesToFrames, zoneLevels, setLevel, shiftLevel, SORPRESA_NIVELES } from './vendor/dsp.js';

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
  view: { start: 0, span: 0 }, peakMax: [],
  estudio: freshEstudio(),
};

function freshEstudio() {
  return {
    trim: false, start: 0, auto: 0, nivel: 'normales', seed: 1, zones: [], sel: [], target: 'all', coros: true, phrases: [],
    vozSeg: 4, gap: 1.5, bpm: 0, bpm0: 0, g0: 0, cands: [], candIdx: 0, metro: 0, metroVol: 0.6, count: 0, countStep: 1, flip: 0, env: null, fps: 100,
  };
}

// ---------- utilidades ----------
const TEMPOS = [[60, 'Largo'], [76, 'Adagio'], [108, 'Andante'], [120, 'Moderato'], [156, 'Allegro'], [176, 'Vivace']];
const tempoName = (bpm) => (TEMPOS.find(([m]) => bpm < m) || [0, 'Presto'])[1];
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
  root.append(buildStrip());
  TRACKS.forEach((t, i) => {
    const row = document.createElement('div'); row.className = `track ${t.cls}`;
    const ctl = document.createElement('div'); ctl.className = 'track-ctl';
    const name = document.createElement('span'); name.className = 'track-name'; name.textContent = t.label;
    const line = document.createElement('div'); line.className = 'track-line';
    const vol = document.createElement('input'); vol.type = 'range'; vol.min = '0'; vol.max = '100'; vol.value = '100'; vol.id = `vol-${i}`;
    vol.setAttribute('aria-label', `Volumen de ${t.label.slice(3)}`);
    const m = document.createElement('button'); m.type = 'button'; m.className = 'pill m'; m.textContent = 'M'; m.title = 'Silenciar'; m.setAttribute('aria-label', 'Silenciar'); m.setAttribute('aria-pressed', 'false'); m.id = `mute-${i}`;
    const s = document.createElement('button'); s.type = 'button'; s.className = 'pill s'; s.textContent = 'S'; s.title = 'Solo'; s.setAttribute('aria-label', 'Solo'); s.setAttribute('aria-pressed', 'false'); s.id = `solo-${i}`;
    line.append(vol, m, s);
    ctl.append(name, line);
    const wave = document.createElement('div'); wave.className = 'wave'; wave.id = `wave-${i}`;
    const canvas = document.createElement('canvas'); const head = document.createElement('div'); head.className = 'playhead'; head.id = `head-${i}`;
    wave.append(canvas, head);
    row.append(ctl, wave); root.append(row);
    m.addEventListener('click', () => { state.muted[i] = !state.muted[i]; applyGains(); });
    s.addEventListener('click', () => { state.solo[i] = !state.solo[i]; applyGains(); });
    vol.addEventListener('input', () => { state.gains[i] = Number(vol.value) / 100; applyGains(); });
    wave.addEventListener('click', (e) => seekTo(xToT(e.clientX, wave)));
    wave.addEventListener('dblclick', (e) => zoomBy(2, xToT(e.clientX, wave)));
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
  const { start, span } = state.view; if (!state.seconds || !span) return;
  TRACKS.forEach((t, i) => {
    const wave = $(`wave-${i}`); const canvas = wave.querySelector('canvas');
    const w = wave.clientWidth, h = wave.clientHeight, dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h); g.fillStyle = t.wave;
    const p = state.peaks[i]; const max = state.peakMax[i] || 0.05;
    const bps = p.length / state.seconds; // puntos por segundo
    const from = Math.max(0, Math.floor(start * bps)), to = Math.min(p.length, Math.ceil((start + span) * bps));
    const bw = Math.max(1, (w / (span * bps)) - 0.4);
    for (let k = from; k < to; k++) {
      const x = ((k / bps - start) / span) * w;
      const amp = Math.max(1, (p[k] / max) * (h / 2 - 2));
      g.fillRect(x, h / 2 - amp, bw, amp * 2);
    }
  });
}

// ---------- zoom y desplazamiento de las ondas ----------
const MIN_SPAN = 3;
const tToPct = (t) => ((t - state.view.start) / state.view.span) * 100;
const xToT = (clientX, el) => { const r = el.getBoundingClientRect(); return state.view.start + ((clientX - r.left) / r.width) * state.view.span; };
function setView(start, span) {
  const total = state.seconds || 1;
  span = Math.max(Math.min(MIN_SPAN, total), Math.min(total, span));
  state.view = { start: Math.max(0, Math.min(total - span, start)), span };
  renderView();
}
function renderView() {
  if (!state.seconds) return;
  drawWaves(); layoutEdit(); placeHeads();
  const zoom = state.seconds / state.view.span;
  $('zoom-out-txt').textContent = zoom > 1.05 ? `×${zoom.toFixed(zoom < 10 ? 1 : 0)}` : '';
  const pan = $('strip-pan'); pan.hidden = zoom <= 1.05;
  pan.max = String(Math.round((state.seconds - state.view.span) * 100)); pan.value = String(Math.round(state.view.start * 100));
}
// Los botones amplían alrededor del cursor de reproducción (el punto donde haces clic en una onda)
const zoomCenter = () => (state.pos >= state.view.start && state.pos <= state.view.start + state.view.span ? state.pos : state.view.start + state.view.span / 2);
function zoomBy(f, center = zoomCenter()) {
  const span = state.view.span / f;
  const rel = (center - state.view.start) / state.view.span;
  setView(center - rel * Math.max(Math.min(MIN_SPAN, state.seconds), Math.min(state.seconds, span)), span);
}
function placeHeads() {
  const pct = tToPct(state.pos); const hide = pct < 0 || pct > 100;
  TRACKS.forEach((_, i) => { const h = $(`head-${i}`); h.style.left = `${pct}%`; h.style.display = hide ? 'none' : ''; });
}

function setPosition(seconds) {
  state.pos = seconds;
  const v = state.view;
  if (state.player && state.player.playing && v.span && v.span < state.seconds - 0.01 && (seconds > v.start + v.span * 0.95 || seconds < v.start)) {
    setView(seconds - v.span * 0.1, v.span); // la vista sigue a la reproducción
  } else placeHeads();
  $('time').textContent = seconds < 0 ? 'Claqueta…' : `${fmtTime(seconds)} / ${fmtTime(state.seconds)}`;
}
function seekTo(seconds, allowNeg = false) {
  const t = Math.max(allowNeg ? -(countSec() + 0.1) : 0, Math.min(state.seconds, seconds));
  state.player.seek(t); setPosition(t);
}

function setPlayIcon(playing) { $('play').textContent = playing ? '⏸' : '▶'; $('play').setAttribute('aria-label', playing ? 'Pausar' : 'Reproducir'); }

async function openProject(p) {
  clearNotice();
  if (state.player) { state.player.dispose(); state.player = null; }
  state.project = p; state.gains = [1, 1, 1]; state.muted = [false, false, false]; state.solo = [false, false, false];
  state.tempo = 1; state.semitones = 0;
  state.estudio = freshEstudio();
  syncEstudioUI();
  $('song-title').textContent = p.title; $('song-artist').textContent = p.artist || '';
  $('chip-key').textContent = keyName(p.key); $('chip-bpm').textContent = `${Math.round(p.bpm)} BPM`;
  $('speed').value = '100'; buildTracks(); refreshControls();
  $('export-status').textContent = ''; setPlayIcon(false);
  show('player');
  $('time').textContent = 'Cargando pistas…';
  try {
    const player = new Player((s) => setPosition(s), () => { setPlayIcon(false); goStart(); });
    state.player = player;
    const { peaks, seconds } = await player.load(p.id);
    state.peaks = peaks; state.seconds = seconds;
    state.peakMax = peaks.map((p) => { let m = 0.05; for (let k = 0; k < p.length; k++) if (p[k] > m) m = p[k]; return m; });
    state.view = { start: 0, span: seconds };
    renderView(); applyGains(); setPosition(0); buildEdit();
    try {
      const stems = await decodeForAnalysis();
      state.estudio.start = state.estudio.auto = detectStart(stems, 44100);
      state.estudio.phrases = voicePhrases(stems[0], 44100);
      const bt = estimateBeats([stems[2], stems[0]], 44100, state.project.bpm);
      state.estudio.bpm = state.estudio.bpm0 = bt.bpm || state.project.bpm; state.estudio.g0 = bt.phase;
      state.estudio.cands = bt.candidates || []; state.estudio.candIdx = 0; state.estudio.env = bt.env || null; state.estudio.fps = bt.fps || 100;
      if (bt.bpm) { state.project.bpm = bt.bpm; $('chip-bpm').textContent = `${Math.round(bt.bpm)} BPM`; refreshControls(); } // el tempo de la app podía ir a un múltiplo equivocado
      syncEstudioUI();
    } catch { /* sin análisis: la marca se pone a mano y Sorpresa reparte por tiempo */ }
    buildEdit();
  } catch (e) { notice(errText(e)); show('library'); refreshLibrary(); }
}

function refreshControls() {
  const p = state.project; if (!p) return;
  const pct = Math.round(state.tempo * 100);
  $('speed-out').textContent = `${pct} %`;
  const bpmNow = Math.round(p.bpm * state.tempo);
  $('speed-bpm').textContent = `≈ ${bpmNow} BPM`;
  $('speed-name').textContent = tempoName(bpmNow);
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
$('restart').addEventListener('click', () => state.player && goStart());
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

// ---------- pista de estudio ----------
// Para detectar el inicio hace falta el audio: se decodifica una vez aparte del reproductor
async function decodeForAnalysis() {
  const ctx = new AudioContext({ sampleRate: 44100 });
  try { return await decodeStems(state.project.id, ctx); } finally { ctx.close().catch(() => {}); }
}

const gatedStems = () => [true, state.estudio.coros, false];
function pushZones() {
  const e = state.estudio;
  if (state.player && state.player.node) state.player.setZones(zonesToFrames(e.zones, state.player.sampleRate), gatedStems(), zoneLevels(e.zones));
}

function syncEstudioUI() {
  const e = state.estudio;
  $('trim-on').checked = e.trim;
  $('start-out').textContent = fmtTime(e.start);
  $('trim-opts').hidden = !e.trim; $('trim-help').hidden = !e.trim;
  $('coros-follow').checked = e.coros;
  $('sorpresa-nivel').value = e.nivel;
  $('ayuda-seg').value = String(e.vozSeg);
  document.querySelectorAll('[data-target]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.target === e.target)));
  $('zone-count').textContent = e.zones.length ? `(${e.zones.length})` : '';
  const first = e.zones[e.target === 'one' && e.sel.length ? e.sel[0] : 0];
  const lv = first ? Math.round((first[2] === undefined ? 0 : first[2]) * 100) : 0;
  $('zone-level').value = String(lv); $('zone-level-out').textContent = lv === 0 ? 'sin voz' : `${lv} %`;
  const none = !e.zones.length;
  ['zone-level'].forEach((id) => { $(id).disabled = none; });
  document.querySelectorAll('[data-level],[data-shift],[data-target]').forEach((b) => { b.disabled = none; });
  $('metro-vol').value = String(Math.round(e.metroVol * 100));
  document.querySelectorAll('[data-metro]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.metro) === e.metro)));
  document.querySelectorAll('[data-count]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.count) === e.count)));
  document.querySelectorAll('[data-cstep]').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.cstep) === e.countStep)));
  $('cstep-opts').hidden = !e.count; $('metro-flip').hidden = e.metro !== 2;
  $('beat-help').hidden = !(e.metro > 0 || e.count > 0);
  if (document.activeElement !== $('bpm-in')) $('bpm-in').value = e.bpm ? String(Math.round(e.bpm * 100) / 100) : '';
}

// --- franja de edición: pestaña naranja (inicio) y huecos amarillos (silencios de voz) ---
function buildStrip() {
  const row = document.createElement('div'); row.className = 'track t-strip';
  const ctl = document.createElement('div'); ctl.className = 'track-ctl';
  const name = document.createElement('span'); name.className = 'track-name'; name.textContent = '✂️ Edición';
  const tools = document.createElement('div'); tools.className = 'strip-tools';
  const mk = (id, text, label) => { const b = document.createElement('button'); b.type = 'button'; b.className = 'pill'; b.id = id; b.textContent = text; b.setAttribute('aria-label', label); return b; };
  const zo = mk('zoom-out', '−', 'Alejar las ondas'), zi = mk('zoom-in', '+', 'Ampliar las ondas'), za = mk('zoom-all', 'Todo', 'Ver la canción entera');
  const zt = document.createElement('span'); zt.id = 'zoom-out-txt'; zt.className = 'muted';
  tools.append(zo, zi, za, zt);
  ctl.append(name, tools);
  const right = document.createElement('div'); right.className = 'strip-right';
  const lane = document.createElement('div'); lane.className = 'strip-lane is-empty'; lane.id = 'strip-lane';
  const pan = document.createElement('input'); pan.type = 'range'; pan.id = 'strip-pan'; pan.className = 'strip-pan'; pan.min = '0'; pan.max = '0'; pan.hidden = true; pan.setAttribute('aria-label', 'Moverse por la canción');
  right.append(lane, pan); row.append(ctl, right);
  zo.addEventListener('click', () => zoomBy(1 / 1.6)); zi.addEventListener('click', () => zoomBy(1.6));
  row.addEventListener('dblclick', (ev) => { // doble clic en una onda o en la franja: amplía justo ahí
    const t = xToT(ev.clientX, $('strip-lane')); if (ev.target.closest('.strip-lane, .wave') && !ev.target.closest('.zbar, .shandle')) zoomBy(2, t);
  }); za.addEventListener('click', () => setView(0, state.seconds));
  pan.addEventListener('input', () => setView(Number(pan.value) / 100, state.view.span));
  lane.addEventListener('pointerdown', laneDown);
  return row;
}

let edit = { bars: [], shades: [[], [], []], band: null, handle: null, trimmed: [], lines: [] };
const phrasePoints = () => state.estudio.phrases.flat();
const snapTol = () => Math.min(0.3, (state.view.span / Math.max(1, $('strip-lane').clientWidth)) * 8); // unos 8 píxeles

function buildEdit() {
  const e = state.estudio; const lane = $('strip-lane'); if (!lane) return;
  lane.replaceChildren();
  TRACKS.forEach((_, i) => $(`wave-${i}`).querySelectorAll('.ov').forEach((n) => n.remove()));
  edit = { bars: [], shades: [[], [], []], band: null, handle: null, trimmed: [], lines: [] };
  lane.classList.toggle('is-empty', !(e.trim || e.zones.length));
  if (e.trim) {
    edit.band = document.createElement('div'); edit.band.className = 'sband'; edit.band.textContent = 'se quita';
    edit.handle = document.createElement('div'); edit.handle.className = 'shandle'; edit.handle.title = 'Arrastra para elegir dónde empieza la pista';
    edit.handle.addEventListener('pointerdown', startDown);
    lane.append(edit.band, edit.handle);
    TRACKS.forEach((_, i) => {
      const t = document.createElement('div'); t.className = 'ov trimmed'; const m = document.createElement('div'); m.className = 'ov startmark';
      $(`wave-${i}`).append(t, m); edit.trimmed.push(t); edit.lines.push(m);
    });
  }
  {
    e.zones.forEach((_, idx) => {
      const bar = document.createElement('div'); bar.className = 'zbar'; bar.dataset.i = String(idx);
      const l = document.createElement('div'); l.className = 'zh l'; const r = document.createElement('div'); r.className = 'zh r';
      const x = document.createElement('button'); x.type = 'button'; x.className = 'zx'; x.textContent = '×'; x.setAttribute('aria-label', 'Quitar este hueco'); x.title = 'Quitar este hueco';
      x.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      x.addEventListener('click', (ev) => { ev.stopPropagation(); e.zones.splice(idx, 1); e.sel = e.sel.filter((i) => i !== idx).map((i) => (i > idx ? i - 1 : i)); pushZones(); buildEdit(); syncEstudioUI(); });
      const lbl = document.createElement('span'); lbl.className = 'zl';
      bar.append(l, r, lbl, x);
      bar.addEventListener('pointerdown', (ev) => zoneDown(ev, idx, ev.target === l ? 'l' : ev.target === r ? 'r' : 'move'));
      lane.append(bar); edit.bars.push(bar);
      [0, 1].forEach((i) => {
        if (i === 1 && !e.coros) return;
        const z = document.createElement('div'); z.className = 'ov zone'; $(`wave-${i}`).append(z); edit.shades[i][idx] = z;
      });
    });
  }
  layoutEdit();
}

function layoutEdit() {
  const e = state.estudio; if (!state.seconds || !edit) return;
  if (edit.band) {
    const pct = tToPct(e.start);
    edit.band.style.width = `${Math.max(0, Math.min(100, pct))}%`;
    const off = pct < 0 || pct > 100; // el inicio real queda fuera de lo que se ve
    edit.handle.classList.toggle('is-off', off);
    edit.handle.textContent = off ? (pct < 0 ? '◀' : '▶') : '';
    edit.handle.title = off ? 'El inicio está fuera de la vista. Púlsame para ir a él' : 'Arrastra para elegir dónde empieza la pista';
    edit.handle.style.left = off ? (pct < 0 ? '0px' : 'calc(100% - 16px)') : `clamp(0px, calc(${pct}% - 8px), calc(100% - 16px))`;
    edit.band.style.width = pct > 100 ? '0%' : `${Math.max(0, Math.min(100, pct))}%`;
    edit.trimmed.forEach((t, i) => { t.style.width = `${Math.max(0, Math.min(100, pct))}%`; edit.lines[i].style.left = `${pct}%`; edit.lines[i].style.display = pct < 0 || pct > 100 ? 'none' : ''; });
  }
  const lane = $('strip-lane');
  if ((e.metro || e.count) && e.bpm > 30 && lane) {
    const w = lane.clientWidth || 600, px = (beatSec() / state.view.span) * w;
    if (px >= 6) {
      lane.style.backgroundImage = 'linear-gradient(to right, rgba(8,42,73,0.28) 0, rgba(8,42,73,0.28) 1px, transparent 1px)';
      lane.style.backgroundSize = `${px}px 100%`; lane.style.backgroundPosition = `${((e.g0 - state.view.start) / state.view.span) * w}px 0`;
    } else lane.style.backgroundImage = 'none';
  } else if (lane) lane.style.backgroundImage = '';
  e.zones.forEach(([a, b], idx) => {
    const l = tToPct(a), w = ((b - a) / state.view.span) * 100;
    const bar = edit.bars[idx];
    if (bar) {
      const lv = e.zones[idx][2] === undefined ? 0 : e.zones[idx][2];
      bar.classList.toggle('is-quiet', lv === 0); bar.classList.toggle('is-sel', e.sel.includes(idx));
      bar.querySelector('.zl').textContent = lv === 0 ? 'Sin voz' : `${Math.round(lv * 100)} %`;
      bar.style.left = `${l}%`; bar.style.width = `${w}%`; bar.style.display = l + w < 0 || l > 100 ? 'none' : ''; bar.classList.toggle('is-small', (w / 100) * ($('strip-lane').clientWidth || 600) < 34); }
    edit.shades.forEach((arr) => { const z = arr[idx]; if (z) { z.style.left = `${l}%`; z.style.width = `${w}%`; } });
  });
}

// Arrastre genérico: sigue el puntero hasta soltarlo
function drag(ev, onMove, onEnd) {
  const el = ev.currentTarget;
  try { el.setPointerCapture(ev.pointerId); } catch { /* evento sintético */ }
  const move = (m) => onMove(m); const up = (u) => { el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); el.removeEventListener('pointercancel', up); try { el.releasePointerCapture(u.pointerId); } catch { /* ya suelto */ } onEnd(u); };
  el.addEventListener('pointermove', move); el.addEventListener('pointerup', up); el.addEventListener('pointercancel', up);
}

function startDown(ev) {
  ev.preventDefault(); ev.stopPropagation();
  const e = state.estudio; const lane = $('strip-lane');
  if (ev.currentTarget.classList.contains('is-off')) { setView(e.start - state.view.span * 0.1, state.view.span); return; } // ir al inicio, sin moverlo
  drag(ev, (m) => {
    let t = xToT(m.clientX, lane);
    if (!m.altKey) t = snapTime(t, phrasePoints().map((p) => Math.max(0, p - 0.1)), snapTol()); // imán suave a las entradas; con Alt, libre del todo
    e.start = Math.round(Math.max(0, Math.min(state.seconds - 1, t)) * 100) / 100;
    $('start-out').textContent = fmtTime(e.start); layoutEdit();
  }, () => { pushClick(); goStart(); });
}

function zoneDown(ev, idx, mode) {
  if (ev.target.classList && ev.target.classList.contains('zx')) return;
  ev.preventDefault(); ev.stopPropagation();
  const e = state.estudio; const lane = $('strip-lane'); const z = e.zones;
  if (ev.shiftKey) e.sel = e.sel.includes(idx) ? e.sel.filter((i) => i !== idx) : [...e.sel, idx];
  else e.sel = [idx];
  e.target = 'one'; syncEstudioUI(); layoutEdit();
  const [a0, b0] = z[idx]; const t0 = xToT(ev.clientX, lane);
  const lo = idx > 0 ? z[idx - 1][1] + 0.05 : 0, hi = idx < z.length - 1 ? z[idx + 1][0] - 0.05 : state.seconds;
  const MIN = 0.5; const pts = phrasePoints();
  drag(ev, (m) => {
    const dt = xToT(m.clientX, lane) - t0; const tol = snapTol();
    if (mode === 'move') {
      const len = b0 - a0; let a = a0 + dt;
      const sa = snapTime(a, pts, tol), sb = snapTime(a + len, pts, tol);
      a = Math.abs(sa - a) <= Math.abs(sb - (a + len)) && sa !== a ? sa : sb !== a + len ? sb - len : a;
      a = Math.max(lo, Math.min(hi - len, a)); z[idx] = [a, a + len];
    } else if (mode === 'l') {
      z[idx] = [Math.max(lo, Math.min(b0 - MIN, snapTime(a0 + dt, pts, tol))), b0];
    } else {
      z[idx] = [a0, Math.min(hi, Math.max(a0 + MIN, snapTime(b0 + dt, pts, tol)))];
    }
    layoutEdit(); pushZones();
  }, () => { z[idx] = z[idx].map((v) => Math.round(v * 100) / 100); pushZones(); });
}

// Pulsar en la franja: clic = ir a ese punto; arrastrar sobre un espacio vacío = crear un hueco
function laneDown(ev) {
  if (ev.target !== ev.currentTarget && !(ev.target.classList && ev.target.classList.contains('sband'))) return;
  const e = state.estudio; const lane = ev.currentTarget; const x0 = ev.clientX; const t0 = xToT(x0, lane);
  const can = !e.zones.some(([a, b]) => t0 >= a && t0 < b);
  let ghost = null; let moved = false;
  const free = () => { const prev = e.zones.filter(([, b]) => b <= t0).map(([, b]) => b); const next = e.zones.filter(([a]) => a > t0).map(([a]) => a); return [prev.length ? Math.max(...prev) + 0.05 : 0, next.length ? Math.min(...next) - 0.05 : state.seconds]; };
  const [lo, hi] = free();
  const range = (t) => [Math.max(lo, Math.min(t0, t)), Math.min(hi, Math.max(t0, t))];
  drag(ev, (m) => {
    if (!can || Math.abs(m.clientX - x0) < 6) return;
    moved = true;
    if (!ghost) { ghost = document.createElement('div'); ghost.className = 'zbar ghost'; lane.append(ghost); }
    const [a, b] = range(xToT(m.clientX, lane));
    ghost.style.left = `${tToPct(a)}%`; ghost.style.width = `${((b - a) / state.view.span) * 100}%`;
  }, (u) => {
    if (ghost) ghost.remove();
    if (!moved) { seekTo(t0); return; }
    const [a, b] = range(xToT(u.clientX, lane));
    if (b - a >= 0.5) { e.zones = normalizeZones([...e.zones, [a, b, 0]], { max: state.seconds }); e.sel = []; pushZones(); buildEdit(); syncEstudioUI(); }
  });
}

function newSorpresa() {
  const e = state.estudio;
  e.seed = (e.seed % 1000000) + 1 + Math.floor(Math.random() * 1000);
  e.zones = makeSorpresa({ startSec: e.trim ? e.start : 0, endSec: state.seconds, nivel: e.nivel, seed: e.seed, phrases: e.phrases }).map(([a, b]) => [a, b, 0]);
  e.sel = []; e.target = 'all'; pushZones(); buildEdit(); syncEstudioUI();
}

$('trim-on').addEventListener('change', () => {
  const e = state.estudio; e.trim = $('trim-on').checked; $('start-out').textContent = fmtTime(e.start); syncEstudioUI(); buildEdit(); pushClick();
  if (e.trim) goStart();
});
async function playFromStart() {
  goStart();
  if (state.player && !state.player.playing) { await state.player.play(); setPlayIcon(true); }
}
$('start-listen').addEventListener('click', playFromStart);
function newAyuda() {
  const e = state.estudio;
  e.vozSeg = Number($('ayuda-seg').value) || 4;
  e.zones = makeAyuda({ phrases: e.phrases, endSec: state.seconds, vozSeg: e.vozSeg, gap: e.gap }).map(([a, b]) => [a, b, 0]);
  e.sel = []; e.target = 'all'; pushZones(); buildEdit(); syncEstudioUI();
}
$('ayuda-apply').addEventListener('click', newAyuda);
$('sorpresa-apply').addEventListener('click', () => {
  state.estudio.nivel = SORPRESA_NIVELES.includes($('sorpresa-nivel').value) ? $('sorpresa-nivel').value : 'normales'; newSorpresa();
});
const addZoneHere = () => {
  const e = state.estudio; const v = state.view;
  const c = state.pos >= v.start && state.pos <= v.start + v.span ? state.pos : v.start + v.span / 2;
  e.zones = addZone(e.zones, c, { len: Math.min(5, v.span / 3), max: state.seconds, level: 0 }); e.sel = []; pushZones(); buildEdit(); syncEstudioUI();
};
$('zone-add').addEventListener('click', addZoneHere);
// ajustar la voz: a todos los tramos o solo a los elegidos
const zoneWhich = () => { const e = state.estudio; return e.target === 'one' && e.sel.length ? e.sel : null; };
const afterLevel = () => { pushZones(); layoutEdit(); syncEstudioUI(); };
document.querySelectorAll('[data-target]').forEach((b) => b.addEventListener('click', () => {
  const e = state.estudio; e.target = b.dataset.target; if (e.target === 'all') e.sel = []; syncEstudioUI(); layoutEdit();
}));
$('zone-level').addEventListener('input', () => { const e = state.estudio; e.zones = setLevel(e.zones, Number($('zone-level').value) / 100, zoneWhich()); afterLevel(); });
document.querySelectorAll('[data-level]').forEach((b) => b.addEventListener('click', () => { const e = state.estudio; e.zones = setLevel(e.zones, Number(b.dataset.level) / 100, zoneWhich()); afterLevel(); }));
document.querySelectorAll('[data-shift]').forEach((b) => b.addEventListener('click', () => { const e = state.estudio; e.zones = shiftLevel(e.zones, Number(b.dataset.shift) / 100, zoneWhich()); afterLevel(); }));
// pestañas
function openTab(name) { // name vacío = cerrar el cuadro
  document.querySelectorAll('.tab-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === name)));
  document.querySelectorAll('.tabpanel').forEach((p) => { p.hidden = p.id !== `tab-${name}`; });
  $('estudio').classList.toggle('is-open', !!name);
}
document.querySelectorAll('.tab-btn').forEach((b) => b.addEventListener('click', () => openTab(b.getAttribute('aria-selected') === 'true' ? '' : b.dataset.tab)));
document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') openTab(''); });
$('coros-follow').addEventListener('change', () => { state.estudio.coros = $('coros-follow').checked; pushZones(); buildEdit(); });


// --- metrónomo y claqueta ---
const beatSec = () => 60 / (state.estudio.bpm || 120);
const countSec = () => { const e = state.estudio; return e.count ? e.count * beatSec() * e.countStep : 0; };
// Medio tiempo: de los dos repartos posibles (pulsos 1-3-5… o 2-4-6…) arranca por el que cae sobre golpes más fuertes
function autoParity() {
  const e = state.estudio; if (!e.env || !(e.bpm > 30)) return 0;
  const T = beatSec(), t0 = e.g0 + Math.ceil(((e.trim ? e.start : 0) - e.g0) / T - 1e-9) * T;
  const sum = [0, 0];
  for (let k = 0; k < 80; k++) { const i = Math.round((t0 + k * T) * e.fps); if (i >= e.env.length) break; sum[k % 2] += e.env[i]; }
  return sum[1] > sum[0] * 1.05 ? 1 : 0;
}
function clickConfig(sr = state.player ? state.player.sampleRate : 44100) {
  const e = state.estudio;
  if (!(e.metro || e.count) || !(e.bpm > 30)) return null;
  const parity = e.metro === 2 ? autoParity() ^ e.flip : 0;
  return { period: (60 / e.bpm) * sr, g0: e.g0 * sr, start: (e.trim ? e.start : 0) * sr, step: e.metro, parity, vol: e.metroVol, count: e.count, countStep: e.countStep, countVol: 0.8 };
}
function pushClick() {
  if (state.player && state.player.node) state.player.setClick(clickConfig());
  layoutEdit();
}
function goStart() { const e = state.estudio; seekTo((e.trim ? e.start : 0) - countSec(), true); }
function beatsChanged() { $('start-out').textContent = fmtTime(state.estudio.start); syncEstudioUI(); pushClick(); }
// El tempo de las demás zonas de la app (chip de arriba, velocidad) sigue siempre al pulso
function setBpm(v) {
  const e = state.estudio; if (!(v > 0)) { syncEstudioUI(); return; }
  e.bpm = Math.max(40, Math.min(240, Math.round(v * 100) / 100));
  if (state.project) { state.project.bpm = e.bpm; $('chip-bpm').textContent = `${Math.round(e.bpm * 10) / 10} BPM`; refreshControls(); }
  beatsChanged();
}
const wrapG0 = (g) => ((g % beatSec()) + beatSec()) % beatSec();

document.querySelectorAll('[data-metro]').forEach((b) => b.addEventListener('click', () => { const e = state.estudio; e.metro = Number(b.dataset.metro); e.flip = 0; beatsChanged(); }));
document.querySelectorAll('[data-count]').forEach((b) => b.addEventListener('click', () => { state.estudio.count = Number(b.dataset.count); beatsChanged(); }));
document.querySelectorAll('[data-cstep]').forEach((b) => b.addEventListener('click', () => { state.estudio.countStep = Number(b.dataset.cstep); beatsChanged(); }));
$('metro-flip').addEventListener('click', () => { state.estudio.flip ^= 1; beatsChanged(); });
$('metro-vol').addEventListener('input', () => { state.estudio.metroVol = Number($('metro-vol').value) / 100; pushClick(); });
$('bpm-in').addEventListener('change', () => setBpm(parseFloat($('bpm-in').value.replace(',', '.'))));
$('bpm-in').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') $('bpm-in').blur(); });
$('bpm-half').addEventListener('click', () => setBpm(state.estudio.bpm / 2));
$('bpm-double').addEventListener('click', () => setBpm(state.estudio.bpm * 2));
$('beat-left').addEventListener('click', () => { const e = state.estudio; e.g0 = wrapG0(e.g0 - 0.01); beatsChanged(); });
$('beat-right').addEventListener('click', () => { const e = state.estudio; e.g0 = wrapG0(e.g0 + 0.01); beatsChanged(); });
$('beat-here').addEventListener('click', () => { const e = state.estudio; e.g0 = wrapG0(Math.max(0, state.pos)); beatsChanged(); });
$('beat-start').addEventListener('click', () => { const e = state.estudio; e.g0 = wrapG0(e.trim ? e.start : 0); beatsChanged(); });
$('beat-auto').addEventListener('click', () => { // prueba el siguiente tempo candidato
  const e = state.estudio; if (!e.cands.length) return;
  e.candIdx = (e.candIdx + 1) % e.cands.length;
  const c = e.cands[e.candIdx]; e.flip = 0; e.g0 = c.phase; setBpm(c.bpm);
});
$('click-listen').addEventListener('click', playFromStart);

// Rueda: Ctrl (o pellizco en el panel táctil) amplía; el gesto horizontal desplaza
$('tracks').addEventListener('wheel', (ev) => {
  if (!state.seconds) return;
  if (ev.ctrlKey || ev.metaKey) { ev.preventDefault(); const lane = $('strip-lane'); zoomBy(Math.exp(-ev.deltaY * 0.01), xToT(ev.clientX, lane)); }
  else if (Math.abs(ev.deltaX) > Math.abs(ev.deltaY) || ev.shiftKey) {
    ev.preventDefault(); const d = (ev.deltaX || ev.deltaY) * (state.view.span / 600); setView(state.view.start + d, state.view.span);
  }
}, { passive: false });

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
      gains: [0, 1, 2].map(effectiveGain), tempo: state.tempo, semitones: state.semitones, sampleRate: 44100, vocal: [true, true, false],
      startFrame: state.estudio.trim ? Math.round(state.estudio.start * 44100) : 0,
      zones: state.estudio.zones.length ? zonesToFrames(state.estudio.zones, 44100) : null, levels: zoneLevels(state.estudio.zones), gated: gatedStems(), click: clickConfig(44100),
      onProgress: (p) => { status.textContent = `Creando la mezcla… ${Math.round(p * 100)} %`; },
    });
    status.textContent = 'Elige dónde guardarla…';
    const parts = [state.project.title];
    if (state.tempo !== 1) parts.push(`${Math.round(state.tempo * 100)}%`);
    if (state.semitones !== 0) parts.push(`${state.semitones > 0 ? '+' : ''}${state.semitones}st`);
    if (state.estudio.zones.length) parts.push('tramos');
    if (state.estudio.count) parts.push(`claqueta ${state.estudio.count}`);
    if (state.estudio.metro) parts.push(state.estudio.metro === 2 ? 'metrónomo medio' : state.estudio.metro === 0.5 ? 'metrónomo doble' : 'metrónomo');
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
window.addEventListener('resize', () => { if (!$('view-player').hidden && state.peaks.length) renderView(); });

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

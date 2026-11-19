// Pista de estudio: dónde empieza de verdad la canción y qué zonas se silencian.
// Todo son funciones puras para poder probarlas sin audio.

// Generador reproducible: la misma semilla da siempre los mismos cortes.
export function rng(seed) {
  let a = (seed >>> 0) || 1;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Energía por ventanas de 50 ms de la mezcla completa (suma de pistas).
function windowLevels(stems, sampleRate) {
  const win = Math.max(1, Math.round(sampleRate * 0.05));
  const n = stems.reduce((m, s) => Math.max(m, s.l.length), 0);
  const count = Math.floor(n / win);
  const out = new Float32Array(count);
  for (let w = 0; w < count; w++) {
    let acc = 0;
    const a = w * win;
    for (let i = a; i < a + win; i += 4) {
      let v = 0;
      for (const s of stems) if (i < s.l.length) v += s.l[i];
      acc += v * v;
    }
    out[w] = Math.sqrt(acc / (win / 4));
  }
  return out;
}

// Segundo en el que arranca la música real: primer punto con sonido sostenido
// (1 s) por encima de un umbral relativo. Quita silencios; las notas de
// presentación no se pueden distinguir, para eso está el ajuste a mano.
export function detectStart(stems, sampleRate = 44100) {
  const lv = windowLevels(stems, sampleRate);
  if (lv.length < 40) return 0;
  const sorted = Float32Array.from(lv).sort();
  const ref = sorted[Math.floor(sorted.length * 0.9)];
  if (ref < 1e-4) return 0;
  const thr = ref * 0.08;
  const span = 20; // 1 s: al menos el 70 % de las ventanas con sonido
  let run = 0;
  for (let i = 0; i < span; i++) run += lv[i] > thr ? 1 : 0;
  for (let i = 0; i + span <= lv.length; i++) {
    if (i > 0) run += (lv[i + span - 1] > thr ? 1 : 0) - (lv[i - 1] > thr ? 1 : 0);
    if (lv[i] > thr && run >= span * 0.7) {
      const sec = Math.max(0, i * 0.05 - 0.1);
      return sec < 0.5 ? 0 : Math.round(sec * 10) / 10;
    }
  }
  return 0;
}

// Frases del cantante: tramos en los que la voz suena, separados por silencios
// o valles de al menos 0,35 s (respiraciones más cortas no parten la frase).
// Devuelve [[ini, fin], …] en segundos.
export function voicePhrases(voz, sampleRate = 44100, minGap = 0.35) {
  const lv = windowLevels([voz], sampleRate);
  if (lv.length < 40) return [];
  const sorted = Float32Array.from(lv).sort();
  const ref = sorted[Math.floor(sorted.length * 0.9)];
  if (ref < 1e-4) return [];
  const thr = ref * 0.1;
  const raw = [];
  let from = -1;
  for (let i = 0; i <= lv.length; i++) {
    const on = i < lv.length && lv[i] > thr;
    if (on && from < 0) from = i;
    if (!on && from >= 0) { raw.push([from * 0.05, i * 0.05]); from = -1; }
  }
  const phrases = [];
  for (const seg of raw) {
    const last = phrases[phrases.length - 1];
    if (last && seg[0] - last[1] < minGap) last[1] = seg[1];
    else phrases.push([seg[0], seg[1]]);
  }
  return phrases.filter(([a, b]) => b - a >= 0.5).map(([a, b]) => [round2(a), round2(b)]);
}

const SORPRESA = {
  pocos: { on: [9, 18], off: [3, 5] },
  normales: { on: [5, 11], off: [4, 7] },
  muchos: { on: [3, 6], off: [4, 8] },
};
export const SORPRESA_NIVELES = Object.keys(SORPRESA);

// Cuántas frases suenan y cuántas se callan seguidas, según el nivel
const POR_FRASES = {
  pocos: { on: [3, 5], off: [1, 2] },
  normales: { on: [2, 4], off: [1, 3] },
  muchos: { on: [1, 3], off: [2, 4] },
};

// Modo "Sorpresa" siguiendo la voz: los cortes empiezan y acaban en los valles de
// la onda. Se calla justo cuando tocaba entrar (o, a veces, a mitad de una
// frase) y vuelve a sonar en un silencio posterior, tras una o varias frases.
// Con pocas frases detectadas cae al reparto por tiempo.
export function makeSorpresa({ startSec = 0, endSec, nivel = 'normales', seed = 1, grace = 8, phrases = null }) {
  const ph = (phrases || []).filter(([, b]) => b > startSec);
  if (ph.length < 6) return makeSorpresaPorTiempo({ startSec, endSec, nivel, seed, grace });
  const cfg = POR_FRASES[nivel] || POR_FRASES.normales;
  const rand = rng(seed);
  const pick = ([a, b]) => a + Math.floor(rand() * (b - a + 1));
  const zones = [];
  let i = ph.findIndex(([, b]) => b > startSec + grace); // la voz suena al principio
  if (i < 0) return zones;
  i += 1 + pick([0, 1]); // y unas frases más antes del primer corte
  while (i < ph.length - 1) {
    const j = Math.min(ph.length - 1, i + pick(cfg.off)); // primera frase que vuelve a sonar
    const prevEnd = i > 0 ? ph[i - 1][1] : startSec;
    const [s0, e0] = ph[i];
    // empieza en el silencio justo antes de la entrada, o a mitad de la frase
    const ini = rand() < 0.3 ? s0 + (e0 - s0) * (0.3 + rand() * 0.4) : prevEnd + Math.min(0.1, (s0 - prevEnd) / 2);
    // vuelve en el valle anterior a la frase j
    const fin = (ph[j - 1][1] + ph[j][0]) / 2;
    if (fin - ini >= 1.5 && fin <= endSec) zones.push([round2(ini), round2(fin)]);
    i = j + pick(cfg.on);
  }
  return zones;
}

function makeSorpresaPorTiempo({ startSec = 0, endSec, nivel = 'normales', seed = 1, grace = 8 }) {
  const cfg = SORPRESA[nivel] || SORPRESA.normales;
  const rand = rng(seed);
  const between = ([a, b]) => a + rand() * (b - a);
  const zones = [];
  let t = startSec + grace + between([0, 4]); // primer corte, tras unos segundos con voz
  while (t < endSec - 2) {
    const off = between(cfg.off);
    const end = Math.min(endSec, t + off);
    if (end - t >= 1) zones.push([round2(t), round2(end)]);
    t = end + between(cfg.on);
  }
  return zones;
}

const round2 = (x) => Math.round(x * 100) / 100;

// Quita la zona que contiene ese segundo (el usuario devuelve la voz ahí).
export function removeZoneAt(zones, sec) {
  return zones.filter(([a, b]) => !(sec >= a && sec < b));
}

export function zonesToFrames(zones, sampleRate = 44100) {
  const out = new Int32Array(zones.length * 2);
  zones.forEach(([a, b], i) => { out[i * 2] = Math.round(a * sampleRate); out[i * 2 + 1] = Math.round(b * sampleRate); });
  return out;
}

// Deja las zonas válidas: dentro de la canción, ordenadas, sin pisarse (las que se
// tocan se unen) y sin huecos de menos de `min` segundos.
export function normalizeZones(zones, { min = 0.5, max = Infinity } = {}) {
  const z = zones
    .map(([a, b]) => [Math.max(0, Math.min(a, b)), Math.min(max, Math.max(a, b))])
    .filter(([a, b]) => b - a >= min)
    .sort((x, y) => x[0] - y[0]);
  const out = [];
  for (const [a, b] of z) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out.map(([a, b]) => [round2(a), round2(b)]);
}

// Añade un hueco de `len` segundos centrado en `center`, dentro del espacio libre.
export function addZone(zones, center, { len = 5, max, min = 0.5 } = {}) {
  const sorted = normalizeZones(zones, { min: 0, max });
  let lo = 0, hi = max;
  for (const [a, b] of sorted) {
    if (center >= a && center < b) center = b + len / 2; // sobre otro hueco: justo después
  }
  for (const [a, b] of sorted) { if (b <= center) lo = Math.max(lo, b); if (a > center) { hi = Math.min(hi, a); break; } }
  if (lo > 0) lo += 0.2; // un respiro para que no se unan al vecino
  if (hi < max) hi -= 0.2;
  let a = Math.max(lo, center - len / 2), b = Math.min(hi, a + len);
  a = Math.max(lo, b - len);
  return b - a >= min ? normalizeZones([...sorted, [a, b]], { min, max }) : sorted;
}

// Acerca un instante al punto más próximo de `points` si está a menos de `tol` segundos.
export function snapTime(t, points, tol) {
  let best = t, d = tol;
  for (const p of points) { const x = Math.abs(p - t); if (x <= d) { best = p; d = x; } }
  return best;
}

// Modo "Ayuda": la voz solo suena al principio de cada entrada (la primera frase y
// las que llegan tras un silencio de `gap` segundos o más); el resto queda en silencio.
// Devuelve zonas silenciadas [[ini, fin], …] en segundos.
export function makeAyuda({ phrases = [], endSec, vozSeg = 4, gap = 1.5, lead = 0.2 }) {
  const entries = phrases.filter((p, k) => k === 0 || p[0] - phrases[k - 1][1] >= gap);
  if (!entries.length) return [];
  const on = [];
  for (const [s0] of entries) {
    const a = Math.max(0, s0 - lead), b = s0 + vozSeg;
    const last = on[on.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b); else on.push([a, b]);
  }
  const zones = [];
  let t = 0;
  for (const [a, b] of on) { if (a - t >= 0.5) zones.push([t, a]); t = b; }
  if (endSec - t >= 0.5) zones.push([t, endSec]);
  return zones.map(([a, b]) => [round2(a), round2(Math.min(b, endSec))]);
}

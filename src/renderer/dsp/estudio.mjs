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

const SORPRESA = {
  pocos: { on: [9, 18], off: [3, 5] },
  normales: { on: [5, 11], off: [4, 7] },
  muchos: { on: [3, 6], off: [4, 8] },
};
export const SORPRESA_NIVELES = Object.keys(SORPRESA);

// Modo "Sorpresa": la voz suena al principio y luego se corta y vuelve sin avisar.
// Devuelve zonas silenciadas [[ini, fin], …] en segundos.
export function makeSorpresa({ startSec = 0, endSec, nivel = 'normales', seed = 1, grace = 8 }) {
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

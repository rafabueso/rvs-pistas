// Pulso de la canción: afina el tempo y encuentra dónde cae el primer golpe,
// para que el metrónomo y la cuenta atrás vayan con la música.
// Funciona bien con tempo estable (pistas de karaoke y de estudio); en
// grabaciones en directo con tempo que se mueve se va desajustando.

const FPS = 100; // el análisis trabaja con 100 puntos por segundo

// Fuerza de los golpes en el tiempo: subida de energía en graves y en agudos.
export function onsetEnvelope(stems, sampleRate = 44100) {
  const hop = Math.round(sampleRate / FPS);
  const n = Math.floor(stems.reduce((m, s) => Math.max(m, s.l.length), 0) / hop);
  const a = 1 - Math.exp((-2 * Math.PI * 200) / sampleRate);
  const lowE = new Float32Array(n), highE = new Float32Array(n);
  let y = 0, prev = 0;
  for (let t = 0; t < n; t++) {
    let el = 0, eh = 0;
    for (let i = t * hop; i < (t + 1) * hop; i++) {
      let x = 0;
      for (const s of stems) if (i < s.l.length) x += s.l[i];
      y += a * (x - y);
      const d = x - prev; prev = x;
      el += y * y; eh += d * d;
    }
    lowE[t] = Math.sqrt(el / hop); highE[t] = Math.sqrt(eh / hop);
  }
  const env = new Float32Array(n);
  for (let t = 1; t < n; t++) {
    env[t] = Math.max(0, Math.log1p(50 * lowE[t]) - Math.log1p(50 * lowE[t - 1])) + Math.max(0, Math.log1p(50 * highE[t]) - Math.log1p(50 * highE[t - 1]));
  }
  // quita el fondo (media de 1 s) y suaviza un punto
  const out = new Float32Array(n);
  const W = 50; let sum = 0;
  for (let t = 0; t < Math.min(n, W); t++) sum += env[t];
  for (let t = 0; t < n; t++) {
    if (t + W < n) sum += env[t + W];
    if (t - W - 1 >= 0) sum -= env[t - W - 1];
    const mean = sum / (Math.min(n - 1, t + W) - Math.max(0, t - W) + 1);
    out[t] = Math.max(0, env[t] - mean);
  }
  const sm = new Float32Array(n);
  for (let t = 0; t < n; t++) sm[t] = 0.25 * (out[t - 1] || 0) + 0.5 * out[t] + 0.25 * (out[t + 1] || 0);
  return { env: sm, fps: FPS };
}

// Afina un tempo candidato en dos pasos (0,1 y luego 0,01 BPM) sobre toda la canción: un error
// de una décima de BPM ya se nota como desfase al cabo de unos minutos.
function refine(env, fps, n, bpm0, range) {
  const search = (from, to, step, phStep) => {
    let best = { score: -1, bpm: from, ph: 0 }, total = 0, count = 0;
    for (let bpm = from; bpm <= to + 1e-9; bpm += step) {
      const T = (fps * 60) / bpm;
      for (let ph = 0; ph < T; ph += phStep) {
        let score = 0, beats = 0;
        for (let t = ph; t < n; t += T) { const i = Math.floor(t), f = t - i; score += env[i] * (1 - f) + env[i + 1] * f; beats++; }
        score /= Math.max(1, beats);
        total += score; count++;
        if (score > best.score) best = { score, bpm, ph };
      }
    }
    return { best, mean: total / Math.max(1, count) };
  };
  const coarse = search(bpm0 * (1 - range), bpm0 * (1 + range), 0.1, 0.5);
  const fine = search(coarse.best.bpm - 0.15, coarse.best.bpm + 0.15, 0.01, 0.2);
  const best = fine.best;
  return {
    bpm: Math.round(best.bpm * 100) / 100, phase: Math.round((best.ph / fps) * 1000) / 1000,
    confidence: coarse.mean > 0 ? Math.round((coarse.best.score / coarse.mean) * 100) / 100 : 0,
  };
}

// Tempo y primer pulso. No se fía del tempo que traiga la app (puede ir a un múltiplo
// equivocado): lo busca de nuevo en toda la gama y devuelve los mejores candidatos,
// el primero es el más probable. bpmHint solo añade el tempo de la app como última opción.
// Devuelve { bpm, phase (s), confidence, candidates: [{ bpm, phase, confidence }] }.
export function estimateBeats(stems, sampleRate, bpmHint, { maxSeconds = 150, refineSeconds = 400 } = {}) {
  const { env, fps } = onsetEnvelope(stems, sampleRate);
  const n = Math.min(env.length - 1, Math.floor(maxSeconds * fps));
  const nFine = Math.min(env.length - 1, Math.floor(refineSeconds * fps));
  if (n < fps * 8) return { bpm: bpmHint || 0, phase: 0, confidence: 0, candidates: [], env, fps };
  const Lmin = Math.floor((fps * 60) / 210), Lmax = Math.ceil((fps * 60) / 55);
  const ac = new Float32Array(2 * Lmax + 2);
  for (let L = Math.max(2, Math.floor(Lmin / 2)); L <= 2 * Lmax; L++) {
    let sum = 0;
    for (let t = 0; t + L < n; t++) sum += env[t] * env[t + L];
    ac[L] = sum / (n - L);
  }
  const prior = (bpm) => Math.exp(-0.5 * Math.pow(Math.log2(bpm / 115) / 0.9, 2));
  const score = new Float32Array(Lmax + 1);
  for (let L = Lmin; L <= Lmax; L++) score[L] = (ac[L] + 0.5 * ac[2 * L] + 0.25 * ac[Math.round(L / 2)]) * prior((fps * 60) / L);
  const peaks = [];
  for (let L = Lmin + 1; L < Lmax; L++) if (score[L] >= score[L - 1] && score[L] > score[L + 1]) peaks.push(L);
  peaks.sort((x, y) => score[y] - score[x]);
  const picked = [];
  for (const L of peaks) {
    const bpm = (fps * 60) / L;
    if (picked.every((q) => Math.abs(q - bpm) / q > 0.06)) picked.push(bpm);
    if (picked.length >= 3) break;
  }
  if (bpmHint > 30 && picked.every((q) => Math.abs(q - bpmHint) / q > 0.06)) picked.push(bpmHint);
  const candidates = picked.map((bpm) => refine(env, fps, nFine, bpm, 0.04));
  const top = candidates[0] || { bpm: bpmHint || 0, phase: 0, confidence: 0 };
  return { ...top, candidates, env, fps };
}

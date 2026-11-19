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

// bpmHint: tempo aproximado (el de la app). Devuelve { bpm, phase (segundos del primer pulso), confidence }.
export function estimateBeats(stems, sampleRate, bpmHint, { range = 0.04, maxSeconds = 150 } = {}) {
  const { env, fps } = onsetEnvelope(stems, sampleRate);
  const n = Math.min(env.length - 1, Math.floor(maxSeconds * fps));
  if (!(bpmHint > 30) || n < fps * 8) return { bpm: bpmHint || 0, phase: 0, confidence: 0 };
  let best = { score: -1, bpm: bpmHint, ph: 0 }, total = 0, count = 0;
  for (let bpm = bpmHint * (1 - range); bpm <= bpmHint * (1 + range) + 1e-9; bpm += 0.1) {
    const T = (fps * 60) / bpm;
    for (let ph = 0; ph < T; ph += 0.25) {
      let score = 0, beats = 0;
      for (let t = ph; t < n; t += T) { const i = Math.floor(t), f = t - i; score += env[i] * (1 - f) + env[i + 1] * f; beats++; }
      score /= Math.max(1, beats);
      total += score; count++;
      if (score > best.score) best = { score, bpm, ph };
    }
  }
  const mean = total / Math.max(1, count);
  return { bpm: Math.round(best.bpm * 10) / 10, phase: Math.round((best.ph / fps) * 1000) / 1000, confidence: mean > 0 ? Math.round((best.score / mean) * 100) / 100 : 0 };
}

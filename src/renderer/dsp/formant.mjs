// Cambio de tono que respeta el timbre de la voz (formantes).
//
// El motor de tono (SoundTouch) mueve las notas, pero también desplaza las
// resonancias de la voz: por eso al subir suena a "pitufo" y al bajar a
// "ultratumba". Aquí se corrige ANTES de que SoundTouch actúe: se deforma la
// envolvente espectral de la voz al revés (1/r) y, cuando SoundTouch la
// desplaza r veces, las resonancias vuelven a quedar donde estaban.
//
// Es un proceso sin estado: cualquier bloque [posición, posición+n) se calcula
// solo a partir del audio original, así que valen los saltos, el tempo y la
// exportación sin trucos.

export const N = 2048;       // tamaño de ventana
export const HOP = 512;      // salto: 4 ventanas solapadas
const HALF = N / 2;
const LIFTER = 60;           // cuefrencia máxima de la envolvente (~1,4 ms)
const MAX_LOG_GAIN = Math.log(8); // la corrección nunca pasa de ±18 dB
const NORM = 1 / 1.5;        // suma de Hann² con salto N/4

// ---- FFT radix-2 en el sitio ---------------------------------------------
const cosT = new Float64Array(HALF);
const sinT = new Float64Array(HALF);
for (let i = 0; i < HALF; i++) { cosT[i] = Math.cos((2 * Math.PI * i) / N); sinT[i] = -Math.sin((2 * Math.PI * i) / N); }
const rev = new Uint16Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0; for (let b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
  rev[i] = r;
}
const hann = new Float64Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N);

function fft(re, im, inverse) {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1, step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0, t = 0; k < half; k++, t += step) {
        const wr = cosT[t], wi = inverse ? -sinT[t] : sinT[t];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
  if (inverse) for (let i = 0; i < N; i++) { re[i] /= N; im[i] /= N; }
}

// ---- una ventana ----------------------------------------------------------
const re = new Float64Array(N), im = new Float64Array(N);
const logm = new Float64Array(HALF + 1), env = new Float64Array(HALF + 1), g = new Float64Array(HALF + 1);
const cr = new Float64Array(N), ci = new Float64Array(N), lr = new Float64Array(N), li = new Float64Array(N);

// frame: N muestras ya recortadas del canal. ratio = 2^(semitonos/12).
// Devuelve la ventana corregida y ya multiplicada por la ventana de síntesis.
function processFrame(frame, ratio) {
  for (let i = 0; i < N; i++) { re[i] = frame[i] * hann[i]; im[i] = 0; }
  fft(re, im, false);

  // log-magnitud (simétrica) -> cepstrum real -> envolvente suave
  let peak = 1e-9;
  for (let k = 0; k <= HALF; k++) { const m = Math.hypot(re[k], im[k]); if (m > peak) peak = m; }
  const floor = peak * 1e-5;
  cr.fill(0); ci.fill(0); lr.fill(0); li.fill(0);
  for (let k = 0; k <= HALF; k++) { logm[k] = Math.log(Math.hypot(re[k], im[k]) + floor); cr[k] = logm[k]; }
  for (let k = 1; k < HALF; k++) cr[N - k] = logm[k];
  fft(cr, ci, true); // cepstrum
  lr[0] = cr[0];
  for (let q = 1; q < LIFTER; q++) { lr[q] = cr[q]; lr[N - q] = cr[q]; }
  fft(lr, li, false);
  for (let k = 0; k <= HALF; k++) env[k] = lr[k];

  // ganancia: Env(k·r) / Env(k)  (en logaritmos)
  for (let k = 0; k <= HALF; k++) {
    const x = k * ratio;
    let e2;
    if (x >= HALF) e2 = env[HALF];
    else { const i0 = Math.floor(x), f = x - i0; e2 = env[i0] * (1 - f) + env[i0 + 1] * f; }
    let d = e2 - env[k];
    if (d > MAX_LOG_GAIN) d = MAX_LOG_GAIN; else if (d < -MAX_LOG_GAIN) d = -MAX_LOG_GAIN;
    g[k] = Math.exp(d);
  }
  for (let k = 0; k <= HALF; k++) { re[k] *= g[k]; im[k] *= g[k]; }
  for (let k = 1; k < HALF; k++) { re[N - k] = re[k]; im[N - k] = -im[k]; }
  im[0] = 0; im[HALF] = 0;
  fft(re, im, true);
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) out[i] = re[i] * hann[i] * NORM;
  return out;
}

// ---- un canal, por bloques ------------------------------------------------
export class FormantChannel {
  constructor(samples) {
    this.x = samples;
    this.cache = new Map();
    this.cacheRatio = 1;
    this.frame = new Float64Array(N);
    this.nextStart = null;
  }

  frameAt(start, ratio) {
    let f = this.cache.get(start);
    if (f) return f;
    const x = this.x, n = x.length, fr = this.frame;
    for (let i = 0; i < N; i++) { const p = start + i; fr[i] = p >= 0 && p < n ? x[p] : 0; }
    f = processFrame(fr, ratio);
    if (this.cache.size > 700) this.cache.clear();
    this.cache.set(start, f);
    return f;
  }

  // Calcula por adelantado UNA ventana por delante de la posición de lectura,
  // para que el hilo de audio no se llene de golpe al pedir un bloque grande.
  // Devuelve false cuando ya está al día.
  prefetchOne(position, ahead, ratio) {
    if (ratio !== this.cacheRatio) { this.cache.clear(); this.cacheRatio = ratio; this.nextStart = null; }
    const s0 = Math.floor((position - N + 1) / HOP) * HOP;
    if (this.nextStart === null || this.nextStart < s0 || this.nextStart > position + ahead + HOP) this.nextStart = s0;
    if (this.nextStart >= position + ahead) return false;
    for (const key of this.cache.keys()) { if (key < s0 - N) this.cache.delete(key); else break; }
    this.frameAt(this.nextStart, ratio);
    this.nextStart += HOP;
    return true;
  }

  // Escribe en out[0..n) las muestras corregidas de [position, position+n)
  render(out, position, n, ratio) {
    if (ratio !== this.cacheRatio) { this.cache.clear(); this.cacheRatio = ratio; }
    out.fill(0, 0, n);
    const end = position + n;
    let s = Math.floor((position - N + 1) / HOP) * HOP;
    for (; s < end; s += HOP) {
      const f = this.frameAt(s, ratio);
      const a = Math.max(position, s), b = Math.min(end, s + N);
      for (let p = a; p < b; p++) out[p - position] += f[p - s];
    }
  }
}

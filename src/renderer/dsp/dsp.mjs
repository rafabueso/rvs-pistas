// Motor de mezcla, tempo y tono. Lo usan igual el reproductor (AudioWorklet)
// y la exportación (en bloques, fuera de tiempo real), así que lo que
// escuchas es exactamente lo que se guarda.
import { SoundTouch, SimpleFilter } from 'soundtouchjs';
import { FormantChannel } from './formant.mjs';

export const clampTempo = (t) => Math.min(1.5, Math.max(0.5, t));
export const clampSemitones = (s) => Math.min(6, Math.max(-6, Math.round(s)));

// Un segundo de silencio al final: SoundTouch guarda un poco de audio en su
// memoria interna y sin este relleno se perdería la cola de la canción.
const TAIL_PAD = 44100;

// Cortes de voz: zonas [inicio, fin) en frames de la canción original, donde las
// pistas marcadas como "con puerta" se silencian. La puerta cierra y abre en
// unos 12 ms para que no se oigan chasquidos.
const GATE_COEF = 1 - Math.exp(-1 / (0.012 * 44100));

// Origen de audio para SimpleFilter: suma las pistas con su volumen.
class MixSource {
  constructor(stems, vocal = []) {
    this.stems = stems; // [{ l: Float32Array, r: Float32Array }]
    // Las pistas de voz pasan por la corrección de formantes cuando cambia el tono
    this.formant = stems.map((s, k) => (vocal[k] ? { l: new FormantChannel(s.l), r: new FormantChannel(s.r) } : null));
    this.ratio = 1; // 2^(semitonos/12)
    this.tl = new Float32Array(0); this.tr = new Float32Array(0);
    this.length = stems.reduce((m, s) => Math.max(m, s.l.length), 0);
    this.target = stems.map(() => 1);
    this.current = stems.map(() => 1);
    this.zones = new Int32Array(0); // [ini0, fin0, ini1, fin1, …] ordenadas
    this.gated = stems.map(() => false);
    this.gate = 1; // estado suavizado de la puerta (1 = abierta)
    this.env = new Float32Array(0);
  }

  setZones(zones, gated) {
    this.zones = zones instanceof Int32Array ? zones : Int32Array.from(zones || []);
    this.gated = this.stems.map((_, k) => Boolean(gated && gated[k]));
  }

  // Primera zona cuyo final queda después de `pos`
  zoneFrom(pos) {
    const z = this.zones;
    let lo = 0, hi = z.length / 2;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (z[mid * 2 + 1] <= pos) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // Envolvente de la puerta para este bloque (una sola vez para todas las pistas)
  fillGate(position, frames) {
    if (this.env.length < frames) this.env = new Float32Array(frames);
    const z = this.zones, n = z.length / 2, env = this.env;
    let zi = this.zoneFrom(position), gate = this.gate;
    for (let i = 0; i < frames; i++) {
      const p = position + i;
      while (zi < n && z[zi * 2 + 1] <= p) zi++;
      const target = zi < n && p >= z[zi * 2] ? 0 : 1;
      gate += (target - gate) * GATE_COEF;
      env[i] = gate;
    }
    this.gate = gate;
  }

  extract(out, numFrames, position) {
    const frames = Math.max(0, Math.min(numFrames, this.length + TAIL_PAD - position));
    out.fill(0, 0, numFrames * 2);
    const useGate = this.zones.length > 0 && frames > 0;
    if (useGate) this.fillGate(position, frames);
    else this.gate = 1;
    for (let k = 0; k < this.stems.length; k++) {
      const { l, r } = this.stems[k];
      const from = this.current[k];
      const to = this.target[k];
      if (from === 0 && to === 0) continue;
      const step = frames > 0 ? (to - from) / frames : 0;
      let g = from;
      const fm = this.formant[k];
      let sl = l, sr = r, off = position;
      if (fm && this.ratio !== 1 && frames > 0) {
        if (this.tl.length < frames) { this.tl = new Float32Array(frames); this.tr = new Float32Array(frames); }
        fm.l.render(this.tl, position, frames, this.ratio);
        fm.r.render(this.tr, position, frames, this.ratio);
        sl = this.tl; sr = this.tr; off = 0;
      }
      const gate = useGate && this.gated[k] ? this.env : null;
      for (let i = 0; i < frames; i++) {
        g += step;
        const p = position + i;
        if (p < l.length) {
          const m = gate ? g * gate[i] : g;
          out[i * 2] += sl[off + i] * m;
          out[i * 2 + 1] += sr[off + i] * m;
        }
      }
      this.current[k] = to;
    }
    return frames;
  }
}

export class MixEngine {
  constructor(stems, vocal = []) {
    this.source = new MixSource(stems, vocal);
    this.touch = new SoundTouch();
    this.filter = new SimpleFilter(this.source, this.touch);
    this.scratch = new Float32Array(0);
    this.ended = false;
  }

  get length() { return this.source.length; }
  get position() { return this.filter.sourcePosition; }

  // Trabajo repartido: hasta `frames` ventanas de formantes por llamada (unos 2 s por delante)
  prefetch(frames = 2) {
    if (this.source.ratio === 1) return;
    const chans = [];
    this.source.formant.forEach((f) => { if (f) chans.push(f.l, f.r); });
    const pos = this.filter.sourcePosition;
    for (let i = 0, k = 0, idle = 0; i < frames && idle < chans.length; k = (k + 1) % chans.length) {
      if (chans[k].prefetchOne(pos, 88200, this.source.ratio)) { i++; idle = 0; } else idle++;
    }
  }

  setTempo(t) { this.touch.tempo = clampTempo(t); }
  setSemitones(s) {
    const v = clampSemitones(s);
    this.touch.pitchSemitones = v;
    this.source.ratio = Math.pow(2, v / 12);
  }
  setGain(index, value) { this.source.target[index] = Math.max(0, Math.min(1.5, value)); }
  setZones(zones, gated) { this.source.setZones(zones, gated); }
  seek(frame) {
    this.filter.sourcePosition = Math.max(0, Math.min(this.source.length, Math.floor(frame)));
    this.ended = false;
  }

  // Rellena left/right con numFrames; devuelve cuántos frames reales ha dado.
  render(left, right, numFrames) {
    if (this.scratch.length < numFrames * 2) this.scratch = new Float32Array(numFrames * 2);
    const got = this.filter.extract(this.scratch, numFrames);
    for (let i = 0; i < got; i++) {
      left[i] = this.scratch[i * 2];
      right[i] = this.scratch[i * 2 + 1];
    }
    if (got < numFrames) { left.fill(0, got, numFrames); right.fill(0, got, numFrames); }
    if (got === 0) this.ended = true;
    return got;
  }
}

// Exporta la mezcla actual (volúmenes, tempo y tono) a WAV de 16 bits.
// onProgress(0..1); shouldCancel() permite abortar. Cede el hilo entre bloques.
export async function renderToWav(stems, { gains, tempo, semitones, sampleRate, onProgress, shouldCancel, vocal = [], startFrame = 0, zones = null, gated = null }) {
  const engine = new MixEngine(stems, vocal);
  gains.forEach((g, i) => { engine.setGain(i, g); engine.source.current[i] = g; });
  engine.setTempo(tempo);
  engine.setSemitones(semitones);
  if (zones && zones.length) engine.setZones(zones, gated);
  const from = Math.max(0, Math.min(engine.length, Math.floor(startFrame)));
  if (from > 0) engine.seek(from);
  const expected = Math.ceil((engine.length - from) / tempo);
  const block = 16384;
  const left = new Float32Array(block);
  const right = new Float32Array(block);
  const chunks = [];
  let total = 0;
  for (;;) {
    if (shouldCancel && shouldCancel()) throw new Error('cancelado');
    let got = engine.render(left, right, block);
    got = Math.min(got, expected - total); // sin el silencio de relleno del final
    if (got <= 0) break;
    const pcm = new Int16Array(got * 2);
    for (let i = 0; i < got; i++) {
      pcm[i * 2] = Math.max(-1, Math.min(1, left[i])) * 32767;
      pcm[i * 2 + 1] = Math.max(-1, Math.min(1, right[i])) * 32767;
    }
    chunks.push(pcm);
    total += got;
    if (onProgress) onProgress(Math.min(1, total / expected));
    await new Promise((r) => setTimeout(r, 0));
  }
  const dataBytes = total * 4;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + dataBytes, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, dataBytes, true);
  return new Blob([header, ...chunks], { type: 'audio/wav' });
}

export * from './estudio.mjs';

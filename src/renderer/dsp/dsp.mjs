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

// Clics de metrónomo y de cuenta atrás: pitidos cortos que se mezclan ANTES del
// cambio de velocidad y de tono, así viajan con la música y caen siempre en su
// sitio. Su frecuencia se compensa para que el tono no cambie con los semitonos.
const SR = 44100;
const CLICK_LEN = Math.round(0.06 * SR);
const CLICK_TAU = 0.012 * SR;
const CLICK_ATTACK = 0.0008 * SR;
export const CLICK_HZ = { count: 1000, accent: 1800, metro: 800 };

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
    this.levels = new Float32Array(0); // nivel de voz de cada tramo (0 = silencio, 1 = normal)
    this.gated = stems.map(() => false);
    this.gate = 1; // estado suavizado de la puerta (1 = abierta)
    this.env = new Float32Array(0);
    this.pad = 0; // silencio previo (frames) donde suena la cuenta atrás
    this.click = null;
  }

  setZones(zones, gated, levels) {
    this.zones = zones instanceof Int32Array ? zones : Int32Array.from(zones || []);
    this.levels = new Float32Array(this.zones.length / 2);
    if (levels) for (let i = 0; i < this.levels.length; i++) this.levels[i] = Math.max(0, Math.min(1, Number(levels[i]) || 0));
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
      const target = zi < n && p >= z[zi * 2] ? this.levels[zi] : 1;
      gate += (target - gate) * GATE_COEF;
      env[i] = gate;
    }
    this.gate = gate;
  }

  // `position` cuenta desde el principio del relleno; en la canción es q0 = position - pad.
  extract(out, numFrames, position) {
    const pad = this.pad;
    const frames = Math.max(0, Math.min(numFrames, this.length + pad + TAIL_PAD - position));
    out.fill(0, 0, numFrames * 2);
    const q0 = position - pad;
    const lead = Math.max(0, Math.min(frames, -q0)); // frames antes de que empiece la canción
    const body = frames - lead;
    const useGate = this.zones.length > 0 && body > 0;
    if (useGate) this.fillGate(q0 + lead, body);
    else this.gate = 1;
    const sp = q0 + lead;
    for (let k = 0; k < this.stems.length && body > 0; k++) {
      const { l, r } = this.stems[k];
      const from = this.current[k];
      const to = this.target[k];
      if (from === 0 && to === 0) continue;
      const step = (to - from) / body;
      let g = from;
      const fm = this.formant[k];
      let sl = l, sr = r, off = sp;
      if (fm && this.ratio !== 1) {
        if (this.tl.length < body) { this.tl = new Float32Array(body); this.tr = new Float32Array(body); }
        fm.l.render(this.tl, sp, body, this.ratio);
        fm.r.render(this.tr, sp, body, this.ratio);
        sl = this.tl; sr = this.tr; off = 0;
      }
      const gate = useGate && this.gated[k] ? this.env : null;
      for (let i = 0; i < body; i++) {
        g += step;
        if (sp + i < l.length) {
          const m = gate ? g * gate[i] : g;
          out[(lead + i) * 2] += sl[off + i] * m;
          out[(lead + i) * 2 + 1] += sr[off + i] * m;
        }
      }
      this.current[k] = to;
    }
    // Con claqueta, lo que hay antes del inicio elegido no suena: solo se oyen los clics
    if (this.click && this.click.count > 0 && this.click.start > 0 && q0 < this.click.start) {
      const mute = Math.min(frames, Math.max(0, Math.ceil(this.click.start - q0)));
      out.fill(0, 0, mute * 2);
    }
    if (this.click && frames > 0) this.addClicks(out, q0, frames);
    return frames;
  }

  setClick(cfg) { this.click = cfg || null; }

  // Suma los clics que caen en [q0, q0 + frames) (tiempos en frames de la canción)
  addClicks(out, q0, frames) {
    const c = this.click, P = c.period;
    if (!(P > 100)) return;
    const lo = q0 - CLICK_LEN, hi = q0 + frames;
    if (c.count > 0) { // claqueta: termina un paso antes del inicio
      const gap = P * (c.countStep || 1);
      for (let i = 1; i <= c.count; i++) {
        const b = Math.round(c.start - (c.count - i + 1) * gap);
        if (b >= lo && b < hi) this.blip(out, q0, frames, b, c.count === 8 && i === 5 ? CLICK_HZ.accent : CLICK_HZ.count, c.countVol);
      }
    }
    if (c.step > 0 && c.vol > 0) { // metrónomo sobre la rejilla, desde el inicio
      const Ps = P * c.step;
      const shift = c.step === 2 && c.parity ? P : 0;
      const j0 = Math.ceil((c.start - shift - c.g0) / Ps - 1e-9); // primer clic desde el inicio
      const n0 = Math.max(0, Math.ceil((lo - shift - c.g0) / Ps) - j0), n1 = Math.floor((hi - shift - c.g0) / Ps) - j0;
      for (let n = n0; n <= n1; n++) {
        const b = Math.round(c.g0 + shift + (j0 + n) * Ps);
        if (b >= lo && b < hi) this.blip(out, q0, frames, b, CLICK_HZ.metro, c.vol);
      }
    }
  }

  blip(out, q0, frames, b, hz, vol) {
    const w = (2 * Math.PI * hz) / this.ratio / SR;
    const amp = 0.6 * vol;
    for (let j = Math.max(0, b - q0); j < frames; j++) {
      const t = q0 + j - b;
      if (t >= CLICK_LEN) break;
      const v = amp * Math.sin(w * t) * Math.exp(-t / CLICK_TAU) * Math.min(1, (t + 1) / CLICK_ATTACK);
      out[j * 2] += v; out[j * 2 + 1] += v;
    }
  }
}

export class MixEngine {
  constructor(stems, vocal = []) {
    this.source = new MixSource(stems, vocal);
    this.touch = new SoundTouch();
    this.filter = new SimpleFilter(this.source, this.touch);
    this.scratch = new Float32Array(0);
    this.ended = false;
    this.tempoValue = 1; this.semitoneValue = 0; this.started = false;
  }

  // A tempo y tono originales el audio pasa tal cual, sin pasar por SoundTouch (que lo suaviza y le mete fase)
  get direct() { return this.tempoValue === 1 && this.semitoneValue === 0; }

  get length() { return this.source.length; }
  get position() { return this.filter.sourcePosition - this.source.pad; }

  // Trabajo repartido: hasta `frames` ventanas de formantes por llamada (unos 2 s por delante)
  prefetch(frames = 2) {
    if (this.source.ratio === 1) return;
    const chans = [];
    this.source.formant.forEach((f) => { if (f) chans.push(f.l, f.r); });
    const pos = Math.max(0, this.filter.sourcePosition - this.source.pad);
    for (let i = 0, k = 0, idle = 0; i < frames && idle < chans.length; k = (k + 1) % chans.length) {
      if (chans[k].prefetchOne(pos, 88200, this.source.ratio)) { i++; idle = 0; } else idle++;
    }
  }

  setTempo(t) {
    const was = this.direct;
    this.tempoValue = clampTempo(t);
    this.touch.tempo = this.tempoValue;
    if (was !== this.direct && this.started) this.filter.clear();
  }
  setSemitones(s) {
    const was = this.direct;
    const v = clampSemitones(s);
    this.semitoneValue = v;
    this.touch.pitchSemitones = v;
    this.source.ratio = Math.pow(2, v / 12);
    if (was !== this.direct && this.started) this.filter.clear();
  }
  setGain(index, value) { this.source.target[index] = Math.max(0, Math.min(1.5, value)); }
  setZones(zones, gated, levels) { this.source.setZones(zones, gated, levels); }
  seek(frame) { // en frames de la canción; con cuenta atrás activa admite valores negativos
    this.filter.sourcePosition = Math.max(-this.source.pad, Math.min(this.source.length, Math.floor(frame))) + this.source.pad;
    this.ended = false;
  }

  // cfg: { period, g0, start, step, parity, vol, count, countStep, countVol } o null para quitarlo. Todo en frames.
  //  step: pulsos entre clics del metrónomo (0 = sin metrónomo, 2 = medio tempo, 1 = tempo real, 0.5 = doble)
  //  parity: con medio tempo, 0 = empieza en el primer pulso desde `start`, 1 = en el siguiente (contratiempo)
  //  count: 0, 4 u 8 clics de claqueta; countStep: pulsos entre clics (2 = más lenta, 1 = igual, 0.5 = el doble de rápida)
  setClick(cfg) {
    const pad = cfg && cfg.count > 0 ? Math.ceil(cfg.count * cfg.period * (cfg.countStep || 1)) + 2048 : 0;
    if (pad !== this.source.pad) {
      const here = this.position;
      this.source.pad = pad;
      this.filter.sourcePosition = Math.max(-pad, here) + pad;
    }
    this.source.setClick(cfg);
  }

  // Rellena left/right con numFrames; devuelve cuántos frames reales ha dado.
  render(left, right, numFrames) {
    if (this.scratch.length < numFrames * 2) this.scratch = new Float32Array(numFrames * 2);
    this.started = true;
    let got;
    if (this.direct) {
      got = this.source.extract(this.scratch, numFrames, this.filter.sourcePosition);
      this.filter._sourcePosition += got;
    } else got = this.filter.extract(this.scratch, numFrames);
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
export async function renderToWav(stems, { gains, tempo, semitones, sampleRate, onProgress, shouldCancel, vocal = [], startFrame = 0, zones = null, gated = null, levels = null, click = null }) {
  const engine = new MixEngine(stems, vocal);
  gains.forEach((g, i) => { engine.setGain(i, g); engine.source.current[i] = g; });
  engine.setTempo(tempo);
  engine.setSemitones(semitones);
  if (zones && zones.length) engine.setZones(zones, gated, levels);
  if (click) engine.setClick(click);
  const lead = click && click.count > 0 ? Math.ceil(click.count * click.period * (click.countStep || 1)) : 0; // la claqueta va antes del inicio
  const from = Math.max(-engine.source.pad, Math.min(engine.length, Math.floor(startFrame) - lead));
  if (from !== 0) engine.seek(from);
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
export * from './beats.mjs';

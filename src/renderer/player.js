// Reproductor: tres pistas sincronizadas con tempo y tono independientes.
const STEM_ORDER = ['voz', 'coros', 'musica'];

export async function decodeStems(projectId, ctx) {
  const stems = [];
  for (const name of STEM_ORDER) {
    const res = await fetch(`rvs://app/data/${projectId}/${name}.flac`);
    if (!res.ok) throw new Error('No se encuentran las pistas de esta canción.');
    const buf = await ctx.decodeAudioData(await res.arrayBuffer());
    stems.push({ l: buf.getChannelData(0), r: buf.numberOfChannels > 1 ? buf.getChannelData(1) : buf.getChannelData(0).slice() });
  }
  return stems;
}

export function peaksOf(stem, bins = 1400) {
  const n = stem.l.length;
  const out = new Float32Array(bins);
  const step = Math.max(1, Math.floor(n / bins));
  for (let b = 0; b < bins; b++) {
    let m = 0;
    const start = b * step, end = Math.min(n, start + step);
    for (let i = start; i < end; i += 8) { const a = Math.abs(stem.l[i]); if (a > m) m = a; }
    out[b] = m;
  }
  return out;
}

export class Player {
  constructor(onPosition, onEnded) {
    this.onPosition = onPosition;
    this.onEnded = onEnded;
    this.ctx = null; this.node = null; this.length = 0; this.sampleRate = 44100;
    this.playing = false;
  }

  async load(projectId) {
    this.dispose();
    this.ctx = new AudioContext({ sampleRate: 44100, latencyHint: 'playback' });
    await this.ctx.audioWorklet.addModule('rvs://app/vendor/stretch-worklet.js');
    this.node = new AudioWorkletNode(this.ctx, 'stretch-processor', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
    this.node.connect(this.ctx.destination);
    const stems = await decodeStems(projectId, this.ctx);
    this.length = stems.reduce((m, s) => Math.max(m, s.l.length), 0);
    this.sampleRate = this.ctx.sampleRate;
    // 60 puntos por segundo: suficiente para ampliar la onda hasta ver unos pocos segundos
    const bins = Math.min(30000, Math.max(1400, Math.round((this.length / this.sampleRate) * 60)));
    const peaks = stems.map((s) => peaksOf(s, bins));
    const ready = new Promise((resolve) => {
      this.node.port.onmessage = (e) => {
        const m = e.data;
        if (m.type === 'loaded') resolve();
        else if (m.type === 'position') this.onPosition(m.frame / this.sampleRate);
        else if (m.type === 'ended') { this.playing = false; this.onEnded(); }
      };
    });
    const transfer = stems.flatMap((s) => [s.l.buffer, s.r.buffer]);
    this.node.port.postMessage({ type: 'load', stems, vocal: [true, true, false] }, [...new Set(transfer)]);
    await ready;
    return { peaks, seconds: this.length / this.sampleRate };
  }

  async play() { await this.ctx.resume(); this.playing = true; this.node.port.postMessage({ type: 'play' }); }
  pause() { this.playing = false; this.node.port.postMessage({ type: 'pause' }); }
  seek(seconds) { this.node.port.postMessage({ type: 'seek', frame: Math.round(seconds * this.sampleRate) }); }
  setTempo(value) { this.node.port.postMessage({ type: 'tempo', value }); }
  setSemitones(value) { this.node.port.postMessage({ type: 'semitones', value }); }
  setGain(index, value) { this.node.port.postMessage({ type: 'gain', index, value }); }
  setClick(cfg) { this.node.port.postMessage({ type: 'click', cfg }); }
  setZones(zones, gated) { this.node.port.postMessage({ type: 'zones', zones, gated }); }

  dispose() {
    if (this.node) { try { this.node.disconnect(); } catch { /* ya desconectado */ } }
    if (this.ctx) this.ctx.close().catch(() => {});
    this.ctx = null; this.node = null; this.playing = false;
  }
}

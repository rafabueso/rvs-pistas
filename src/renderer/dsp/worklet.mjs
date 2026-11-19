import { MixEngine } from './dsp.mjs';

class StretchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.engine = null;
    this.playing = false;
    this.blocks = 0;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(m) {
    if (m.type === 'load') {
      this.engine = new MixEngine(m.stems, m.vocal || []);
      this.playing = false;
      this.port.postMessage({ type: 'loaded', length: this.engine.length });
      return;
    }
    const en = this.engine;
    if (!en) return;
    if (m.type === 'play') this.playing = true;
    else if (m.type === 'pause') this.playing = false;
    else if (m.type === 'seek') { en.seek(m.frame); this.port.postMessage({ type: 'position', frame: en.position }); }
    else if (m.type === 'tempo') en.setTempo(m.value);
    else if (m.type === 'semitones') en.setSemitones(m.value);
    else if (m.type === 'gain') en.setGain(m.index, m.value);
    else if (m.type === 'zones') en.setZones(m.zones, m.gated, m.levels);
    else if (m.type === 'click') { en.setClick(m.cfg); this.port.postMessage({ type: 'position', frame: en.position }); }
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    if (!this.engine || !this.playing) { return true; }
    const got = this.engine.render(out[0], out[1] || out[0], n);
    this.engine.prefetch(2);
    if (++this.blocks % 12 === 0) this.port.postMessage({ type: 'position', frame: this.engine.position });
    if (got === 0 && this.engine.ended) {
      this.playing = false;
      this.port.postMessage({ type: 'ended' });
    }
    return true;
  }
}

registerProcessor('stretch-processor', StretchProcessor);

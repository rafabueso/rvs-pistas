import test from 'node:test';
import assert from 'node:assert/strict';
import { MixEngine, renderToWav, clampSemitones, clampTempo } from '../src/renderer/dsp/dsp.mjs';

const SR = 44100;
const tone = (hz, secs, amp = 0.5) => {
  const n = Math.floor(secs * SR);
  const l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return { l, r: l.slice() };
};

function renderAll(engine) {
  const out = [];
  const L = new Float32Array(4096), R = new Float32Array(4096);
  for (;;) {
    const got = engine.render(L, R, 4096);
    if (got === 0) break;
    out.push(L.slice(0, got));
  }
  const total = out.reduce((s, c) => s + c.length, 0);
  const all = new Float32Array(total);
  let o = 0; for (const c of out) { all.set(c, o); o += c.length; }
  return all;
}

// Frecuencia dominante por cruces por cero en la parte central
function freq(buf) {
  const a = Math.floor(buf.length * 0.25), b = Math.floor(buf.length * 0.75);
  let z = 0;
  for (let i = a + 1; i < b; i++) if (buf[i - 1] <= 0 && buf[i] > 0) z++;
  return z / ((b - a) / SR);
}
const rms = (buf) => Math.sqrt(buf.reduce((s, v) => s + v * v, 0) / buf.length);

test('sin cambios: misma duración y misma nota', () => {
  const e = new MixEngine([tone(440, 6)]);
  const out = renderAll(e);
  assert.ok(out.length >= 6 * SR * 0.99 && out.length <= 7.1 * SR, `duración ${out.length / SR}`);
  assert.ok(Math.abs(freq(out) - 440) < 3, `nota ${freq(out)}`);
});

test('tempo 0,5: dura el doble y la nota no cambia', () => {
  const e = new MixEngine([tone(440, 6)]);
  e.setTempo(0.5);
  const out = renderAll(e);
  assert.ok(out.length / SR >= 11.8 && out.length / SR <= 14.2, `duración ${out.length / SR}`);
  assert.ok(Math.abs(freq(out) - 440) < 6, `nota ${freq(out)}`);
  assert.ok(rms(out.slice(SR, -SR)) > 0.25, 'se oye con volumen normal');
});

test('tempo 1,25: dura menos y la nota no cambia', () => {
  const e = new MixEngine([tone(440, 8)]);
  e.setTempo(1.25);
  const out = renderAll(e);
  assert.ok(out.length / SR >= 6.2 && out.length / SR <= 7.4, `duración ${out.length / SR}`);
  assert.ok(Math.abs(freq(out) - 440) < 6, `nota ${freq(out)}`);
});

test('+6 semitonos (el máximo): sube la nota y mantiene la duración', () => {
  const e = new MixEngine([tone(440, 6)]);
  e.setSemitones(6);
  const out = renderAll(e);
  const expected = 440 * Math.pow(2, 6 / 12);
  assert.ok(out.length / SR >= 5.8 && out.length / SR <= 7.2, `duración ${out.length / SR}`);
  assert.ok(Math.abs(freq(out) - expected) / expected < 0.02, `nota ${freq(out)} vs ${expected}`);
});

test('-3 semitonos con tempo 0,8 a la vez', () => {
  const e = new MixEngine([tone(440, 8)]);
  e.setSemitones(-3); e.setTempo(0.8);
  const out = renderAll(e);
  const expected = 440 * Math.pow(2, -3 / 12);
  assert.ok(out.length / SR >= 9.8 && out.length / SR <= 11.8, `duración ${out.length / SR}`);
  assert.ok(Math.abs(freq(out) - expected) / expected < 0.03, `nota ${freq(out)} vs ${expected}`);
});

test('volúmenes por pista: silenciar una pista la quita de la mezcla', () => {
  const stems = [tone(440, 4), tone(1000, 4)];
  const e = new MixEngine(stems);
  e.setGain(1, 0); e.source.current[1] = 0; // sin rampa, para medir limpio
  const out = renderAll(e);
  assert.ok(Math.abs(freq(out) - 440) < 3, `solo debería sonar la de 440 Hz, suena ${freq(out)}`);
  const both = renderAll(Object.assign(new MixEngine(stems)));
  assert.ok(rms(both) > rms(out) * 1.2, 'con las dos pistas suena más fuerte');
});

test('buscar una posición salta a ese punto', () => {
  const a = tone(300, 3), b = tone(900, 3);
  const l = new Float32Array(a.l.length + b.l.length); l.set(a.l); l.set(b.l, a.l.length);
  const e = new MixEngine([{ l, r: l.slice() }]);
  e.seek(3 * SR + 1000);
  const out = renderAll(e);
  assert.ok(Math.abs(freq(out) - 900) < 6, `tras buscar suena ${freq(out)}`);
});

test('exportar a WAV con tempo y tono', async () => {
  const blob = await renderToWav([tone(440, 5)], { gains: [1], tempo: 0.5, semitones: 0, sampleRate: SR });
  const buf = new Uint8Array(await blob.arrayBuffer());
  assert.equal(String.fromCharCode(...buf.slice(0, 4)), 'RIFF');
  const dv = new DataView(buf.buffer);
  const dataBytes = dv.getUint32(40, true);
  assert.ok(Math.abs(dataBytes / 4 / SR - 10) < 0.05, `dura ${dataBytes / 4 / SR} s`);
});

test('exportar conserva el final de la canción (sin recortar la cola ni añadir silencio)', async () => {
  const blob = await renderToWav([tone(440, 5)], { gains: [1], tempo: 1, semitones: 0, sampleRate: SR });
  const pcm = new Int16Array((await blob.arrayBuffer()).slice(44));
  const n = pcm.length / 2;
  assert.ok(Math.abs(n / SR - 5) < 0.05, `dura ${n / SR} s`);
  let e = 0; const from = n - Math.floor(0.3 * SR);
  for (let i = from; i < n; i++) e += (pcm[i * 2] / 32767) ** 2;
  const lastRms = Math.sqrt(e / (n - from));
  assert.ok(lastRms > 0.25, `los últimos 0,3 s suenan (rms ${lastRms.toFixed(2)})`);
});

test('límites de tempo y tono', () => {
  assert.equal(clampTempo(3), 1.5); assert.equal(clampTempo(0.1), 0.5);
  assert.equal(clampSemitones(9), 6); assert.equal(clampSemitones(-9), -6); assert.equal(clampSemitones(1.4), 1);
});

test('velocidad de proceso: una canción de 4 min se exporta en menos de 4 min', async () => {
  const t0 = Date.now();
  await renderToWav([tone(220, 60), tone(330, 60), tone(110, 60)], { gains: [1, 1, 1], tempo: 0.8, semitones: 2, sampleRate: SR });
  const secs = (Date.now() - t0) / 1000;
  console.log(`  60 s de audio (3 pistas, tempo y tono) tardó ${secs.toFixed(1)} s`);
  assert.ok(secs < 60, 'más lento que tiempo real');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { MixEngine, renderToWav, estimateBeats, makeAyuda, CLICK_HZ } from '../src/renderer/dsp/dsp.mjs';

const SR = 44100;
const silence = (secs) => { const l = new Float32Array(Math.floor(secs * SR)); return { l, r: l.slice() }; };

// Lee el WAV (16 bits, estéril) como Float32 del canal izquierdo
async function wavSamples(blob) {
  const b = Buffer.from(await blob.arrayBuffer());
  const n = (b.length - 44) / 4;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(44 + i * 4) / 32768;
  return out;
}
// Instantes (s) en que empieza un clic: primer cruce de un umbral tras al menos 0,15 s de calma
function onsets(x, thr = 0.05) {
  const res = []; let last = -1e9;
  for (let i = 0; i < x.length; i++) if (Math.abs(x[i]) > thr && i - last > 0.15 * SR) { res.push(i / SR); last = i; } else if (Math.abs(x[i]) > thr) last = i;
  return res;
}
// Frecuencia de un clic por cruces por cero en 20 ms
function clickHz(x, t) {
  let z = 0; const a = Math.floor(t * SR), b = a + Math.floor(0.02 * SR);
  for (let i = a + 1; i < b; i++) if (x[i - 1] <= 0 && x[i] > 0) z++;
  return z / 0.02;
}

const base = { gains: [1], semitones: 0, sampleRate: SR };

test('metrónomo: un clic por pulso, en su sitio', async () => {
  const P = 0.5 * SR, g0 = 0.2 * SR;
  const x = await wavSamples(await renderToWav([silence(6)], { ...base, tempo: 1, click: { period: P, g0, start: 0, every: 1, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  assert.ok(o.length >= 11, `clics ${o.length}`);
  assert.ok(Math.abs(o[0] - 0.2) < 0.01, `primero en ${o[0]}`);
  assert.ok(Math.abs(o[1] - o[0] - 0.5) < 0.01);
});

test('medio tempo: un clic cada dos pulsos', async () => {
  const x = await wavSamples(await renderToWav([silence(6)], { ...base, tempo: 1, click: { period: 0.5 * SR, g0: 0, start: 0, every: 2, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  assert.ok(Math.abs(o[1] - o[0] - 1) < 0.01, `separación ${o[1] - o[0]}`);
});

test('con velocidad 75 % los clics siguen al ritmo de la música (cada 0,5 s de canción = 0,667 s de salida)', async () => {
  const x = await wavSamples(await renderToWav([silence(8)], { ...base, tempo: 0.75, click: { period: 0.5 * SR, g0: 0, start: 0, every: 1, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  assert.ok(o.length > 8, `clics ${o.length}`);
  assert.ok(Math.abs(o[3] - o[2] - 0.5 / 0.75) < 0.02, `separación ${o[3] - o[2]}`);
});

test('con +2 semitonos el clic conserva su tono', async () => {
  const x = await wavSamples(await renderToWav([silence(5)], { ...base, tempo: 1, semitones: 2, click: { period: 0.5 * SR, g0: 0, start: 0, every: 1, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  const hz = clickHz(x, o[2] + 0.003);
  assert.ok(Math.abs(hz - CLICK_HZ.metro) < 120, `tono ${hz}`);
});

test('claqueta de 8: ocho clics antes del inicio y el 5 suena más agudo', async () => {
  const P = 0.5 * SR, start = 2 * SR;
  const x = await wavSamples(await renderToWav([silence(8)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, every: 0, vol: 0, count: 8, countVol: 0.8 } }));
  const o = onsets(x).filter((t) => t < 4.2);
  assert.equal(o.length, 8, `clics ${o.length}`);
  assert.ok(Math.abs(o[0]) < 0.02, 'el primero abre el archivo');
  assert.ok(Math.abs(o[7] - 3.5) < 0.02, `el 8 en ${o[7]}`); // 8 pulsos de 0,5 s y el inicio justo después
  const hz = o.map((t) => clickHz(x, t + 0.003));
  assert.ok(hz[4] > hz[3] * 1.4 && hz[4] > hz[5] * 1.4, `el 5 más agudo: ${hz.map(Math.round)}`);
  // la duración es la cuenta atrás (4 s) más lo que queda desde el inicio
  assert.ok(Math.abs(x.length / SR - (4 + 6)) < 0.1, `duración ${x.length / SR}`);
});

test('claqueta de 4: cuatro clics iguales', async () => {
  const P = 0.5 * SR, start = 1 * SR;
  const x = await wavSamples(await renderToWav([silence(5)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, every: 0, vol: 0, count: 4, countVol: 0.8 } }));
  const o = onsets(x).filter((t) => t < 2.2);
  assert.equal(o.length, 4);
  const hz = o.map((t) => clickHz(x, t + 0.003));
  assert.ok(Math.max(...hz) - Math.min(...hz) < 150, `${hz.map(Math.round)}`);
});

test('estimación del pulso sobre una pista con golpes cada 0,5 s desplazados 0,23 s', () => {
  const secs = 40, l = new Float32Array(secs * SR);
  for (let b = 0.23; b < secs - 0.1; b += 0.5) {
    const a = Math.round(b * SR);
    for (let i = 0; i < 0.08 * SR; i++) l[a + i] += Math.sin((2 * Math.PI * 90 * i) / SR) * Math.exp(-i / (0.03 * SR)) * 0.8;
    for (let i = 0; i < 0.01 * SR; i++) l[a + i] += Math.sin((2 * Math.PI * 4000 * i) / SR) * Math.exp(-i / (0.004 * SR)) * 0.3;
  }
  const r = estimateBeats([{ l, r: l }], SR, 118);
  assert.ok(Math.abs(r.bpm - 120) < 0.6, `bpm ${r.bpm}`);
  // aunque la app traiga un tempo equivocado (p. ej. 160), lo encuentra igualmente
  const wrong = estimateBeats([{ l, r: l }], SR, 160);
  assert.ok(Math.abs(wrong.bpm - 120) < 0.8, `con tempo de partida erróneo: ${wrong.bpm}`);
  assert.ok(wrong.candidates.length >= 2);
  const d = ((r.phase - 0.23) % 0.5 + 0.5) % 0.5;
  assert.ok(Math.min(d, 0.5 - d) < 0.025, `fase ${r.phase}`);
  assert.ok(r.confidence > 1.5);
});

test('Ayuda: la voz solo suena al entrar tras un silencio', () => {
  const ph = [[10, 14], [15, 19], [20, 24], [40, 44], [45, 49], [70, 74]];
  const z = makeAyuda({ phrases: ph, endSec: 100, vozSeg: 4, gap: 3 });
  // entradas en 10, 40 y 70: suena [9,8-14], [39.8-44], [69.8-74]
  assert.deepEqual(z, [[0, 9.8], [14, 39.8], [44, 69.8], [74, 100]]);
  const z2 = makeAyuda({ phrases: ph, endSec: 100, vozSeg: 4, gap: 0.5 }); // cada frase es una entrada
  assert.ok(z2.length > z.length - 1 && z2.every(([a, b]) => b > a));
});

test('estimación del pulso con corcheas (golpes cada 0,25 s, acento cada 0,5 s): no se va al doble', () => {
  const secs = 40, l = new Float32Array(secs * SR);
  for (let k = 0; k * 0.25 < secs - 0.2; k++) {
    const a = Math.round((0.1 + k * 0.25) * SR), strong = k % 2 === 0;
    for (let i = 0; i < 0.06 * SR; i++) l[a + i] += Math.sin((2 * Math.PI * (strong ? 90 : 3000) * i) / SR) * Math.exp(-i / (0.02 * SR)) * (strong ? 0.8 : 0.25);
  }
  const r = estimateBeats([{ l, r: l }], SR, 130);
  assert.ok(Math.abs(r.bpm - 120) < 1, `bpm ${r.bpm}`);
});

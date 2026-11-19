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
  const x = await wavSamples(await renderToWav([silence(6)], { ...base, tempo: 1, click: { period: P, g0, start: 0, step: 1, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  assert.ok(o.length >= 11, `clics ${o.length}`);
  assert.ok(Math.abs(o[0] - 0.2) < 0.01, `primero en ${o[0]}`);
  assert.ok(Math.abs(o[1] - o[0] - 0.5) < 0.01);
});

test('medio tempo: un clic cada dos pulsos', async () => {
  const x = await wavSamples(await renderToWav([silence(6)], { ...base, tempo: 1, click: { period: 0.5 * SR, g0: 0, start: 0, step: 2, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  assert.ok(Math.abs(o[1] - o[0] - 1) < 0.01, `separación ${o[1] - o[0]}`);
});

test('con velocidad 75 % los clics siguen al ritmo de la música (cada 0,5 s de canción = 0,667 s de salida)', async () => {
  const x = await wavSamples(await renderToWav([silence(8)], { ...base, tempo: 0.75, click: { period: 0.5 * SR, g0: 0, start: 0, step: 1, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  assert.ok(o.length > 8, `clics ${o.length}`);
  assert.ok(Math.abs(o[3] - o[2] - 0.5 / 0.75) < 0.02, `separación ${o[3] - o[2]}`);
});

test('con +2 semitonos el clic conserva su tono', async () => {
  const x = await wavSamples(await renderToWav([silence(5)], { ...base, tempo: 1, semitones: 2, click: { period: 0.5 * SR, g0: 0, start: 0, step: 1, vol: 1, count: 0, countVol: 1 } }));
  const o = onsets(x);
  const hz = clickHz(x, o[2] + 0.003);
  assert.ok(Math.abs(hz - CLICK_HZ.metro) < 120, `tono ${hz}`);
});

test('claqueta de 8: ocho clics antes del inicio y el 5 suena más agudo', async () => {
  const P = 0.5 * SR, start = 2 * SR;
  const x = await wavSamples(await renderToWav([silence(8)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, step: 0, vol: 0, count: 8, countVol: 0.8 } }));
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
  const x = await wavSamples(await renderToWav([silence(5)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, step: 0, vol: 0, count: 4, countVol: 0.8 } }));
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

test('medio tempo: la paridad elige entre los pulsos 1-3-5 y 2-4-6', async () => {
  const mk = (parity) => ({ ...base, tempo: 1, click: { period: 0.5 * SR, g0: 0, start: 0, step: 2, parity, vol: 1, count: 0, countVol: 1 } });
  const a = onsets(await wavSamples(await renderToWav([silence(6)], mk(0))));
  const b = onsets(await wavSamples(await renderToWav([silence(6)], mk(1))));
  assert.ok(Math.abs(a[0] - 0) < 0.02 && Math.abs(b[0] - 0.5) < 0.02, `${a[0]} y ${b[0]}`);
  assert.ok(Math.abs(a[1] - a[0] - 1) < 0.02 && Math.abs(b[1] - b[0] - 1) < 0.02);
});

test('doble tempo: un clic cada medio pulso', async () => {
  const o = onsets(await wavSamples(await renderToWav([silence(4)], { ...base, tempo: 1, click: { period: 0.5 * SR, g0: 0, start: 0, step: 0.5, parity: 0, vol: 1, count: 0, countVol: 1 } })));
  assert.ok(Math.abs(o[1] - o[0] - 0.25) < 0.02, `separación ${o[1] - o[0]}`);
});

test('el inicio puede estar fuera de la rejilla: la claqueta sigue al inicio y el metrónomo a la rejilla', async () => {
  const P = 0.5 * SR, start = 2.13 * SR; // 2,13 s no cae en un pulso (0, 0,5, 1…)
  const x = await wavSamples(await renderToWav([silence(8)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, step: 1, parity: 0, vol: 1, count: 4, countStep: 1, countVol: 0.8 } }));
  const o = onsets(x);
  assert.ok(Math.abs(o[3] - 1.5) < 0.02, `el cuarto de la claqueta en ${o[3]}`); // 4 pulsos de 0,5 s antes de 2,13 → termina en 1,5 desde el inicio del archivo (0,13+... )
  assert.ok(Math.abs(o[4] - (2.5 - 0.13 + 0.13) + 0) < 1, 'hay clics del metrónomo después');
});

test('claqueta a la mitad de velocidad: los clics van cada dos pulsos y 4 duran 4 s', async () => {
  const P = 0.5 * SR, start = 1 * SR;
  const x = await wavSamples(await renderToWav([silence(6)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, step: 0, parity: 0, vol: 0, count: 4, countStep: 2, countVol: 0.8 } }));
  const o = onsets(x).filter((t) => t < 4.2);
  assert.equal(o.length, 4);
  assert.ok(Math.abs(o[1] - o[0] - 1) < 0.02, `separación ${o[1] - o[0]}`);
  assert.ok(Math.abs(x.length / SR - (4 + 5)) < 0.1, `duración ${x.length / SR}`);
});

test('claqueta al doble de velocidad: 8 clics en 2 s', async () => {
  const P = 0.5 * SR, start = 0.5 * SR;
  const x = await wavSamples(await renderToWav([silence(4)], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, step: 0, parity: 0, vol: 0, count: 8, countStep: 0.5, countVol: 0.8 } }));
  const o = onsets(x).filter((t) => t < 2.3);
  assert.equal(o.length, 8);
  assert.ok(Math.abs(o[1] - o[0] - 0.25) < 0.02);
});

test('con claqueta, la música anterior al inicio no suena', async () => {
  const P = 0.5 * SR, start = 3 * SR;
  const tone = { l: new Float32Array(8 * SR).fill(0.5), r: new Float32Array(8 * SR).fill(0.5) };
  const x = await wavSamples(await renderToWav([tone], { ...base, tempo: 1, startFrame: start, click: { period: P, g0: 0, start, step: 0, parity: 0, vol: 0, count: 4, countStep: 1, countVol: 0.8 } }));
  // la claqueta dura 2 s; justo después empieza la música; antes solo clics (sin el nivel constante 0,5)
  const mid = x.slice(Math.floor(0.7 * SR), Math.floor(0.9 * SR));
  const after = x.slice(Math.floor(2.3 * SR), Math.floor(2.5 * SR));
  const mean = (a) => a.reduce((s, v) => s + Math.abs(v), 0) / a.length;
  assert.ok(mean(mid) < 0.05, `antes del inicio suena ${mean(mid)}`);
  assert.ok(mean(after) > 0.3, `después del inicio suena ${mean(after)}`);
});

test('a tempo y tono originales el audio sale idéntico y al cambiar de modo en pleno play no se rompe', () => {
  const n = 6 * SR, l = new Float32Array(n);
  for (let i = 0; i < n; i++) l[i] = 0.4 * Math.sin((2 * Math.PI * 330 * i) / SR);
  const eng = new MixEngine([{ l, r: l.slice() }]);
  eng.setGain(0, 1); eng.source.current[0] = 1;
  const L = new Float32Array(4096), R = new Float32Array(4096);
  eng.render(L, R, 4096);
  for (let i = 0; i < 4096; i++) assert.ok(Math.abs(L[i] - l[i]) < 1e-6, 'idéntico');
  eng.setTempo(0.8); eng.render(L, R, 4096); eng.render(L, R, 4096);
  assert.ok(L.every(Number.isFinite));
  eng.setTempo(1); eng.render(L, R, 4096);
  assert.ok(L.every(Number.isFinite) && eng.position > 4096);
});

test('un tramo con voz al 25 % deja pasar un cuarto de la voz y el silencio total, nada', async () => {
  const n = 6 * SR, v = new Float32Array(n).fill(0.8), m = new Float32Array(n).fill(0.2);
  const zones = Int32Array.from([1 * SR, 2 * SR, 3 * SR, 4 * SR]);
  const x = await wavSamples(await renderToWav([{ l: v, r: v.slice() }, { l: m, r: m.slice() }], { gains: [1, 1], semitones: 0, tempo: 1, sampleRate: SR, zones, gated: [true, false], levels: [0.25, 0] }));
  const at = (t) => x[Math.floor(t * SR)];
  assert.ok(Math.abs(at(0.5) - 1.0) < 0.02, `fuera ${at(0.5)}`);
  assert.ok(Math.abs(at(1.5) - (0.8 * 0.25 + 0.2)) < 0.02, `al 25 % ${at(1.5)}`);
  assert.ok(Math.abs(at(3.5) - 0.2) < 0.02, `en silencio ${at(3.5)}`);
});

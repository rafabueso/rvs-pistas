import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeZones, addZone, snapTime, detectStart, voicePhrases, makeSorpresa, removeZoneAt, zonesToFrames, rng, MixEngine, renderToWav } from '../src/renderer/dsp/dsp.mjs';

const SR = 44100;
const tone = (hz, from, to, total, amp = 0.5) => {
  const l = new Float32Array(Math.floor(total * SR));
  for (let i = Math.floor(from * SR); i < Math.floor(to * SR); i++) l[i] = Math.sin((2 * Math.PI * hz * i) / SR) * amp;
  return { l, r: l.slice() };
};

test('detecta el inicio tras un silencio', () => {
  const s = tone(220, 7.3, 30, 30);
  const at = detectStart([s], SR);
  assert.ok(at > 6.9 && at < 7.4, `inicio ${at}`);
});

test('sin silencio inicial devuelve 0', () => {
  assert.equal(detectStart([tone(220, 0, 20, 20)], SR), 0);
});

test('un golpe suelto no cuenta como inicio', () => {
  const a = tone(220, 2, 2.15, 30), b = tone(220, 12, 30, 30);
  for (let i = 0; i < a.l.length; i++) { a.l[i] += b.l[i]; a.r[i] += b.r[i]; }
  const at = detectStart([a], SR);
  assert.ok(at > 11.5, `inicio ${at}`);
});

test('Sorpresa: empieza con voz, reproducible y cambia con la semilla', () => {
  const a = makeSorpresa({ startSec: 3, endSec: 180, seed: 5 });
  assert.deepEqual(a, makeSorpresa({ startSec: 3, endSec: 180, seed: 5 }));
  assert.notDeepEqual(a, makeSorpresa({ startSec: 3, endSec: 180, seed: 6 }));
  assert.ok(a.length >= 5);
  assert.ok(a[0][0] >= 3 + 8, 'la voz suena al principio');
  for (let i = 0; i < a.length; i++) {
    assert.ok(a[i][1] - a[i][0] >= 1 && a[i][1] <= 180);
    if (i) assert.ok(a[i][0] > a[i - 1][1], 'zonas ordenadas y sin pisarse');
  }
});

test('Sorpresa: más cortes con "muchos" que con "pocos"', () => {
  const n = (nivel) => [1, 2, 3, 4, 5, 6].reduce((s, seed) => s + makeSorpresa({ endSec: 200, nivel, seed }).length, 0);
  assert.ok(n('muchos') > n('pocos'));
});

test('quitar zona y pasar a frames', () => {
  const z = [[10, 14], [20, 25]];
  assert.deepEqual(removeZoneAt(z, 12), [[20, 25]]);
  assert.deepEqual(removeZoneAt(z, 16), z);
  assert.deepEqual(Array.from(zonesToFrames([[1, 2]], 100)), [100, 200]);
  assert.ok(rng(1)() !== rng(2)());
});

const rms = (buf, a, b) => { let s = 0; for (let i = a; i < b; i++) s += buf[i] * buf[i]; return Math.sqrt(s / (b - a)); };

test('el motor silencia la voz en la zona y deja la música', () => {
  const voz = tone(440, 0, 10, 10, 0.5), musica = tone(110, 0, 10, 10, 0.3);
  const e = new MixEngine([voz, musica]);
  e.setZones(zonesToFrames([[4, 6]], SR), [true, false]);
  const L = new Float32Array(4096), R = new Float32Array(4096), all = [];
  for (;;) { const got = e.render(L, R, 4096); if (!got) break; all.push(...L.slice(0, got)); }
  const out = Float32Array.from(all);
  const dentro = rms(out, 4.3 * SR, 5.7 * SR), fuera = rms(out, 1 * SR, 3 * SR);
  assert.ok(dentro < fuera * 0.55, `dentro ${dentro} fuera ${fuera}`); // solo queda la música (0,3 frente a 0,5+0,3)
  assert.ok(dentro > 0.15, 'la música sigue sonando');
});

test('exportar desde el inicio recorta y mantiene los cortes', async () => {
  const voz = tone(440, 0, 20, 20, 0.5), musica = tone(110, 0, 20, 20, 0.0001);
  const wav = await renderToWav([voz, musica], {
    gains: [1, 1], tempo: 1, semitones: 0, sampleRate: SR,
    startFrame: 5 * SR, zones: zonesToFrames([[10, 14]], SR), gated: [true, false],
  });
  const buf = new Int16Array((await wav.arrayBuffer()).slice(44));
  const secs = buf.length / 2 / SR;
  assert.ok(Math.abs(secs - 15) < 0.1, `duración ${secs}`);
  const at = (t) => Math.abs(buf[Math.floor(t * SR) * 2]) + Math.abs(buf[Math.floor(t * SR) * 2 + 2]);
  let mudo = 0, sonando = 0;
  for (let i = 5.5 * SR; i < 8.5 * SR; i += 50) mudo = Math.max(mudo, Math.abs(buf[Math.floor(i) * 2]));
  for (let i = 1 * SR; i < 3 * SR; i += 50) sonando = Math.max(sonando, Math.abs(buf[Math.floor(i) * 2]));
  assert.ok(sonando > 8000, 'suena al principio');
  assert.ok(mudo < 200, `mudo en la zona (${mudo}) — zona 10–14 s = 5–9 s tras recortar`);
});

// Voz de prueba: frases de 3 s con 1 s de silencio entre ellas
const frases = (n, from = 2) => {
  const total = from + n * 4 + 2, l = new Float32Array(total * SR);
  const spans = [];
  for (let k = 0; k < n; k++) {
    const a = from + k * 4, b = a + 3; spans.push([a, b]);
    for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) l[i] = Math.sin((2 * Math.PI * 300 * i) / SR) * 0.5;
  }
  return { stem: { l, r: l.slice() }, spans, total };
};

test('detecta las frases de la voz', () => {
  const { stem, spans } = frases(10);
  const ph = voicePhrases(stem, SR);
  assert.equal(ph.length, 10);
  ph.forEach(([a, b], k) => { assert.ok(Math.abs(a - spans[k][0]) < 0.2 && Math.abs(b - spans[k][1]) < 0.2, `frase ${k}: ${a}-${b}`); });
});

test('una respiración corta no parte la frase', () => {
  const { stem } = frases(1);
  const gapA = Math.floor(3 * SR), gapB = Math.floor(3.2 * SR);
  for (let i = gapA; i < gapB; i++) { stem.l[i] = 0; stem.r[i] = 0; }
  assert.equal(voicePhrases(stem, SR).length, 1);
});

test('Sorpresa sigue la voz: los cortes caen en valles y no en medio de una frase', () => {
  const { stem, spans, total } = frases(30);
  const phrases = voicePhrases(stem, SR);
  let midInicio = 0, zonas = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const z = makeSorpresa({ startSec: 2, endSec: total, seed, phrases });
    assert.ok(z.length >= 2);
    assert.ok(z[0][0] >= 2 + 8, 'la voz suena al principio');
    z.forEach(([a, b], k) => {
      zonas++;
      assert.ok(b - a >= 1.5);
      if (k) assert.ok(a > z[k - 1][1]);
      // el final siempre en un silencio entre frases
      assert.ok(!spans.some(([x, y]) => b > x + 0.15 && b < y - 0.15), `fin ${b} dentro de una frase`);
      if (spans.some(([x, y]) => a > x + 0.15 && a < y - 0.15)) midInicio++;
    });
  }
  assert.ok(midInicio > 0 && midInicio < zonas * 0.6, `algunos cortes a mitad de frase: ${midInicio}/${zonas}`);
});

test('Sorpresa sin frases detectadas vuelve al reparto por tiempo', () => {
  const z = makeSorpresa({ startSec: 0, endSec: 120, seed: 3, phrases: [] });
  assert.ok(z.length >= 3);
});

test('normalizar: ordena, une las que se pisan y quita las diminutas', () => {
  assert.deepEqual(normalizeZones([[20, 25], [3, 8], [7, 12], [30, 30.2]], { max: 100 }), [[3, 12], [20, 25]]);
  assert.deepEqual(normalizeZones([[-4, 2], [98, 130]], { max: 100 }), [[0, 2], [98, 100]]);
  assert.deepEqual(normalizeZones([[9, 5]], { max: 100 }), [[5, 9]]);
});

test('añadir hueco: cabe en el espacio libre y no pisa a otros', () => {
  const z = addZone([[10, 14]], 12, { max: 60 });
  assert.ok(z.length === 2 && z[1][0] >= 14, JSON.stringify(z));
  const w = addZone([[10, 14], [20, 24]], 17, { len: 8, max: 60 });
  assert.equal(w.length, 3);
  assert.ok(w[1][0] >= 14 && w[1][1] <= 20, JSON.stringify(w));
  const x = addZone([], 1, { max: 60 });
  assert.ok(x[0][0] >= 0 && x[0][1] - x[0][0] >= 4.9);
});

test('imán: se pega al punto cercano y no al lejano', () => {
  assert.equal(snapTime(10.2, [10, 20], 0.3), 10);
  assert.equal(snapTime(10.6, [10, 20], 0.3), 10.6);
});

import { zoneLevels, setLevel, shiftLevel } from '../src/renderer/dsp/estudio.mjs';
test('niveles de tramo: poner, subir y unir solo si el nivel coincide', () => {
  let z = [[1, 3], [5, 8], [10, 12]];
  assert.deepEqual(Array.from(zoneLevels(z)), [0, 0, 0]);
  z = setLevel(z, 0.25);
  assert.deepEqual(z.map((t) => t[2]), [0.25, 0.25, 0.25]);
  z = shiftLevel(z, 0.25, [1]);
  assert.deepEqual(z.map((t) => t[2]), [0.25, 0.5, 0.25]);
  z = shiftLevel(z, -0.9);
  assert.deepEqual(z.map((t) => t[2]), [0, 0, 0]);
  assert.equal(normalizeZones([[1, 3, 0.2], [2.5, 5, 0.2]]).length, 1, 'mismo nivel: se unen');
  const d = normalizeZones([[1, 4, 0.2], [3, 6, 0.8]]);
  assert.deepEqual(d, [[1, 3, 0.2], [3, 6, 0.8]], 'distinto nivel: el segundo recorta al primero');
});

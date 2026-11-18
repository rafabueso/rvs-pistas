import test from 'node:test';
import assert from 'node:assert/strict';
import { detectStart, makeSorpresa, removeZoneAt, zonesToFrames, rng, MixEngine, renderToWav } from '../src/renderer/dsp/dsp.mjs';

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

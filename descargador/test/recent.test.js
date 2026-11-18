'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const r = require('../src/main/recent');

test('nombre de salida: misma carpeta, mp3 salvo m4a', () => {
  const d = path.join(path.sep, 'm');
  assert.strictEqual(r.outputPath(path.join(d, 'Tema.mp3'), 'karaoke'), path.join(d, 'Tema (karaoke).mp3'));
  assert.strictEqual(r.outputPath(path.join(d, 'Tema.m4a'), 'voz'), path.join(d, 'Tema (solo voz).m4a'));
  assert.strictEqual(r.outputPath(path.join(d, 'Tema.wav'), 'karaoke'), path.join(d, 'Tema (karaoke).mp3'));
  assert.strictEqual(r.outputPath(path.join(d, 'Tema.mp3'), 'otra'), null);
});

test('detecta versiones ya procesadas', () => {
  assert.ok(r.isProcessed('/m/Tema (karaoke).mp3'));
  assert.ok(r.isProcessed('/m/Tema (Solo voz).m4a'));
  assert.ok(!r.isProcessed('/m/Tema (en directo).mp3'));
});

test('la lista pone lo último arriba, sin repetir y con tope', () => {
  let l = [];
  for (let i = 0; i < 20; i++) l = r.add(l, `/m/${i}.mp3`);
  assert.strictEqual(l.length, r.MAX);
  assert.strictEqual(l[0], '/m/19.mp3');
  l = r.add(l, '/m/15.mp3');
  assert.strictEqual(l[0], '/m/15.mp3');
  assert.strictEqual(l.filter((x) => x === '/m/15.mp3').length, 1);
});

test('limpia rutas raras del archivo de ajustes', () => {
  assert.deepStrictEqual(r.clean(['/m/a.mp3', 'relativa.mp3', '/m/virus.exe', 5, null]), ['/m/a.mp3']);
  assert.deepStrictEqual(r.clean('no es lista'), []);
});

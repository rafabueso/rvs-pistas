'use strict';
// Lanza el motor de descarga (Python empaquetado) sin shell.
const { spawn } = require('child_process');
const path = require('path');
const { app } = require('electron');

function command() {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'rvs-dl.exe' : 'rvs-dl';
    return { cmd: path.join(process.resourcesPath, 'engine', 'rvs-dl', exe), args: [], cwd: undefined };
  }
  return {
    cmd: process.env.RVS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['dl_entry.py'],
    cwd: path.join(__dirname, '..', '..', '..', 'engine'),
  };
}

function run(args, onEvent) {
  const { cmd, args: base, cwd } = command();
  const child = spawn(cmd, [...base, ...args], {
    cwd, env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' }, windowsHide: true, shell: false,
  });
  let buffer = ''; let result = null; let failure = null; let cancelled = false;
  const handle = (line) => {
    if (!line.trim()) return;
    let evt; try { evt = JSON.parse(line); } catch { return; }
    if (evt.event === 'result') result = evt.data;
    else if (evt.event === 'error') failure = { code: evt.code, message: evt.message };
    else if (onEvent) onEvent(evt);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (c) => { buffer += c; let i; while ((i = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, i)); buffer = buffer.slice(i + 1); } });
  const promise = new Promise((resolve, reject) => {
    child.on('error', () => reject({ code: 'engine_missing', message: 'No se ha podido iniciar el descargador.' }));
    child.on('close', (code) => {
      handle(buffer);
      if (cancelled) return reject({ code: 'cancelled', message: 'Cancelado.' });
      if (failure) return reject(failure);
      if (code === 0 && result) return resolve(result);
      reject({ code: 'engine_failed', message: 'La descarga se ha cerrado sin terminar.' });
    });
  });
  return { promise, cancel: () => { cancelled = true; child.kill(); } };
}

module.exports = { run };

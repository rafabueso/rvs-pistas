'use strict';
// Lanza el motor de audio (Python empaquetado) como proceso aparte, sin shell.
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

function command() {
  if (app.isPackaged) {
    const exe = process.platform === 'win32' ? 'rvs-engine.exe' : 'rvs-engine';
    return { cmd: path.join(process.resourcesPath, 'engine', 'rvs-engine', exe), args: [], cwd: undefined };
  }
  return {
    cmd: process.env.RVS_PYTHON || (process.platform === 'win32' ? 'python' : 'python3'),
    args: ['-m', 'rvs_engine'],
    cwd: path.join(__dirname, '..', '..', 'engine'),
  };
}

function modelsDir() {
  const dir = path.join(app.getPath('userData'), 'models');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function env() {
  const e = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
  if (app.isPackaged) e.RVS_MODELS = path.join(process.resourcesPath, 'models');
  return e;
}

const jobs = new Map();

// Ejecuta una orden del motor. Devuelve { promise, cancel }.
function run(args, onEvent) {
  const { cmd, args: base, cwd } = command();
  const child = spawn(cmd, [...base, ...args], { cwd, env: env(), windowsHide: true, shell: false });
  let buffer = '';
  let result = null;
  let failure = null;
  let stderr = '';
  let cancelled = false;

  const handle = (line) => {
    if (!line.trim()) return;
    let evt;
    try { evt = JSON.parse(line); } catch { return; }
    if (evt.event === 'result') result = evt.data;
    else if (evt.event === 'error') failure = { code: evt.code, message: evt.message };
    else if (onEvent) onEvent(evt);
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) { handle(buffer.slice(0, i)); buffer = buffer.slice(i + 1); }
  });
  child.stderr.on('data', (c) => { stderr = (stderr + c).slice(-4000); });

  const promise = new Promise((resolve, reject) => {
    child.on('error', () => reject({ code: 'engine_missing', message: 'No se ha podido iniciar el motor de audio.' }));
    child.on('close', (code) => {
      handle(buffer);
      if (cancelled) return reject({ code: 'cancelled', message: 'Cancelado.' });
      if (failure) return reject(failure);
      if (code === 0 && result) return resolve(result);
      if (stderr) console.error('[motor]', stderr);
      reject({ code: 'engine_failed', message: 'El motor de audio se ha cerrado sin terminar.' });
    });
  });
  return { promise, cancel: () => { cancelled = true; child.kill(); } };
}

module.exports = { run, modelsDir, jobs };

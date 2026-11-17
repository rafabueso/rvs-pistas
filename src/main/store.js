'use strict';
// Biblioteca de proyectos en la carpeta de datos de la aplicación.
const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { isProjectId } = require('./validate');

function root() {
  const dir = path.join(app.getPath('userData'), 'projects');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function newId() {
  const d = new Date();
  const p = (n, l = 2) => String(n).padStart(l, '0');
  const stamp = `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${stamp}-${require('crypto').randomBytes(3).toString('hex')}`;
}

function projectDir(id) {
  if (!isProjectId(id)) throw new Error('id no válido');
  return path.join(root(), id);
}

function list() {
  const out = [];
  for (const id of fs.readdirSync(root())) {
    if (!isProjectId(id)) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(root(), id, 'project.json'), 'utf8'));
      out.push({ ...meta, id });
    } catch { /* proyecto incompleto: se ignora */ }
  }
  return out.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
}

function remove(id) {
  fs.rmSync(projectDir(id), { recursive: true, force: true });
}

module.exports = { root, newId, projectDir, list, remove };

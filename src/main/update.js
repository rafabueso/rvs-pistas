'use strict';
// Aviso de versión nueva: pregunta (solo lectura) cuál es la última versión publicada.
// No descarga ni instala nada: únicamente avisa y abre la página de descargas.
const { net, app } = require('electron');

const LATEST = 'https://api.github.com/repos/rafabueso/rvs-descargas/releases/latest';
const PAGE = 'https://github.com/rafabueso/rvs-descargas/releases/latest';

const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
function newer(a, b) { const x = parts(a); const y = parts(b); for (let i = 0; i < 3; i++) { if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); } return false; }

async function check() {
  try {
    const r = await net.fetch(LATEST, { headers: { Accept: 'application/vnd.github+json' } });
    if (!r.ok) return { available: false };
    const tag = String((await r.json()).tag_name || '');
    if (!/^v\d+\.\d+\.\d+$/.test(tag)) return { available: false };
    return { available: newer(tag, app.getVersion()), version: tag, url: PAGE };
  } catch { return { available: false }; }
}
module.exports = { check, newer, PAGE };

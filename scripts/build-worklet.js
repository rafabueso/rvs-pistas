// Empaqueta el motor de tempo y tono: uno para el AudioWorklet y otro para exportar.
const esbuild = require('esbuild');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src', 'renderer', 'vendor');

Promise.all([
  esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/dsp/worklet.mjs')],
    outfile: path.join(out, 'stretch-worklet.js'),
    bundle: true, format: 'iife', target: 'es2022', minify: true, legalComments: 'none',
  }),
  esbuild.build({
    entryPoints: [path.join(root, 'src/renderer/dsp/dsp.mjs')],
    outfile: path.join(out, 'dsp.js'),
    bundle: true, format: 'esm', target: 'es2022', minify: true, legalComments: 'none',
  }),
]).then(() => console.log('Motor de tempo y tono listo.')).catch((e) => { console.error(e); process.exit(1); });

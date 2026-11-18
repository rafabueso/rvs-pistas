// Prueba de extremo a extremo con un motor falso (no toca internet).
// Uso: xvfb-run -a npx electron test/e2e.js --no-sandbox --disable-gpu
const { app, dialog, BrowserWindow, clipboard } = require('electron');
const fs = require('fs'); const os = require('os'); const path = require('path');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-e2e-'));
process.env.RVS_USER_DATA = path.join(out, 'datos');
process.env.RVS_PYTHON = path.join(__dirname, 'fake_engine.sh');
const dest = path.join(out, 'descargas'); fs.mkdirSync(dest);
const shots = process.env.E2E_SHOTS || out; fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (n, ok, x = '') => { results.push(ok); console.log(`${ok ? 'OK ' : 'FALLA'}  ${n}${x ? ' — ' + x : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dest] });
require('../src/main/main.js');
const ev = (w, c) => w.webContents.executeJavaScript(c);
async function waitFor(w, expr, ms = 20000) { const t = Date.now(); while (Date.now() - t < ms) { try { if (await ev(w, expr)) return; } catch { /* cargando */ } await sleep(200); } throw new Error('Tiempo agotado: ' + expr); }
const shot = async (w, n) => fs.writeFileSync(path.join(shots, n), (await w.webContents.capturePage()).toPNG());

app.whenReady().then(async () => {
  const win = await new Promise((res) => { const w = BrowserWindow.getAllWindows()[0]; if (w) res(w); else app.once('browser-window-created', (_e, nw) => res(nw)); });
  try {
    await waitFor(win, `document.readyState === 'complete' && !!window.descargador`);
    check('el puente seguro existe y Node no está expuesto', await ev(win, `typeof require === 'undefined' && typeof process === 'undefined'`));
    check('hay política de seguridad', /default-src 'none'/.test(await ev(win, `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`)));
    await shot(win, '01-inicio.png');
    for (const bad of ['https://evil.com/watch?v=dQw4w9WgXcQ', 'file:///etc/passwd', 'https://youtube.com.evil.com/watch?v=dQw4w9WgXcQ']) {
      const r = await ev(win, `window.descargador.probe(${JSON.stringify(bad)}).then((r) => r.ok ? 'aceptado' : r.error.code)`);
      check(`rechaza ${bad}`, r === 'bad_url', r);
    }
    clipboard.writeText('https://youtu.be/dQw4w9WgXcQ');
    await ev(win, `document.getElementById('paste').click()`);
    await waitFor(win, `!document.getElementById('options').hidden`);
    check('reconoce el enlace pegado', (await ev(win, `document.getElementById('title').textContent`)) === 'Canción de prueba');
    await shot(win, '02-reconocido.png');
    await ev(win, `document.querySelector('[data-format=m4a]').click(); document.getElementById('change').click()`);
    await waitFor(win, `document.getElementById('folder').textContent.includes('descargas')`);
    check('cambia la carpeta de destino', true);
    await ev(win, `document.getElementById('go').click()`);
    await waitFor(win, `!document.getElementById('working').hidden`);
    await sleep(500); await shot(win, '03-descargando.png');
    await waitFor(win, `!document.getElementById('done').hidden`);
    await shot(win, '04-listo.png');
    check('termina y muestra el archivo', /\.m4a$/.test(await ev(win, `document.getElementById('done-name').textContent`)));
    check('el archivo está en la carpeta elegida', fs.readdirSync(dest).some((f) => f.endsWith('.m4a')));

    // --- karaoke desde el resultado recién descargado ---
    check('ofrece karaoke y solo voz al terminar', await ev(win, `!document.getElementById('done-karaoke').hidden && !document.getElementById('done-voz').hidden`));
    await ev(win, `document.getElementById('done-karaoke').click()`);
    await waitFor(win, `document.getElementById('done-name').textContent.includes('Karaoke listo')`);
    check('crea el karaoke en la misma carpeta, con el mismo formato', fs.existsSync(path.join(dest, 'Artista - Canción de prueba (karaoke).m4a')));
    await shot(win, '05-karaoke-listo.png');

    // --- lista de últimas descargas ---
    await waitFor(win, `document.querySelectorAll('#recent-list .recent-row').length === 1`);
    const row = await ev(win, `document.querySelector('#recent-list .recent-row').textContent`);
    check('la lista recuerda la descarga y marca el karaoke ya hecho', /Canción de prueba/.test(row) && /📂 Karaoke/.test(row) && /🎙️ Solo voz/.test(row), row);
    await ev(win, `[...document.querySelectorAll('#recent-list .chip')].find((c) => c.textContent.includes('🎙️')).click()`);
    await waitFor(win, `document.getElementById('done-name').textContent.includes('Solo voz listo')`);
    check('crea la versión solo voz desde la lista', fs.existsSync(path.join(dest, 'Artista - Canción de prueba (solo voz).m4a')));
    await waitFor(win, `[...document.querySelectorAll('#recent-list .chip')].every((c) => !c.textContent.includes('🎙️'))`);
    await shot(win, '06-lista.png');

    // --- seguridad: solo trabaja sobre archivos que la propia app conoce ---
    const evil = await ev(win, `window.descargador.karaoke({ path: '/etc/passwd', mode: 'karaoke' }).then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('rechaza archivos que no están en la lista', evil === 'bad_file', evil);
    const twice = await ev(win, `window.descargador.karaoke({ path: ${JSON.stringify(path.join(dest, 'Artista - Canción de prueba (karaoke).m4a'))}, mode: 'karaoke' }).then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('no vuelve a procesar una versión ya procesada', twice === 'bad_file' || twice === 'already', twice);

    // --- la lista sobrevive a cerrar y abrir ---
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.RVS_USER_DATA, 'ajustes.json'), 'utf8'));
    check('guarda la carpeta y la lista en los ajustes', saved.folder === dest && saved.recent.length === 1);
  } catch (e) { check('la prueba no se ha interrumpido', false, e.message); }
  const fails = results.filter((r) => !r).length;
  console.log(`\n${results.length - fails}/${results.length} comprobaciones correctas. Capturas en ${shots}`);
  app.exit(fails ? 1 : 0);
});

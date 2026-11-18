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
    await ev(win, `document.getElementById('format').value = 'm4a'; document.getElementById('change').click()`);
    await waitFor(win, `document.getElementById('folder').textContent === 'descargas'`);
    check('cambia la carpeta de destino', true);
    check('por defecto: original y karaoke marcados, solo voz no', await ev(win, `[...document.querySelectorAll('.toggle')].map((b) => b.getAttribute('aria-checked')).join() === 'true,true,false'`));
    check('el botón dice cuántos archivos salen', (await ev(win, `document.getElementById('go-text').textContent`)) === 'Descargar · 2 archivos');
    await ev(win, `document.querySelector('[data-want=voz]').click()`);
    check('al marcar solo voz salen 3 archivos', (await ev(win, `document.getElementById('go-text').textContent`)) === 'Descargar · 3 archivos');
    await shot(win, '02-reconocido.png');
    await ev(win, `document.getElementById('go').click()`);
    await waitFor(win, `!document.getElementById('working').hidden`);
    await sleep(900); await shot(win, '03-trabajando.png');
    await waitFor(win, `!document.getElementById('done').hidden`);
    await shot(win, '04-listo.png');
    check('termina y cuenta los archivos', /Listo · 3 archivos en descargas/.test(await ev(win, `document.getElementById('done-title').textContent`)));
    const names = ['Artista - Canción de prueba.m4a', 'Artista - Canción de prueba (karaoke).m4a', 'Artista - Canción de prueba (solo voz).m4a'];
    check('los tres archivos están en la carpeta elegida', names.every((n) => fs.existsSync(path.join(dest, n))), fs.readdirSync(dest).join(' | '));

    // --- últimas descargas: aparece sola y muestra lo ya hecho ---
    await waitFor(win, `document.querySelectorAll('#recent-list .recent-row').length === 1`);
    const row = await ev(win, `document.querySelector('#recent-list .recent-row').textContent`);
    check('la lista recuerda la descarga y marca karaoke y solo voz como hechos', /Canción de prueba/.test(row) && /Karaoke listo/.test(row) && /Solo voz listo/.test(row), row);

    // --- sin original: no deja el audio suelto, solo lo pedido ---
    await ev(win, `document.getElementById('again').click(); document.getElementById('link').value = ''`);
    clipboard.writeText('https://youtu.be/aaaaaaaaaaa');
    await ev(win, `document.getElementById('paste').click()`);
    await waitFor(win, `!document.getElementById('options').hidden`);
    await ev(win, `document.querySelector('[data-want=original]').click(); document.querySelector('[data-want=voz]').click(); document.querySelector('[data-want=voz]').click()`);
    await ev(win, `document.querySelector('[data-want=voz]').getAttribute('aria-checked') === 'false' || document.querySelector('[data-want=voz]').click()`);
    for (const f of fs.readdirSync(dest)) fs.unlinkSync(path.join(dest, f));
    const before = new Set();
    await ev(win, `document.getElementById('go').click()`);
    await waitFor(win, `!document.getElementById('done').hidden`);
    const added = fs.readdirSync(dest).filter((f) => !before.has(f));
    check('sin «audio original» no deja el audio suelto', added.length === 0 || added.every((f) => /\((karaoke|solo voz)\)/.test(f)), added.join(' | '));
    check('no deja basura temporal', !fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('rvsdl-')));

    // --- seguridad: solo trabaja sobre archivos que la propia app conoce ---
    const evil = await ev(win, `window.descargador.karaoke({ path: '/etc/passwd', mode: 'karaoke' }).then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('rechaza archivos que no están en la lista', evil === 'bad_file', evil);
    const nothing = await ev(win, `window.descargador.make({ url: 'https://youtu.be/dQw4w9WgXcQ', format: 'mp3', want: { original: false, karaoke: false, voz: false } }).then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('no hace nada si no se marca nada', nothing === 'nothing', nothing);
    const badfmt = await ev(win, `window.descargador.make({ url: 'https://youtu.be/dQw4w9WgXcQ', format: 'exe', want: { original: true } }).then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('rechaza formatos raros', badfmt === 'bad_format', badfmt);
    const saved = JSON.parse(fs.readFileSync(path.join(process.env.RVS_USER_DATA, 'ajustes.json'), 'utf8'));
    check('guarda la carpeta y la lista en los ajustes', saved.folder === dest && saved.recent.length >= 1);
  } catch (e) { check('la prueba no se ha interrumpido', false, e.message); }
  const fails = results.filter((r) => !r).length;
  console.log(`\n${results.length - fails}/${results.length} comprobaciones correctas. Capturas en ${shots}`);
  app.exit(fails ? 1 : 0);
});

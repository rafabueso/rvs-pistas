// Prueba de extremo a extremo: abre la app de verdad (Electron) y maneja la pantalla.
// Uso: xvfb-run -a npx electron test/e2e.js --no-sandbox --disable-gpu
const { app, dialog, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'pistas-e2e-'));
process.env.RVS_USER_DATA = path.join(out, 'datos');
const SONG = process.env.E2E_SONG || '/tmp/ejemplo.mp3';
const shots = process.env.E2E_SHOTS || out;
fs.mkdirSync(shots, { recursive: true });

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok }); console.log(`${ok ? 'OK ' : 'FALLA'}  ${name}${extra ? ' — ' + extra : ''}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [SONG] });
let nextSave = null;
dialog.showSaveDialog = async () => ({ canceled: false, filePath: nextSave });

require('../src/main/main.js');

async function waitFor(win, expr, ms = 600000, label = expr) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { if (await win.webContents.executeJavaScript(expr)) return true; } catch { /* aún cargando */ }
    await sleep(500);
  }
  throw new Error(`Tiempo agotado esperando: ${label}`);
}
const ev = (win, code) => win.webContents.executeJavaScript(code);
const shot = async (win, name) => fs.writeFileSync(path.join(shots, name), (await win.webContents.capturePage()).toPNG());

app.whenReady().then(async () => {
  const win = await new Promise((res) => { const w = BrowserWindow.getAllWindows()[0]; if (w) res(w); else app.once('browser-window-created', (_e, nw) => res(nw)); });
  try {
    win.webContents.on('console-message', (_e, level, message, line, src) => { if (level >= 2 || process.env.E2E_VERBOSE) console.log('  [consola]', message, src ? `(${src}:${line})` : ''); });
    win.setSize(1180, 820);
    await waitFor(win, `document.readyState === 'complete' && !!window.pistas`, 30000, 'carga de la ventana');
    await sleep(800);
    check('la interfaz carga y el puente seguro existe', await ev(win, `typeof window.pistas.process === 'function' && !window.require && !window.process`));
    check('Node no está expuesto a la página', await ev(win, `typeof require === 'undefined' && typeof process === 'undefined'`));
    const csp = await ev(win, `document.querySelector('meta[http-equiv="Content-Security-Policy"]').content`);
    check('hay política de seguridad de contenido', /default-src 'none'/.test(csp));
    await shot(win, '01-inicio.png');

    // enlaces: la validación rechaza lo que no es YouTube
    const bad = await ev(win, `window.pistas.probe('https://evil.com/watch?v=dQw4w9WgXcQ').then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('rechaza un enlace que no es de YouTube', bad === 'bad_url', bad);
    const bad2 = await ev(win, `window.pistas.probe('file:///etc/passwd').then((r) => r.ok ? 'aceptado' : r.error.code)`);
    check('rechaza file:///', bad2 === 'bad_url', bad2);

    // flujo real: elegir archivo -> separar -> reproductor
    const t0 = Date.now();
    await ev(win, `document.getElementById('pick').click()`);
    await waitFor(win, `!document.getElementById('view-working').hidden`, 20000, 'pantalla de progreso');
    await sleep(4000);
    await shot(win, '02-procesando.png');
    check('muestra el progreso', (await ev(win, `Number(document.getElementById('bar').getAttribute('aria-valuenow'))`)) > 0);
    await waitFor(win, `!document.getElementById('view-player').hidden`, 240000, 'reproductor');
    await waitFor(win, `/ \\/ \\d/.test(document.getElementById('time').textContent) && !/Cargando/.test(document.getElementById('time').textContent)`, 120000, 'pistas cargadas');
    console.log(`  (separación + carga: ${Math.round((Date.now() - t0) / 1000)} s)`);
    await sleep(500);
    await shot(win, '03-reproductor.png');
    check('el título aparece', (await ev(win, `document.getElementById('song-title').textContent`)).length > 0);
    check('hay 3 pistas con su onda dibujada', await ev(win, `[0,1,2].every(i => { const c = document.querySelector('#wave-' + i + ' canvas'); const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data; let n = 0; for (let k = 3; k < d.length; k += 4) if (d[k] > 0) n++; return n > 200; })`));
    check('el worklet de tempo y tono está cargado (CSP y protocolo ok)', !(await ev(win, `document.getElementById('time').textContent.includes('Cargando')`)));

    // controles
    await ev(win, `(() => { const s = document.getElementById('speed'); s.value = '75'; s.dispatchEvent(new Event('input')); })()`);
    check('velocidad 75 % se muestra', (await ev(win, `document.getElementById('speed-out').textContent`)).startsWith('75'));
    await ev(win, `document.getElementById('pitch-up').click(); document.getElementById('pitch-up').click();`);
    const pk = await ev(win, `document.getElementById('pitch-key').textContent`);
    check('subir 2 semitonos muestra la tonalidad nueva', pk.includes('→'), pk);
    await ev(win, `document.querySelector('[data-preset="karaoke"]').click()`);
    check('preset karaoke silencia voz y coros', await ev(win, `document.getElementById('mute-0').getAttribute('aria-pressed') === 'true' && document.getElementById('mute-1').getAttribute('aria-pressed') === 'true' && document.getElementById('mute-2').getAttribute('aria-pressed') === 'false'`));
    await shot(win, '04-controles.png');

    // reproducir (puede no haber tarjeta de sonido en esta máquina de pruebas)
    await ev(win, `document.getElementById('play').click()`);
    await sleep(2500);
    const t1 = await ev(win, `document.getElementById('time').textContent`);
    console.log('  tiempo tras reproducir:', t1);
    const advanced = !t1.startsWith('0:00 /');
    console.log(advanced ? '  la reproducción avanza' : '  (la reproducción no avanza: normal sin dispositivo de audio)');
    await ev(win, `document.getElementById('play').click()`);

    // exportar WAV (con tempo 75 % y +2 st) y MP3
    nextSave = path.join(out, 'mezcla.wav');
    await ev(win, `document.getElementById('export-wav').click()`);
    await waitFor(win, `document.getElementById('export-status').textContent.includes('Guardada')`, 120000, 'exportar WAV');
    const wav = fs.readFileSync(nextSave);
    const dataBytes = wav.readUInt32LE(40);
    const secs = dataBytes / 4 / 44100;
    const song = JSON.parse(fs.readFileSync(path.join(process.env.RVS_USER_DATA, 'projects', fs.readdirSync(path.join(process.env.RVS_USER_DATA, 'projects'))[0], 'project.json'), 'utf8'));
    check('el WAV exportado existe y es válido', wav.slice(0, 4).toString() === 'RIFF' && secs > 1, `${secs.toFixed(2)} s`);
    check('la duración respeta la velocidad (75 %)', Math.abs(secs - song.durationSec / 0.75) < 0.3, `esperado ${(song.durationSec / 0.75).toFixed(2)} s`);
    nextSave = path.join(out, 'mezcla.mp3');
    await ev(win, `document.getElementById('export-mp3').click()`);
    await waitFor(win, `document.getElementById('export-status').textContent.includes('Guardada') && !document.getElementById('export-mp3').disabled`, 120000, 'exportar MP3');
    await sleep(500);
    const mp3 = fs.readFileSync(nextSave);
    check('el MP3 exportado existe', mp3.length > 10000 && (mp3.slice(0, 3).toString() === 'ID3' || mp3[0] === 0xff), `${mp3.length} bytes`);

    // pista de estudio: marca de inicio, Sorpresa y exportación recortada
    await ev(win, `document.getElementById('estudio').open = true`);
    check('la tarjeta Pista de estudio existe', await ev(win, `!!document.getElementById('start-here') && document.getElementById('start-out').textContent.length > 0`));
    await ev(win, `document.querySelector('[data-vozmode="sorpresa"]').click()`);
    check('Sorpresa se activa y muestra sus opciones', await ev(win, `!document.getElementById('sorpresa-opts').hidden && document.querySelector('[data-vozmode="sorpresa"]').getAttribute('aria-pressed') === 'true'`));
    await ev(win, `document.getElementById('sorpresa-nivel').value = 'muchos'; document.getElementById('sorpresa-nivel').dispatchEvent(new Event('change')); document.getElementById('sorpresa-otra').click();`);
    const zonas = await ev(win, `document.querySelectorAll('#wave-0 .zone').length`);
    console.log('  zonas de silencio en la voz:', zonas, '| en los coros:', await ev(win, `document.querySelectorAll('#wave-1 .zone').length`));
    check('los coros siguen los cortes de la voz', (await ev(win, `document.querySelectorAll('#wave-1 .zone').length`)) === zonas);
    await ev(win, `(() => { const w = document.getElementById('wave-2'); const r = w.getBoundingClientRect(); w.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * 0.25, clientY: r.top + 10, bubbles: true })); })()`);
    await ev(win, `document.getElementById('start-here').click()`);
    const startTxt = await ev(win, `document.getElementById('start-out').textContent`);
    check('"Poner aquí" mueve la marca de inicio', startTxt !== '0:00' && (await ev(win, `document.getElementById('trim-on').checked && !!document.querySelector('#wave-0 .startmark')`)), startTxt);
    nextSave = path.join(out, 'estudio.wav');
    await ev(win, `document.getElementById('export-wav').click()`);
    await waitFor(win, `document.getElementById('export-status').textContent.includes('Guardada')`, 120000, 'exportar con inicio recortado');
    const wav2 = fs.readFileSync(nextSave);
    const secs2 = wav2.readUInt32LE(40) / 4 / 44100;
    const [mm, ss] = startTxt.split(':').map(Number);
    const exp2 = (song.durationSec - (mm * 60 + ss)) / 0.75;
    check('la mezcla empieza en la marca de inicio', Math.abs(secs2 - exp2) < 1.2, `${secs2.toFixed(2)} s, esperado ≈ ${exp2.toFixed(2)} s`);
    await shot(win, '04b-estudio.png');

    // biblioteca
    await ev(win, `document.getElementById('back').click()`);
    await sleep(800);
    check('la canción aparece en la biblioteca', await ev(win, `document.querySelectorAll('#library-list .song').length === 1`));
    await shot(win, '05-biblioteca.png');
  } catch (e) {
    check('ejecución completa de la prueba', false, e.message);
    try { await shot(win, '99-error.png'); } catch { /* sin captura */ }
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} comprobaciones correctas. Capturas en ${shots}`);
  app.exit(failed ? 1 : 0);
});

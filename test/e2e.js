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

    // pista de estudio: franja de edición (inicio, huecos, zoom)
    const ptr = (sel, type, fx, dy = 0) => `(() => { const el = document.querySelector(${JSON.stringify(sel)}); const lane = document.getElementById('strip-lane').getBoundingClientRect(); const x = lane.left + lane.width * ${fx}; el.dispatchEvent(new PointerEvent('${type}', { pointerId: 1, clientX: x, clientY: lane.top + 20 + ${dy}, bubbles: true })); })()`;
    check('la tarjeta Pista de estudio existe', await ev(win, `!!document.getElementById('trim-on') && !!document.getElementById('strip-lane') && document.getElementById('trim-opts').hidden`));
    await ev(win, `document.getElementById('trim-on').click()`);
    check('al marcar "Quitar el principio" sale la pestaña naranja', await ev(win, `!document.getElementById('trim-opts').hidden && !!document.querySelector('.shandle')`));
    const before = await ev(win, `document.getElementById('start-out').textContent`);
    await ev(win, ptr('.shandle', 'pointerdown', 0.05)); await ev(win, ptr('.shandle', 'pointermove', 0.35)); await ev(win, ptr('.shandle', 'pointerup', 0.35));
    const startTxt = await ev(win, `document.getElementById('start-out').textContent`);
    check('arrastrar la pestaña naranja mueve el inicio', startTxt !== before && !!(await ev(win, `document.querySelector('#wave-0 .startmark')`)), `${before} → ${startTxt}`);

    await ev(win, `document.getElementById('trim-on').click()`); // la canción de prueba es muy corta: Sorpresa sin recorte
    await ev(win, `document.querySelector('[data-tab="voz"]').click()`);
    check('La pestaña Voz por tramos se abre', await ev(win, `!document.getElementById('tab-voz').hidden && document.getElementById('tab-sonido').hidden`));
    const nBars = () => ev(win, `document.querySelectorAll('#strip-lane .zbar:not(.ghost)').length`);
    await ev(win, `document.getElementById('sorpresa-nivel').value = 'muchos'; document.getElementById('sorpresa-apply').click();`);
    if ((await nBars()) === 0) await ev(win, `document.getElementById('zone-add').click()`); // canción de prueba muy corta: puede que no haya propuesta
    let n0 = await nBars();
    console.log('  huecos propuestos:', n0, '| sombreados en la voz:', await ev(win, `document.querySelectorAll('#wave-0 .zone').length`), '| en los coros:', await ev(win, `document.querySelectorAll('#wave-1 .zone').length`));
    check('hay huecos y los coros los siguen', n0 >= 1 && n0 === (await ev(win, `document.querySelectorAll('#wave-1 .zone').length`)));
    // mover un hueco arrastrándolo
    const left0 = await ev(win, `document.querySelector('#strip-lane .zbar').style.left`);
    await ev(win, `(() => { const bar = document.querySelector('#strip-lane .zbar'); const r = bar.getBoundingClientRect(); const mid = r.left + r.width / 2; const fire = (t, x) => bar.dispatchEvent(new PointerEvent(t, { pointerId: 1, clientX: x, clientY: r.top + 5, bubbles: true })); fire('pointerdown', mid); fire('pointermove', mid + 30); fire('pointerup', mid + 30); })()`);
    const left1 = await ev(win, `document.querySelector('#strip-lane .zbar').style.left`);
    check('arrastrar un hueco lo mueve', left0 !== left1, `${left0} → ${left1}`);
    // alargarlo desde el borde derecho
    const w0 = await ev(win, `document.querySelector('#strip-lane .zbar').style.width`);
    await ev(win, `(() => { const h = document.querySelector('#strip-lane .zbar .zh.r'); const r = h.getBoundingClientRect(); const fire = (t, x) => h.dispatchEvent(new PointerEvent(t, { pointerId: 1, clientX: x, clientY: r.top + 5, bubbles: true })); fire('pointerdown', r.left + 4); fire('pointermove', r.left + 4 + 25); fire('pointerup', r.left + 4 + 25); })()`);
    const w1 = await ev(win, `document.querySelector('#strip-lane .zbar').style.width`);
    check('tirar del borde cambia la duración del hueco', w0 !== w1, `${w0} → ${w1}`);
    // quitar y añadir
    await ev(win, `document.querySelector('#strip-lane .zbar .zx').click()`);
    check('la × quita el hueco', (await nBars()) === n0 - 1);
    await ev(win, `document.getElementById('zone-add').click()`);
    check('"+ Añadir hueco" crea uno nuevo', (await nBars()) === n0);
    // crear arrastrando sobre un espacio vacío
    await ev(win, `(() => { document.querySelectorAll('#strip-lane .zbar .zx').forEach((x) => x.click()); })()`);
    await ev(win, ptr('#strip-lane', 'pointerdown', 0.55)); await ev(win, ptr('#strip-lane', 'pointermove', 0.8)); await ev(win, ptr('#strip-lane', 'pointerup', 0.8));
    check('arrastrar sobre la franja vacía crea un hueco', (await nBars()) === 1);
    await ev(win, `document.querySelector('[data-target="all"]').click(); document.querySelector('[data-level="25"]').click()`);
    check('el nivel de voz 25 % se ve en el tramo y se aplica al motor', (await ev(win, `document.querySelector('#strip-lane .zbar .zl').textContent`)) === '25 %' && (await ev(win, `document.getElementById('zone-level').value`)) === '25');
    await ev(win, `document.querySelector('[data-shift="-10"]').click()`);
    check('bajar 10 deja el tramo al 15 %', (await ev(win, `document.querySelector('#strip-lane .zbar .zl').textContent`)) === '15 %');
    await ev(win, `document.querySelector('[data-level="0"]').click()`);
    check('Sin voz pone el tramo a cero', (await ev(win, `document.querySelector('#strip-lane .zbar .zl').textContent`)) === 'Sin voz');
    // zoom
    await ev(win, `document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click();`);
    check('el zoom amplía las ondas y aparece el desplazador', (await ev(win, `document.getElementById('zoom-out-txt').textContent`)).startsWith('×') && (await ev(win, `!document.getElementById('strip-pan').hidden`)));
    await shot(win, '04c-zoom.png');
    // el zoom se centra donde está el cursor, y la pestaña naranja sigue diciendo la verdad
    await ev(win, `document.getElementById('zoom-all').click()`);
    await ev(win, `(() => { const w = document.getElementById('wave-2'); const r = w.getBoundingClientRect(); w.dispatchEvent(new MouseEvent('click', { clientX: r.left + r.width * 0.8, clientY: r.top + 10, bubbles: true })); })()`);
    const headBefore = await ev(win, `parseFloat(document.getElementById('head-2').style.left)`);
    await ev(win, `document.getElementById('zoom-in').click(); document.getElementById('zoom-in').click();`);
    const headAfter = await ev(win, `parseFloat(document.getElementById('head-2').style.left)`);
    check('el zoom se centra en el cursor (no salta al medio)', Math.abs(headAfter - headBefore) < 25 && headAfter > 0 && headAfter < 100, `${headBefore.toFixed(0)} % → ${headAfter.toFixed(0)} %`);
    const startBeforeZoomOut = await ev(win, `document.getElementById('start-out').textContent`);
    await ev(win, `document.getElementById('zoom-all').click()`);
    check('"Todo" no cambia el inicio', (await ev(win, `document.getElementById('start-out').textContent`)) === startBeforeZoomOut);
    await ev(win, `document.getElementById('zoom-all').click()`);
    check('"Todo" vuelve a ver la canción entera', (await ev(win, `document.getElementById('zoom-out-txt').textContent`)) === '' && (await ev(win, `document.getElementById('strip-pan').hidden`)));
    await ev(win, `document.getElementById('trim-on').click()`); // el recorte vuelve para exportar
    await shot(win, '04b-estudio.png');
    nextSave = path.join(out, 'estudio.wav');
    await ev(win, `document.getElementById('export-wav').click()`);
    await waitFor(win, `document.getElementById('export-status').textContent.includes('Guardada')`, 120000, 'exportar con inicio recortado');
    const wav2 = fs.readFileSync(nextSave);
    const secs2 = wav2.readUInt32LE(40) / 4 / 44100;
    const [mm, ss] = startTxt.split(':').map(Number);
    const exp2 = (song.durationSec - (mm * 60 + ss)) / 0.75;
    check('la mezcla empieza en la marca de inicio', Math.abs(secs2 - exp2) < 1.6, `${secs2.toFixed(2)} s, esperado ≈ ${exp2.toFixed(2)} s`);
    await shot(win, '04b-estudio.png');

    // modo Ayuda, metrónomo y claqueta
    await ev(win, `document.getElementById('trim-on').click()`); // sin recorte: el inicio es 0
    await ev(win, `document.getElementById('ayuda-apply').click()`);
    console.log('  huecos de Ayuda:', await ev(win, `document.querySelectorAll('#strip-lane .zbar:not(.ghost)').length`));
    await ev(win, `(() => { document.querySelectorAll('#strip-lane .zbar .zx').forEach((x) => x.click()); })()`);
    check('el metrónomo y la claqueta enseñan sus controles de pulso', await ev(win, `(() => { document.querySelector('[data-metro="2"]').click(); const f = !document.getElementById('metro-flip').hidden; document.querySelector('[data-metro="1"]').click(); document.querySelector('[data-count="8"]').click(); return f && !document.getElementById('cstep-opts').hidden; })()`));
    const bpmTxt = await ev(win, `document.getElementById('bpm-in').value`);
    const bpmNum = parseFloat(bpmTxt);
    check('el pulso detectado es un tempo razonable', bpmNum > 50 && bpmNum < 220, `${bpmTxt} BPM`);
    await ev(win, `document.getElementById('bpm-half').click(); document.getElementById('bpm-double').click();`);
    const bpmBack = parseFloat(await ev(win, `document.getElementById('bpm-in').value`));
    check('×2 y ÷2 vuelven al mismo tempo', Math.abs(bpmBack - bpmNum) <= 0.05, `${bpmNum} → ${bpmBack}`); // el redondeo a 0,01 puede mover una centésima
    await ev(win, `(() => { const i = document.getElementById('bpm-in'); i.value = '100.5'; i.dispatchEvent(new Event('change')); })()`);
    check('el pulso tecleado cambia también el tempo de arriba', (await ev(win, `document.getElementById('chip-bpm').textContent`)).startsWith('100.5'));
    await ev(win, `(() => { const i = document.getElementById('bpm-in'); i.value = '${bpmNum}'; i.dispatchEvent(new Event('change')); })()`);
    await ev(win, `document.getElementById('click-listen').click()`);
    await sleep(600);
    const tclaq = await ev(win, `document.getElementById('time').textContent`);
    console.log('  al probar con claqueta, el contador dice:', tclaq);
    await ev(win, `document.getElementById('play').click()`);
    nextSave = path.join(out, 'claqueta.wav');
    await ev(win, `document.getElementById('export-wav').click()`);
    await waitFor(win, `document.getElementById('export-status').textContent.includes('Guardada')`, 120000, 'exportar con claqueta y metrónomo');
    const wav3 = fs.readFileSync(nextSave);
    const secs3 = wav3.readUInt32LE(40) / 4 / 44100;
    const exp3 = (song.durationSec + (8 * 60) / bpmNum) / 0.75;
    check('el archivo incluye la claqueta de 8 tiempos antes de la canción', Math.abs(secs3 - exp3) < 0.5, `${secs3.toFixed(2)} s, esperado ≈ ${exp3.toFixed(2)} s`);
    await shot(win, '04d-claqueta.png');

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

'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, session, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const engine = require('./engine');
const v = require('./validate');
const updater = require('./update');
const recent = require('./recent');

if (process.env.RVS_USER_DATA) app.setPath('userData', process.env.RVS_USER_DATA);
protocol.registerSchemesAsPrivileged([{ scheme: 'rvs', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

const RENDERER = path.join(__dirname, '..', 'renderer');
let win = null; let job = null; let folder = null; const saved = new Set();
let recents = []; const allowed = new Set();
const MODELS = app.isPackaged ? path.join(process.resourcesPath, 'models') : (process.env.RVS_MODELS || path.join(__dirname, '..', '..', '..', 'build', 'models'));
const settingsFile = () => path.join(app.getPath('userData'), 'ajustes.json');

function readSettings() { try { return JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) || {}; } catch { return {}; } }
function writeSettings() { try { fs.writeFileSync(settingsFile(), JSON.stringify({ folder, recent: recents })); } catch { /* no crítico */ } }
function loadFolder() {
  try { const f = readSettings().folder; if (f && fs.statSync(f).isDirectory()) return f; } catch { /* sin ajustes */ }
  return app.getPath('downloads');
}
function saveFolder(f) { folder = f; writeSettings(); }
function remember(p) { recents = recent.add(recents, p); allowed.add(p); writeSettings(); }
function recentList() {
  return recents.filter((p) => fs.existsSync(p)).map((p) => ({
    path: p, name: recent.stemOf(p), processed: recent.isProcessed(p),
    karaoke: fs.existsSync(recent.outputPath(p, 'karaoke')), voz: fs.existsSync(recent.outputPath(p, 'voz')),
  }));
}

function inside(base, target) { const rel = path.relative(base, target); return rel && !rel.startsWith('..') && !path.isAbsolute(rel); }

function registerProtocol() {
  protocol.handle('rvs', (request) => {
    const url = new URL(request.url);
    const p = decodeURIComponent(url.pathname);
    const file = path.normalize(path.join(RENDERER, p === '/' ? '/index.html' : p));
    if (url.hostname !== 'app' || !inside(RENDERER, file) || !fs.existsSync(file)) return new Response('No encontrado', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_w, _p, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
}

function createWindow() {
  win = new BrowserWindow({
    width: 760, height: 800, minWidth: 560, minHeight: 600, backgroundColor: '#f8f8f8', title: 'Descargar audio', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadURL('rvs://app/index.html');
  win.on('closed', () => { if (job) job.cancel(); win = null; });
}

const fail = (code, message) => ({ ok: false, error: { code, message } });
const wrap = (fn) => async (...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (e) {
    if (e && e.code) return fail(e.code, e.message);
    console.error(e); return fail('unexpected', 'Ha ocurrido un error inesperado.');
  }
};

function registerIpc() {
  ipcMain.handle('update:check', wrap(() => updater.check()));
  ipcMain.handle('update:open', wrap(() => { shell.openExternal(updater.PAGE); return true; }));
  ipcMain.handle('clipboard:read', wrap(() => clipboard.readText().slice(0, 400)));
  ipcMain.handle('folder:get', wrap(() => folder));
  ipcMain.handle('folder:choose', wrap(async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Carpeta donde guardar el audio', properties: ['openDirectory', 'createDirectory'], defaultPath: folder });
    if (!r.canceled && r.filePaths[0]) saveFolder(r.filePaths[0]);
    return folder;
  }));
  ipcMain.handle('probe', wrap((_e, raw) => {
    const url = v.youtubeUrl(raw);
    if (!url) throw { code: 'bad_url', message: 'Pega un enlace de un vídeo de YouTube.' };
    return engine.run(['probe', '--url', url]).promise;
  }));
  ipcMain.handle('download', wrap(async (e, { url, format }) => {
    const clean = v.youtubeUrl(url);
    if (!clean) throw { code: 'bad_url', message: 'Pega un enlace de un vídeo de YouTube.' };
    if (!v.FORMATS.has(format)) throw { code: 'bad_format', message: 'Formato no admitido.' };
    if (job) throw { code: 'busy', message: 'Ya hay una descarga en marcha.' };
    const sender = e.sender;
    job = engine.run(['download', '--url', clean, '--out', folder, '--format', format], (evt) => { if (!sender.isDestroyed()) sender.send('engine:progress', evt); });
    try { const r = await job.promise; saved.add(r.path); remember(r.path); return r; } finally { job = null; }
  }));
  ipcMain.handle('cancel', wrap(() => { if (job) job.cancel(); return true; }));
  ipcMain.handle('shell:show', wrap((_e, p) => { if (saved.has(p) || allowed.has(p)) shell.showItemInFolder(p); return true; }));
  ipcMain.handle('recent:list', wrap(() => recentList()));
  ipcMain.handle('recent:remove', wrap((_e, p) => { recents = recents.filter((x) => x !== p); writeSettings(); return recentList(); }));
  ipcMain.handle('recent:show', wrap((_e, { path: p, which }) => {
    if (!allowed.has(p)) return false;
    const target = which === 'orig' ? p : recent.outputPath(p, which);
    if (target && fs.existsSync(target)) shell.showItemInFolder(target);
    return true;
  }));
  ipcMain.handle('file:pick', wrap(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Elige una canción ya guardada', properties: ['openFile'], defaultPath: folder,
      filters: [{ name: 'Audio y vídeo', extensions: ['mp3', 'm4a', 'wav', 'flac', 'aac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm'] }],
    });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (!recent.isAudio(p)) throw { code: 'bad_file', message: 'Elige un archivo de audio o vídeo.' };
    remember(p);
    return p;
  }));
  ipcMain.handle('karaoke', wrap(async (e, { path: p, mode }) => {
    if (!allowed.has(p) || !recent.MODES[mode]) throw { code: 'bad_file', message: 'Elige la canción de la lista o con «Elegir otra canción».' };
    if (recent.isProcessed(p)) throw { code: 'already', message: 'Ese archivo ya es una versión karaoke o solo voz. Usa el original.' };
    if (!fs.existsSync(p)) throw { code: 'bad_file', message: 'No encuentro ese archivo. ¿Lo has movido o borrado?' };
    if (job) throw { code: 'busy', message: 'Ya hay un trabajo en marcha.' };
    const sender = e.sender;
    job = engine.run(['karaoke', '--file', p, '--mode', mode, '--models', MODELS], (evt) => { if (!sender.isDestroyed()) sender.send('engine:progress', evt); });
    try { const r = await job.promise; saved.add(r.path); return r; } finally { job = null; }
  }));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    folder = loadFolder();
    recents = recent.clean(readSettings().recent); for (const p of recents) allowed.add(p);
    Menu.setApplicationMenu(Menu.buildFromTemplate([...(process.platform === 'darwin' ? [{ role: 'appMenu' }] : []), { role: 'editMenu' }, { role: 'windowMenu' }]));
    registerProtocol(); hardenSession(); registerIpc(); createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

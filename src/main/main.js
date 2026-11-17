'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, net, session, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const engine = require('./engine');
const store = require('./store');
const v = require('./validate');

if (process.env.RVS_USER_DATA) app.setPath('userData', process.env.RVS_USER_DATA);

protocol.registerSchemesAsPrivileged([
  { scheme: 'rvs', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
]);

const RENDERER = path.join(__dirname, '..', 'renderer');
const exported = new Set();
const jobs = new Map();
let win = null;

function inside(base, target) {
  const rel = path.relative(base, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function registerProtocol() {
  protocol.handle('rvs', (request) => {
    const url = new URL(request.url);
    let file = null;
    if (url.hostname === 'app') {
      const pathname = decodeURIComponent(url.pathname);
      if (pathname.startsWith('/data/')) {
        const [id, name] = pathname.slice('/data/'.length).split('/');
        if (v.isProjectId(id) && v.STEM_FILES.has(name)) file = path.join(store.projectDir(id), name);
      } else {
        const candidate = path.normalize(path.join(RENDERER, pathname === '/' ? '/index.html' : pathname));
        if (inside(RENDERER, candidate)) file = candidate;
      }
    }
    if (!file || !fs.existsSync(file)) return new Response('No encontrado', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}

function hardenSession() {
  const ses = session.defaultSession;
  ses.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.webRequest.onHeadersReceived((details, cb) => {
    cb({ responseHeaders: { ...details.responseHeaders, 'X-Content-Type-Options': ['nosniff'] } });
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1180, height: 780, minWidth: 920, minHeight: 640,
    backgroundColor: '#f8f8f8', title: 'Pistas', show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.loadURL('rvs://app/index.html');
  win.on('closed', () => { for (const j of jobs.values()) j.cancel(); win = null; });
}

function buildMenu() {
  const mac = process.platform === 'darwin';
  const template = [
    ...(mac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { label: 'Ver', submenu: [{ role: 'togglefullscreen' }, ...(app.isPackaged ? [] : [{ role: 'toggleDevTools' }])] },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

const fail = (code, message) => ({ ok: false, error: { code, message } });
const wrap = (fn) => async (...a) => {
  try { return { ok: true, data: await fn(...a) }; } catch (e) {
    if (e && e.code) return fail(e.code, e.message);
    console.error(e);
    return fail('unexpected', 'Ha ocurrido un error inesperado.');
  }
};

function registerIpc() {
  ipcMain.handle('clipboard:read', wrap(() => clipboard.readText().slice(0, 400)));

  ipcMain.handle('probe', wrap((_e, rawUrl) => {
    const url = v.youtubeUrl(rawUrl);
    if (!url) throw { code: 'bad_url', message: 'Pega un enlace de un vídeo de YouTube.' };
    return engine.run(['probe', '--url', url]).promise;
  }));

  ipcMain.handle('file:pick', wrap(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Elige una canción', properties: ['openFile'],
      filters: [{ name: 'Audio o vídeo', extensions: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'mp4', 'mov', 'mkv', 'webm'] }],
    });
    return r.canceled ? null : r.filePaths[0];
  }));

  ipcMain.handle('process', wrap(async (e, { jobId, url, filePath, title }) => {
    if (typeof jobId !== 'string' || jobs.has(jobId)) throw { code: 'bad_job', message: 'Trabajo no válido.' };
    const id = store.newId();
    const out = store.projectDir(id);
    const args = ['process', '--out', out, '--models', engine.modelsDir()];
    if (url) {
      const clean = v.youtubeUrl(url);
      if (!clean) throw { code: 'bad_url', message: 'Pega un enlace de un vídeo de YouTube.' };
      args.push('--url', clean);
    } else if (filePath) {
      if (!v.isAudioPath(filePath) || !fs.existsSync(filePath)) throw { code: 'bad_file', message: 'Elige un archivo de audio o vídeo.' };
      args.push('--file', filePath);
      if (title) args.push('--title', String(title).slice(0, 120));
    } else throw { code: 'bad_input', message: 'Falta el enlace o el archivo.' };

    const sender = e.sender;
    const job = engine.run(args, (evt) => { if (!sender.isDestroyed()) sender.send('engine:progress', jobId, evt); });
    jobs.set(jobId, job);
    try { return await job.promise; } catch (err) {
      fs.rmSync(out, { recursive: true, force: true });
      throw err;
    } finally { jobs.delete(jobId); }
  }));

  ipcMain.handle('process:cancel', wrap((_e, jobId) => { const j = jobs.get(jobId); if (j) j.cancel(); return true; }));
  ipcMain.handle('library:list', wrap(() => store.list()));
  ipcMain.handle('library:delete', wrap((_e, id) => {
    if (!v.isProjectId(id)) throw { code: 'bad_id', message: 'Proyecto no válido.' };
    store.remove(id); return true;
  }));

  ipcMain.handle('export:save', wrap(async (_e, { wav, format, name }) => {
    if (!v.EXPORT_FORMATS.has(format)) throw { code: 'bad_format', message: 'Formato no admitido.' };
    if (!(wav instanceof ArrayBuffer) || wav.byteLength < 44 || wav.byteLength > 1.5 * 1024 ** 3) throw { code: 'bad_audio', message: 'Audio no válido.' };
    const r = await dialog.showSaveDialog(win, {
      title: 'Guardar mezcla', defaultPath: `${v.safeFileName(name)}.${format}`,
      filters: [{ name: format.toUpperCase(), extensions: [format] }],
    });
    if (r.canceled || !r.filePath) return null;
    if (format === 'wav') fs.writeFileSync(r.filePath, Buffer.from(wav));
    else {
      const tmp = path.join(os.tmpdir(), `pistas-${process.pid}-${Date.now()}.wav`);
      fs.writeFileSync(tmp, Buffer.from(wav));
      try { await engine.run(['encode', '--in', tmp, '--out', r.filePath, '--format', 'mp3']).promise; } finally { fs.rmSync(tmp, { force: true }); }
    }
    exported.add(r.filePath);
    return r.filePath;
  }));

  ipcMain.handle('shell:show', wrap((_e, p) => { if (exported.has(p)) shell.showItemInFolder(p); return true; }));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    registerProtocol(); hardenSession(); registerIpc(); buildMenu(); createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });
  app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
}

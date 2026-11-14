// Quick Mark for Windows — desktop shell around the Quick Mark web app.
const { app, BrowserWindow, protocol, net, ipcMain, dialog, shell, Menu, session } = require('electron');
const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const crypto = require('crypto');

const SCHEME = 'qm';
const LINK_SCHEME = 'quickmark';
const APP_DIR = __dirname;
const PPTX_FILE = path.join(__dirname, '..', 'node_modules', 'pptxgenjs', 'dist', 'pptxgen.bundle.js');

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }
]);

let win = null;
let DATA_DIR, IMG_DIR;

/* ---------- storage: one JSON file per board/folder, images as files ---------- */
const COLLS = ['boards', 'folders'];
const cache = {};
const okColl = c => COLLS.includes(c);
const okId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id);

function ensureDirs() {
  DATA_DIR = path.join(app.getPath('documents'), 'Quick Mark');
  IMG_DIR = path.join(DATA_DIR, 'images');
  for (const d of [DATA_DIR, IMG_DIR, ...COLLS.map(c => path.join(DATA_DIR, c))]) fs.mkdirSync(d, { recursive: true });
}
function loadColl(c) {
  if (cache[c]) return cache[c];
  const m = new Map();
  const dir = path.join(DATA_DIR, c);
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { m.set(f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))); } catch (e) { /* skip broken file */ }
  }
  return (cache[c] = m);
}
function writeDoc(c, id, data) {
  const file = path.join(DATA_DIR, c, id + '.json');
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

ipcMain.handle('db:list', (_e, c) => {
  if (!okColl(c)) throw new Error('bad collection');
  return Array.from(loadColl(c), ([id, data]) => ({ id, data }));
});
ipcMain.handle('db:get', (_e, c, id) => {
  if (!okColl(c) || !okId(id)) return null;
  return loadColl(c).get(id) || null;
});
ipcMain.handle('db:set', (_e, c, id, data) => {
  if (!okColl(c) || !okId(id)) throw new Error('bad id');
  loadColl(c).set(id, data); writeDoc(c, id, data); return true;
});
ipcMain.handle('db:update', (_e, c, id, patch) => {
  if (!okColl(c) || !okId(id)) throw new Error('bad id');
  const m = loadColl(c); const cur = m.get(id);
  if (!cur) throw new Error('not found');
  Object.assign(cur, patch); writeDoc(c, id, cur); return true;
});
ipcMain.handle('db:del', (_e, c, id) => {
  if (!okColl(c) || !okId(id)) return false;
  loadColl(c).delete(id);
  try { fs.unlinkSync(path.join(DATA_DIR, c, id + '.json')); } catch (e) {}
  return true;
});

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/svg+xml': 'svg' };
const MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' };
ipcMain.handle('asset:upload', (_e, buf, type) => {
  const ext = EXT[type] || 'png';
  const id = crypto.randomBytes(9).toString('hex') + '.' + ext;
  fs.writeFileSync(path.join(IMG_DIR, id), Buffer.from(buf));
  return id;
});

ipcMain.handle('file:save', async (_e, name, buf) => {
  const ext = path.extname(name).slice(1).toLowerCase();
  const filters = ext === 'pptx' ? [{ name: 'PowerPoint', extensions: ['pptx'] }]
    : ext === 'png' ? [{ name: 'PNG image', extensions: ['png'] }]
    : [{ name: 'All files', extensions: ['*'] }];
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name), filters });
  if (r.canceled || !r.filePath) return 'declined';
  fs.writeFileSync(r.filePath, Buffer.from(buf));
  return 'saved';
});

/* ---------- links: quickmark://open/#b-<id> opens that board ---------- */
function hashFromArgs(argv) {
  const u = (argv || []).find(a => typeof a === 'string' && a.toLowerCase().startsWith(LINK_SCHEME + '://'));
  if (!u) return '';
  const i = u.indexOf('#');
  const h = i >= 0 ? u.slice(i) : '';
  return /^#[bf]-[a-z0-9]+$/.test(h) ? h : '';
}
function openHash(h) {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.focus();
  if (h) win.webContents.executeJavaScript('location.hash=' + JSON.stringify(h)).catch(() => {});
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv) => openHash(hashFromArgs(argv)));

  if (process.defaultApp && process.argv.length >= 2) {
    app.setAsDefaultProtocolClient(LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(LINK_SCHEME);
  }

  app.whenReady().then(() => {
    ensureDirs();

    protocol.handle(SCHEME, req => {
      const u = new URL(req.url);
      let p = decodeURIComponent(u.pathname).replace(/^\/+/, '');
      let file;
      if (p.startsWith('_blob/')) {
        const id = p.slice(6);
        if (!/^[a-f0-9]+\.[a-z]+$/.test(id)) return new Response('not found', { status: 404 });
        file = path.join(IMG_DIR, id);
        if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
        const data = fs.readFileSync(file);
        return new Response(data, { headers: { 'content-type': MIME[id.split('.').pop()] || 'application/octet-stream' } });
      }
      if (p === '' ) p = 'index.html';
      if (p === 'pptxgen.bundle.js') file = PPTX_FILE;
      else {
        file = path.normalize(path.join(APP_DIR, p));
        if (!file.startsWith(APP_DIR)) return new Response('not found', { status: 404 });
      }
      return net.fetch(pathToFileURL(file).toString());
    });

    const ses = session.defaultSession;
    const allowed = new Set(['clipboard-read', 'clipboard-sanitized-write']);
    ses.setPermissionRequestHandler((_wc, perm, cb) => cb(allowed.has(perm)));
    ses.setPermissionCheckHandler((_wc, perm) => allowed.has(perm));

    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'File', submenu: [
        { label: 'Open boards folder', click: () => shell.openPath(DATA_DIR) },
        { type: 'separator' },
        { role: 'quit', label: 'Exit' }
      ] },
      { label: 'View', submenu: [
        { label: 'Reload', accelerator: 'F5', click: () => win && win.reload() },
        { role: 'togglefullscreen', accelerator: 'F11' },
        { type: 'separator' },
        { role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' }
      ] }
    ]));

    win = new BrowserWindow({
      width: 1400, height: 900, minWidth: 700, minHeight: 500,
      title: 'Quick Mark',
      icon: path.join(__dirname, 'icon.png'),
      autoHideMenuBar: true,
      backgroundColor: '#ffffff',
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, spellcheck: true }
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (/^https?:/.test(url)) shell.openExternal(url);
      return { action: 'deny' };
    });
    win.webContents.on('will-navigate', (e, url) => {
      if (!url.startsWith(SCHEME + '://')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); }
    });
    win.on('page-title-updated', e => e.preventDefault());
    win.loadURL(SCHEME + '://app/index.html' + hashFromArgs(process.argv));
  });

  app.on('window-all-closed', () => app.quit());
}

const { app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage, shell, Notification } = require('electron');
const path = require('path');
const fs = require('fs');

const APP_ID = 'com.bloombyte.app';
// Three layouts: a normal app window, a floating widget, and a small corner pill. All resizable.
const LAYOUTS = {
  app:    { min: [400, 460], max: null,       def: [560, 620], onTop: false, taskbar: true },
  widget: { min: [360, 420], max: [900, 1000], def: [440, 490], onTop: true,  taskbar: false },
  mini:   { min: [280, 96],  max: [640, 170],  def: [330, 108], onTop: true,  taskbar: false }
};
const MARGIN = 16;

let win = null;
let tray = null;
let layout = 'app';
let quitting = false;
let trayHintShown = false;

/* ---------- data ---------- */
const dataFile = () => path.join(app.getPath('userData'), 'bloombyte-data.json');
function readData() {
  try { return JSON.parse(fs.readFileSync(dataFile(), 'utf8')); }
  catch { return { sessions: [], notes: [], settings: {} }; }
}
function writeData(data) {
  try {
    fs.mkdirSync(path.dirname(dataFile()), { recursive: true });
    const tmp = dataFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, dataFile());
    return true;
  } catch (e) { console.error(e); return false; }
}

/* ---------- remembered window sizes/positions per layout ---------- */
const winFile = () => path.join(app.getPath('userData'), 'window.json');
let winState = {};
function loadWinState() { try { winState = JSON.parse(fs.readFileSync(winFile(), 'utf8')) || {}; } catch { winState = {}; } }
let winSaveTimer = null;
function saveWinState() {
  clearTimeout(winSaveTimer);
  winSaveTimer = setTimeout(() => { try { fs.mkdirSync(path.dirname(winFile()), { recursive: true }); fs.writeFileSync(winFile(), JSON.stringify(winState)); } catch {} }, 400);
}
function rememberBounds() {
  if (!win || win.isMinimized() || win.isMaximized() || win.isFullScreen()) return;
  const b = win.getBounds();
  if (layout === 'app') winState.app = { x: b.x, y: b.y, width: b.width, height: b.height };
  else winState[layout] = { width: b.width, height: b.height, right: b.x + b.width, bottom: b.y + b.height };
  saveWinState();
}

function workAreaFor(b) { return screen.getDisplayMatching(b).workArea; }
function clamp(b) {
  const a = workAreaFor(b);
  const width = Math.min(b.width, a.width), height = Math.min(b.height, a.height);
  const x = Math.min(Math.max(b.x, a.x), a.x + a.width - width);
  const y = Math.min(Math.max(b.y, a.y), a.y + a.height - height);
  return { x, y, width, height };
}
function boundsFor(next, from) {
  const L = LAYOUTS[next];
  if (next === 'app') {
    const s = winState.app;
    if (s && s.width) return clamp(s);
    const a = screen.getPrimaryDisplay().workArea;
    return clamp({ x: a.x + Math.round((a.width - L.def[0]) / 2), y: a.y + Math.round((a.height - L.def[1]) / 2), width: L.def[0], height: L.def[1] });
  }
  const s = winState[next] || {};
  const width = s.width || L.def[0], height = s.height || L.def[1];
  let right, bottom;
  if (from && from !== 'app') {
    // Switching between widget and mini: keep the bottom-right corner where it is.
    const c = win.getBounds(); right = c.x + c.width; bottom = c.y + c.height;
  } else if (s.right) { right = s.right; bottom = s.bottom; }
  else { const a = screen.getPrimaryDisplay().workArea; right = a.x + a.width - MARGIN; bottom = a.y + a.height - MARGIN; }
  return clamp({ x: right - width, y: bottom - height, width, height });
}

function applyLayout(next) {
  if (!win || !LAYOUTS[next]) return;
  if (win.isMaximized()) win.unmaximize();
  rememberBounds();
  const from = layout;
  const L = LAYOUTS[next];
  layout = next;
  win.setMinimumSize(1, 1);
  win.setMaximumSize(10000, 10000);
  win.setBounds(boundsFor(next, from), false);
  win.setMinimumSize(L.min[0], L.min[1]);
  if (L.max) win.setMaximumSize(L.max[0], L.max[1]);
  win.setMaximizable(next === 'app');
  win.setAlwaysOnTop(L.onTop, 'floating');
  win.setSkipTaskbar(!L.taskbar);
  if (!win.isVisible()) next === 'app' ? win.show() : win.showInactive();
  if (next === 'app') win.focus();
  win.webContents.send('layout', next);
  buildTrayMenu();
}

/* ---------- Start menu shortcut (needed on Windows for notifications to show) ---------- */
function ensureStartMenuShortcut() {
  // Store (MSIX) installs get their Start menu entry from Windows itself.
  if (process.platform !== 'win32' || !app.isPackaged || process.windowsStore) return;
  try {
    const lnk = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'BloomByte.lnk');
    const opts = { target: process.execPath, cwd: path.dirname(process.execPath), icon: process.execPath, iconIndex: 0, appUserModelId: APP_ID, description: 'BloomByte focus timer' };
    shell.writeShortcutLink(lnk, fs.existsSync(lnk) ? 'update' : 'create', opts);
  } catch (e) { console.error(e); }
}

function createWindow() {
  loadWinState();
  const b = boundsFor('app');
  const L = LAYOUTS.app;
  win = new BrowserWindow({
    ...b,
    minWidth: L.min[0], minHeight: L.min[1],
    frame: false,
    backgroundColor: '#F6F0DF',
    resizable: true,
    maximizable: true,
    minimizable: true,
    fullscreenable: false,
    hasShadow: true,
    show: false,
    title: 'BloomByte',
    icon: path.join(__dirname, 'src', 'assets', 'icon256.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
  win.once('ready-to-show', () => { win.show(); win.focus(); });
  win.on('moved', rememberBounds);
  win.on('resized', rememberBounds);
  win.on('maximize', () => win.webContents.send('maximized', true));
  win.on('unmaximize', () => win.webContents.send('maximized', false));
  win.on('close', (e) => { if (!quitting) { e.preventDefault(); requestClose(false); } });
}

// Closing quits, unless a session is running, in which case BloomByte keeps going in the tray.
function requestClose(busy) {
  if (busy) {
    win.hide();
    if (!trayHintShown && Notification.isSupported()) {
      trayHintShown = true;
      new Notification({ title: 'BloomByte is still running', body: 'Your session keeps going in the tray. Click the butterfly near the clock to open it.', silent: true }).show();
    }
  } else {
    quitting = true; app.quit();
  }
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Open BloomByte', click: () => applyLayout('app') },
    { label: 'Widget mode', click: () => applyLayout('widget') },
    { label: 'Corner pill', click: () => applyLayout('mini') },
    { type: 'separator' },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'src', 'assets', 'icon32.png')));
  tray.setToolTip('BloomByte');
  buildTrayMenu();
  tray.on('click', () => {
    if (win.isVisible() && !win.isMinimized()) { layout === 'app' ? win.focus() : win.showInactive(); }
    else { win.show(); if (win.isMinimized()) win.restore(); }
  });
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => { if (!win) return; if (win.isMinimized()) win.restore(); applyLayout('app'); });
  app.whenReady().then(() => {
    // Store builds already carry their package identity; only set our own ID for the classic installer.
    if (!process.windowsStore) app.setAppUserModelId(APP_ID);
    ensureStartMenuShortcut();
    createWindow();
    createTray();
  });
}

ipcMain.handle('data:load', () => readData());
ipcMain.handle('data:save', (_e, data) => writeData(data));
ipcMain.on('win:layout', (_e, l) => applyLayout(l));
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:maximize', () => { if (!win || layout !== 'app') return; win.isMaximized() ? win.unmaximize() : win.maximize(); });
ipcMain.on('win:close', (_e, busy) => requestClose(!!busy));
ipcMain.on('win:show', () => win && win.showInactive());
ipcMain.on('app:quit', () => { quitting = true; app.quit(); });

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());

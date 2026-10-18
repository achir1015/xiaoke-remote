'use strict';
const { app, BrowserWindow, ipcMain, desktopCapturer, screen, dialog, shell, clipboard, Tray, Menu, nativeImage, systemPreferences, Notification, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { FsGuard } = require('./fsguard');
const { InputInjector } = require('./input');

const APP_TITLE = '小柯機器人遠端連線';
const argv = process.argv.slice(1);
const argVal = (name) => { const a = argv.find((s) => s.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const PROFILE = argVal('profile');
const DRY_INPUT = argv.includes('--dry-input');

app.setName(APP_TITLE);
if (PROFILE) app.setPath('userData', path.join(app.getPath('appData'), 'xiaoke-remote-' + PROFILE.replace(/[^\w-]/g, '')));
else app.setPath('userData', path.join(app.getPath('appData'), 'xiaoke-remote'));

if (!PROFILE && !app.requestSingleInstanceLock()) { app.quit(); }

// ---------------- 設定 ----------------
const SETTINGS_FILE = () => path.join(app.getPath('userData'), 'settings.json');
function randomDeviceId() { return String(100000000 + crypto.randomInt(899999999)); }
function defaults() {
  return {
    deviceId: randomDeviceId(),
    deviceName: os.hostname(),
    server: { mode: 'public', host: '', port: 9000, path: '/', key: 'peerjs', secure: false },
    stun: 'stun:stun.l.google.com:19302\nstun:stun.cloudflare.com:3478',
    turn: { urls: '', username: '', credential: '' },
    codeMode: 'random', // random：每次連線結束更換；fixed：固定授權碼
    fixedCode: '',
    confirmIncoming: true,
    allowControl: true,
    swapMods: true,
    closeToTray: true,
    autoMinimize: true, // 被控端接受連線後自動縮小視窗，避免擋住畫面
    quality: 'auto', // auto | high | smooth
    folders: [],
    recent: [],
    devices: [], // 多台監看清單 [{id, code, name}]
  };
}
let settings = defaults();
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    settings = { ...defaults(), ...raw, server: { ...defaults().server, ...(raw.server || {}) }, turn: { ...defaults().turn, ...(raw.turn || {}) } };
  } catch { settings = defaults(); saveSettings(); }
}
function saveSettings() {
  fs.mkdirSync(path.dirname(SETTINGS_FILE()), { recursive: true });
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 2), 'utf8');
}

const guard = new FsGuard(() => settings.folders || []);
const injector = new InputInjector({ dryRun: DRY_INPUT });
let session_ = { remoteOs: null, active: false };

// ---------------- 視窗 ----------------
let win = null;
let tray = null;
let quitting = false;

function iconPath(name) {
  const p = path.join(__dirname, '..', '..', 'assets', name);
  return fs.existsSync(p) ? p : undefined;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 980, minHeight: 640,
    title: APP_TITLE + (PROFILE ? ` [${PROFILE}]` : ''),
    icon: iconPath('icon.png'),
    backgroundColor: '#0f172a',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // 被控端縮小視窗時仍需持續送畫面
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => { if (!argv.includes('--hidden')) win.show(); });
  win.on('close', (e) => {
    if (!quitting && settings.closeToTray && tray) {
      e.preventDefault();
      win.hide();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createTray() {
  const p = iconPath('tray.png') || iconPath('icon.png');
  if (!p) return;
  let img = nativeImage.createFromPath(p);
  img = img.resize({ width: process.platform === 'darwin' ? 18 : 16 });
  tray = new Tray(img);
  tray.setToolTip(APP_TITLE);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '顯示主視窗', click: () => { win.show(); win.focus(); } },
    { type: 'separator' },
    { label: '結束', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', () => { win.show(); win.focus(); });
}

app.on('second-instance', () => { if (win) { win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
app.on('before-quit', () => { quitting = true; injector.releaseAll(); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (win) win.show(); });

app.whenReady().then(() => {
  loadSettings();
  // 只允許本 App 自己需要的權限（麥克風、螢幕）
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(['media', 'display-capture', 'clipboard-sanitized-write', 'notifications', 'fullscreen'].includes(perm)));
  createWindow();
  createTray();
});

// ---------------- 檔案控制代碼 ----------------
const handles = new Map();
let nextHandle = 1;
function openHandle(abs, mode, extra = {}) {
  const fd = fs.openSync(mode === 'r' ? abs : abs + '.xkpart', mode === 'r' ? 'r' : 'w');
  const h = nextHandle++;
  handles.set(h, { fd, abs, mode, ...extra });
  return h;
}
function uniquePath(p) {
  if (!fs.existsSync(p) && !fs.existsSync(p + '.xkpart')) return p;
  const ext = path.extname(p);
  const base = p.slice(0, p.length - ext.length);
  for (let i = 1; i < 10000; i++) {
    const c = `${base} (${i})${ext}`;
    if (!fs.existsSync(c) && !fs.existsSync(c + '.xkpart')) return c;
  }
  throw new Error('無法建立檔名');
}

const incomingDir = () => path.join(app.getPath('downloads'), '小柯遠端接收');

// ---------------- 簡報轉 PDF ----------------
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 180000, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message || '').toString().trim()));
      else resolve(stdout);
    });
  });
}

async function convertToPdf(src) {
  const outDir = path.join(os.tmpdir(), 'xiaoke-remote');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, crypto.randomBytes(6).toString('hex') + '.pdf');
  const errors = [];
  if (process.platform === 'win32') {
    const ps = [
      '$ErrorActionPreference = "Stop"',
      '$pp = New-Object -ComObject PowerPoint.Application',
      '$p = $pp.Presentations.Open($env:XK_IN, -1, 0, 0)',
      '$p.SaveAs($env:XK_OUT, 32)',
      '$p.Close()',
      'if ($pp.Presentations.Count -eq 0) { $pp.Quit() }',
    ].join('; ');
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', ps], { env: { ...process.env, XK_IN: src, XK_OUT: out } });
      if (fs.existsSync(out)) return out;
    } catch (e) { errors.push('PowerPoint：' + e.message.split('\n')[0]); }
  }
  if (process.platform === 'darwin') {
    const script = [
      'on run argv',
      'set inFile to POSIX file (item 1 of argv)',
      'set outFile to POSIX file (item 2 of argv)',
      'tell application "Keynote"',
      'set d to open inFile',
      'export d to outFile as PDF',
      'close d saving no',
      'end tell',
      'end run',
    ];
    try {
      await run('osascript', [...script.flatMap((l) => ['-e', l]), src, out]);
      if (fs.existsSync(out)) return out;
    } catch (e) { errors.push('Keynote：' + e.message.split('\n')[0]); }
  }
  const soffice = process.platform === 'win32'
    ? ['C:\\Program Files\\LibreOffice\\program\\soffice.exe', 'C:\\Program Files (x86)\\LibreOffice\\program\\soffice.exe']
    : ['/Applications/LibreOffice.app/Contents/MacOS/soffice', '/usr/bin/soffice', '/usr/local/bin/soffice'];
  for (const s of soffice) {
    if (!fs.existsSync(s)) continue;
    try {
      await run(s, ['--headless', '--convert-to', 'pdf', '--outdir', outDir, src]);
      const produced = path.join(outDir, path.basename(src, path.extname(src)) + '.pdf');
      if (fs.existsSync(produced)) { fs.renameSync(produced, out); return out; }
    } catch (e) { errors.push('LibreOffice：' + e.message.split('\n')[0]); }
  }
  throw new Error('無法把簡報轉成 PDF。請安裝 PowerPoint（Windows）、Keynote（Mac）或 LibreOffice，或先另存為 PDF 再開啟。' + (errors.length ? '\n' + errors.join('\n') : ''));
}

// ---------------- IPC ----------------
const handle = (ch, fn) => ipcMain.handle(ch, async (e, ...a) => fn(...a));

handle('settings:get', () => settings);
handle('settings:set', (patch) => { settings = { ...settings, ...patch }; saveSettings(); return settings; });
handle('settings:newDeviceId', () => { settings.deviceId = randomDeviceId(); saveSettings(); return settings.deviceId; });

handle('sys:info', () => ({
  platform: process.platform,
  version: app.getVersion(),
  hostname: os.hostname(),
  profile: PROFILE,
  inputAvailable: injector.available || DRY_INPUT,
  inputError: injector.error,
  dryInput: DRY_INPUT,
}));

handle('sys:permissions', (prompt) => {
  if (process.platform !== 'darwin') return { screen: 'granted', accessibility: true, microphone: 'granted' };
  return {
    screen: systemPreferences.getMediaAccessStatus('screen'),
    microphone: systemPreferences.getMediaAccessStatus('microphone'),
    accessibility: systemPreferences.isTrustedAccessibilityClient(!!prompt),
  };
});
handle('sys:askMicrophone', async () => (process.platform === 'darwin' ? systemPreferences.askForMediaAccess('microphone') : true));
handle('sys:openPrivacy', (which) => {
  if (process.platform !== 'darwin') return;
  const map = { screen: 'Privacy_ScreenCapture', accessibility: 'Privacy_Accessibility', microphone: 'Privacy_Microphone' };
  shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${map[which] || ''}`);
});

handle('cap:sources', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
  const displays = screen.getAllDisplays();
  const primary = screen.getPrimaryDisplay();
  return sources.map((s, i) => {
    const d = displays.find((x) => String(x.id) === String(s.display_id)) || displays[i] || primary;
    return {
      id: s.id, name: s.name, displayId: String(d.id), primary: d.id === primary.id,
      width: d.bounds.width, height: d.bounds.height, scale: d.scaleFactor,
    };
  });
});
handle('cap:windows', async () => {
  const sources = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 180 } });
  return sources.filter((s) => !s.name.includes(APP_TITLE)).map((s) => ({ id: s.id, name: s.name, thumb: s.thumbnail.toDataURL() }));
});
handle('cap:screenshot', async (displayId) => {
  const displays = screen.getAllDisplays();
  const d = displays.find((x) => String(x.id) === String(displayId)) || screen.getPrimaryDisplay();
  const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
  const s = sources.find((x) => String(x.display_id) === String(d.id)) || sources[0];
  if (!s) throw new Error('無法擷取畫面');
  return new Uint8Array(s.thumbnail.toPNG());
});

// 遠端輸入（高頻，用 send 不等回應）
ipcMain.on('input:event', (e, ev) => {
  if (!session_.active || !settings.allowControl) return;
  injector.handle(ev, session_.remoteOs, settings.swapMods);
});
handle('input:session', (s) => {
  session_ = { remoteOs: s ? s.remoteOs : null, active: !!s };
  if (!s) injector.releaseAll();
  return true;
});
handle('input:setDisplay', (id) => injector.setDisplay(id));
handle('input:log', () => injector.log.slice(-200));

// ---- 被控端：授權資料夾的遠端檔案操作 ----
handle('fs:roots', () => guard.publicRoots());
handle('fs:list', (id, rel) => guard.list(id, rel));
handle('fs:openRead', (id, rel) => {
  const { abs } = guard.resolve(id, rel, 'r');
  const st = fs.statSync(abs);
  if (!st.isFile()) throw new Error('不是檔案');
  return { h: openHandle(abs, 'r'), size: st.size, name: path.basename(abs) };
});
handle('fs:openWrite', (id, dirRel, name) => {
  const target = uniquePath(guard.resolveNew(id, dirRel, name));
  return { h: openHandle(target, 'w'), name: path.basename(target) };
});
handle('fs:mkdir', (id, dirRel, name) => { const t = guard.resolveNew(id, dirRel, name); fs.mkdirSync(t); return true; });
handle('fs:delete', (id, rel) => {
  const r = guard.resolve(id, rel, 'w');
  if (r.isRoot) throw new Error('不能刪除授權資料夾本身');
  fs.rmSync(r.abs, { recursive: true, force: false });
  return true;
});
handle('fs:run', async (id, rel, who) => {
  const { abs } = guard.resolve(id, rel, 'r');
  if (!fs.statSync(abs).isFile()) throw new Error('不是檔案');
  if (win) { win.show(); win.focus(); }
  const r = await dialog.showMessageBox(win, {
    type: 'warning', buttons: ['允許執行', '拒絕'], defaultId: 1, cancelId: 1,
    title: '遠端要求執行程式',
    message: `${who || '主控端'} 要求在這台電腦執行：`,
    detail: abs + '\n\n請確認這是你信任的安裝程式。',
  });
  if (r.response !== 0) throw new Error('被控端拒絕執行');
  const err = await shell.openPath(abs);
  if (err) throw new Error(err);
  return true;
});

// ---- 通用讀寫 ----
handle('io:read', (h, offset, len) => {
  const x = handles.get(h);
  if (!x || x.mode !== 'r') throw new Error('檔案代碼無效');
  const buf = Buffer.allocUnsafe(len);
  const n = fs.readSync(x.fd, buf, 0, len, offset);
  return new Uint8Array(buf.buffer, buf.byteOffset, n);
});
handle('io:write', (h, data) => {
  const x = handles.get(h);
  if (!x || x.mode !== 'w') throw new Error('檔案代碼無效');
  fs.writeSync(x.fd, Buffer.from(data));
  return true;
});
handle('io:close', (h, ok) => {
  const x = handles.get(h);
  if (!x) return null;
  handles.delete(h);
  fs.closeSync(x.fd);
  if (x.mode === 'w') {
    if (ok) { fs.renameSync(x.abs + '.xkpart', x.abs); return x.abs; }
    try { fs.unlinkSync(x.abs + '.xkpart'); } catch {}
  }
  return null;
});

// ---- 本機檔案 ----
handle('local:pickFiles', async (opts = {}) => {
  const r = await dialog.showOpenDialog(win, { properties: ['openFile', ...(opts.multi ? ['multiSelections'] : [])], filters: opts.filters });
  return r.canceled ? [] : r.filePaths;
});
handle('local:pickFolder', async () => {
  const r = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
handle('local:openRead', (p) => {
  const st = fs.statSync(p);
  if (!st.isFile()) throw new Error('不是檔案');
  return { h: openHandle(p, 'r'), size: st.size, name: path.basename(p) };
});
handle('local:readAll', (p) => new Uint8Array(fs.readFileSync(p)));
handle('local:saveTo', async (name) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), name) });
  if (r.canceled) return null;
  return { h: openHandle(r.filePath, 'w'), path: r.filePath };
});
handle('local:openIncoming', (name) => {
  const safe = String(name).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200) || 'file';
  fs.mkdirSync(incomingDir(), { recursive: true });
  const p = uniquePath(path.join(incomingDir(), safe));
  return { h: openHandle(p, 'w'), path: p };
});
handle('folders:installArea', () => {
  const p = path.join(app.getPath('downloads'), '小柯遠端安裝區');
  fs.mkdirSync(p, { recursive: true });
  return p;
});
handle('local:reveal', (p) => shell.showItemInFolder(p));
handle('local:open', (p) => shell.openPath(p));

// ---- 線上教學 ----
handle('teach:prepare', async (paths) => {
  if (!paths || !paths.length) return null;
  const ext = path.extname(paths[0]).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext)) {
    return { kind: 'images', name: path.basename(paths[0]), items: paths.map((p) => ({ name: path.basename(p), data: new Uint8Array(fs.readFileSync(p)) })) };
  }
  let pdf = paths[0];
  if (ext !== '.pdf') pdf = await convertToPdf(paths[0]);
  return { kind: 'pdf', name: path.basename(paths[0]), data: new Uint8Array(fs.readFileSync(pdf)) };
});

// ---- 視窗與其他 ----
function bringUp() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
}
handle('win:fullscreen', (on) => { if (win) { if (on) bringUp(); win.setFullScreen(!!on); } });
handle('win:minimize', () => { if (win && !win.isFullScreen()) win.minimize(); });
handle('win:restore', () => bringUp());
handle('win:attention', (title, body) => {
  if (!win) return;
  bringUp(); // 被控端連線後會自動縮小，有聊天、檔案、語音邀請時再自動開啟
  if (!win.isFocused()) win.flashFrame(true);
  if (title && Notification.isSupported() && !win.isFocused()) new Notification({ title, body: body || '' }).show();
});
handle('clip:read', () => clipboard.readText());
handle('clip:write', (t) => { clipboard.writeText(String(t || '')); return true; });
handle('app:openExternal', (url) => { if (/^https:\/\//.test(url)) shell.openExternal(url); });

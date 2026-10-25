// 線上版（瀏覽器）適配層：提供與桌面版主程序相同的 window.xk API。
// 桌面版由 preload 先定義 window.xk，這裡就不會執行。
(function () {
  'use strict';
  if (window.xk) return;

  const VERSION = '__XK_VERSION__';
  const KEY = 'xkr-settings';
  const ua = navigator.userAgent;
  const platform = /Mac|iPhone|iPad/.test(navigator.platform || ua) ? 'darwin' : /Win/.test(navigator.platform || ua) ? 'win32' : 'linux';
  const OSN = { darwin: 'Mac', win32: 'Windows', linux: 'Linux' }[platform];
  const err = (m) => { throw new Error(m); };
  const randomId = () => String(100000000 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 4294967296 * 899999999));

  // ---------------- 設定（localStorage） ----------------
  function defaults() {
    return {
      deviceId: randomId(),
      deviceName: `線上版（${OSN}）`,
      server: { mode: 'public', host: '', port: 9000, path: '/', key: 'peerjs', secure: false },
      stun: 'stun:stun.l.google.com:19302\nstun:stun.cloudflare.com:3478',
      turn: { urls: '', username: '', credential: '' },
      codeMode: 'random', fixedCode: '',
      confirmIncoming: true, allowControl: false, swapMods: true, closeToTray: false, autoMinimize: false,
      quality: 'auto', folders: [], recent: [], devices: [],
    };
  }
  let settings;
  function load() {
    let raw = {};
    try { raw = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
    const d = defaults();
    settings = { ...d, ...raw, server: { ...d.server, ...(raw.server || {}) }, turn: { ...d.turn, ...(raw.turn || {}) } };
    // 瀏覽器限制：分享畫面必須由使用者按一下，且網頁無法控制系統的滑鼠鍵盤
    settings.confirmIncoming = true;
    settings.allowControl = false;
    save();
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch {} }
  load();

  // ---------------- 本機檔案代碼 ----------------
  // 桌面版傳的是檔案路徑；線上版改用代碼字串對應到 File 物件
  const files = new Map();
  let seq = 0;
  const reg = (file) => { const t = `file:${++seq}:${file.name}`; files.set(t, file); return t; };
  const fileOf = (t) => files.get(t) || err('找不到檔案（請重新選擇）');

  function pickFiles(opts = {}) {
    return new Promise((resolve) => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.multiple = !!opts.multi;
      if (opts.filters && opts.filters.length) inp.accept = opts.filters.flatMap((f) => f.extensions.map((e) => '.' + e)).join(',');
      inp.style.display = 'none';
      document.body.append(inp);
      inp.addEventListener('change', () => { resolve([...inp.files].map(reg)); inp.remove(); });
      inp.addEventListener('cancel', () => { resolve([]); inp.remove(); });
      inp.click();
    });
  }

  const handles = new Map();
  let hseq = 0;
  const newH = (o) => { const h = ++hseq; handles.set(h, o); return h; };
  const urls = new Map();

  function download(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
    const t = `dl:${++seq}:${name}`;
    urls.set(t, url);
    return t;
  }

  // ---------------- 資料夾授權（File System Access API，Chrome / Edge） ----------------
  const dirs = new Map(); // 代碼 → FileSystemDirectoryHandle
  let idb = null;
  function db() {
    if (idb) return idb;
    idb = new Promise((resolve, reject) => {
      const r = indexedDB.open('xkr', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('dirs');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    return idb;
  }
  async function idbDo(mode, fn) {
    const d = await db();
    return new Promise((resolve, reject) => {
      const tx = d.transaction('dirs', mode);
      const req = fn(tx.objectStore('dirs'));
      tx.oncomplete = () => resolve(req && req.result);
      tx.onerror = () => reject(tx.error);
    });
  }
  const dirsReady = (async () => {
    try {
      const keys = await idbDo('readonly', (s) => s.getAllKeys());
      for (const k of keys || []) dirs.set(k, await idbDo('readonly', (s) => s.get(k)));
    } catch {}
  })();
  async function addDir(handle, perm) {
    const t = 'dir:' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    dirs.set(t, handle);
    try { await idbDo('readwrite', (s) => s.put(handle, t)); } catch {}
    return t;
  }
  const modeOf = (perm) => (perm === 'r' ? 'read' : 'readwrite');
  async function granted(t, perm) {
    const hd = dirs.get(t);
    if (!hd) return false;
    if (!hd.queryPermission) return true;
    return (await hd.queryPermission({ mode: modeOf(perm) })) === 'granted';
  }

  const canRead = (p) => p === 'r' || p === 'rw';
  const canWrite = (p) => p === 'w' || p === 'rw';
  function roots() { return (settings.folders || []).filter((f) => dirs.has(f.path)).map((f) => ({ id: f.path, name: f.name || '資料夾', perm: f.perm })); }
  const segs = (rel) => {
    const s = String(rel || '').replace(/\\/g, '/').split('/').filter(Boolean);
    if (s.some((x) => x === '..' || x === '.' || x.includes(':'))) err('路徑不合法');
    return s;
  };
  const validName = (n) => { if (!n || /[\\/:*?"<>|]/.test(n) || n === '.' || n === '..') err('檔名不合法'); return n; };
  async function rootOf(id, need) {
    await dirsReady;
    const r = roots().find((x) => x.id === id) || err('此資料夾未授權');
    if (need === 'r' && !canRead(r.perm)) err('此資料夾沒有「讀取」權限');
    if (need === 'w' && !canWrite(r.perm)) err('此資料夾沒有「寫入」權限');
    if (!(await granted(id, r.perm))) err(`被控端需要在網頁的「資料夾授權」頁按「重新允許」才能存取「${r.name}」`);
    return r;
  }
  async function dirAt(id, rel, need) {
    const r = await rootOf(id, need);
    let d = dirs.get(id);
    for (const s of segs(rel)) d = await d.getDirectoryHandle(s);
    return { r, d };
  }
  async function parentOf(id, rel, need) {
    const s = segs(rel);
    if (!s.length) err('不能操作授權資料夾本身');
    const { r, d } = await dirAt(id, s.slice(0, -1).join('/'), need);
    return { r, d, name: s[s.length - 1] };
  }
  async function exists(d, name) {
    try { await d.getFileHandle(name); return true; } catch {}
    try { await d.getDirectoryHandle(name); return true; } catch {}
    return false;
  }

  const fsApi = {
    roots: async () => { await dirsReady; return roots(); },
    list: async (id, rel) => {
      const { r, d } = await dirAt(id, rel, null);
      const entries = [];
      for await (const [name, hd] of d.entries()) {
        const dir = hd.kind === 'directory';
        if (!dir && !canRead(r.perm)) continue;
        let size = 0, mtime = 0;
        if (!dir) { try { const f = await hd.getFile(); size = f.size; mtime = f.lastModified; } catch { continue; } }
        entries.push({ name, dir, size, mtime });
      }
      entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hant'));
      return { perm: r.perm, entries };
    },
    openRead: async (id, rel) => {
      const { d, name } = await parentOf(id, rel, 'r');
      const f = await (await d.getFileHandle(name)).getFile();
      return { h: newH({ blob: f }), size: f.size, name: f.name };
    },
    openWrite: async (id, dirRel, name) => {
      const { d } = await dirAt(id, dirRel, 'w');
      validName(name);
      let final = name;
      const dot = name.lastIndexOf('.');
      const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
      for (let i = 1; await exists(d, final); i++) final = `${base} (${i})${ext}`;
      const fh = await d.getFileHandle(final, { create: true });
      const w = await fh.createWritable();
      return { h: newH({ w, dir: d, name: final }), name: final };
    },
    mkdir: async (id, dirRel, name) => { const { d } = await dirAt(id, dirRel, 'w'); await d.getDirectoryHandle(validName(name), { create: true }); return true; },
    delete: async (id, rel) => { const { d, name } = await parentOf(id, rel, 'w'); await d.removeEntry(name, { recursive: true }); return true; },
    run: async () => err('線上版（瀏覽器）無法在被控端執行程式，請改用桌面版'),
    // 線上版專用
    supported: () => !!window.showDirectoryPicker,
    needsPermission: async (t) => { await dirsReady; const f = (settings.folders || []).find((x) => x.path === t); return !!f && dirs.has(t) && !(await granted(t, f.perm)); },
    grant: async (t) => { const f = (settings.folders || []).find((x) => x.path === t); const hd = dirs.get(t); if (!f || !hd) return false; return (await hd.requestPermission({ mode: modeOf(f.perm) })) === 'granted'; },
    forget: async (t) => { dirs.delete(t); try { await idbDo('readwrite', (s) => s.delete(t)); } catch {} },
    _addHandle: async (handle, perm, name) => { const t = await addDir(handle, perm); return { path: t, perm, name: name || handle.name }; }, // 自動化測試用
  };

  const io = {
    read: async (h, off, len) => { const x = handles.get(h) || err('檔案代碼無效'); return new Uint8Array(await x.blob.slice(off, off + len).arrayBuffer()); },
    write: async (h, data) => {
      const x = handles.get(h) || err('檔案代碼無效');
      if (x.w) await x.w.write(data); else x.chunks.push(new Uint8Array(data).slice());
      return true;
    },
    close: async (h, ok) => {
      const x = handles.get(h);
      if (!x) return null;
      handles.delete(h);
      if (x.w) {
        if (ok) { await x.w.close(); return x.name; }
        try { await x.w.abort(); } catch {}
        if (x.dir) { try { await x.dir.removeEntry(x.name); } catch {} }
        return null;
      }
      if (x.chunks) return ok ? download(new Blob(x.chunks), x.name) : null;
      return null;
    },
  };

  // ---------------- 擷取畫面 ----------------
  let current = null; // 被控端目前分享中的畫面
  async function displayStream(quality) {
    const s = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: quality === 'high' ? 20 : 30 }, width: { max: 2560 }, height: { max: 1600 } },
      audio: false, selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include', surfaceSwitching: 'include',
    });
    const t = s.getVideoTracks()[0];
    t.contentHint = quality === 'smooth' ? 'motion' : 'detail';
    current = s;
    t.addEventListener('ended', () => { if (current === s) current = null; });
    return s;
  }
  async function frameOf(stream) {
    const v = document.createElement('video');
    v.muted = true; v.srcObject = stream;
    await v.play();
    await new Promise((r) => (v.videoWidth ? r() : v.addEventListener('loadedmetadata', r, { once: true })));
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    v.srcObject = null;
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    return new Uint8Array(await blob.arrayBuffer());
  }

  let flashTimer = null;
  const title0 = document.title;
  function flashTitle(text) {
    if (!document.hidden) return;
    clearInterval(flashTimer);
    let on = false;
    flashTimer = setInterval(() => { document.title = (on = !on) ? '💬 ' + text : title0; }, 1000);
    document.addEventListener('visibilitychange', () => { clearInterval(flashTimer); document.title = title0; }, { once: true });
  }

  window.xk = {
    web: true,
    settings: {
      get: async () => settings,
      set: async (patch) => { settings = { ...settings, ...patch, confirmIncoming: true, allowControl: false }; save(); return settings; },
      newDeviceId: async () => { settings.deviceId = randomId(); save(); return settings.deviceId; },
    },
    sys: {
      info: async () => ({ platform, version: VERSION, hostname: settings.deviceName, profile: null, inputAvailable: false, inputError: '線上版不支援', dryInput: false, web: true }),
      permissions: async () => ({ screen: 'granted', accessibility: true, microphone: 'granted' }),
      askMicrophone: async () => true,
      openPrivacy: async () => {},
    },
    cap: {
      sources: async () => [{ id: 'web', name: '瀏覽器分享的畫面', displayId: 'web', primary: true, width: screen.width, height: screen.height, scale: devicePixelRatio || 1 }],
      displayStream,
      windows: async () => [],
      screenshot: async () => {
        if (current && current.active) return frameOf(current);
        const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        try { return await frameOf(s); } finally { s.getTracks().forEach((t) => t.stop()); }
      },
    },
    input: { event: () => {}, session: async () => true, setDisplay: async () => {}, log: async () => [] },
    fs: fsApi,
    io,
    local: {
      pickFiles,
      pickFolder: async () => {
        if (!window.showDirectoryPicker) err('這個瀏覽器不支援資料夾授權，請改用 Chrome 或 Edge（或使用桌面版）');
        let hd;
        try { hd = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch (e) { if (e.name === 'AbortError') return null; throw e; }
        const t = await addDir(hd);
        names.set(t, hd.name);
        return t;
      },
      folderLabel: async (t) => names.get(t) || (dirs.get(t) && dirs.get(t).name) || '資料夾',
      openRead: async (t) => { const f = fileOf(t); return { h: newH({ blob: f }), size: f.size, name: f.name }; },
      readAll: async (t) => new Uint8Array(await fileOf(t).arrayBuffer()),
      saveTo: async (name) => {
        if (window.showSaveFilePicker) {
          try {
            const fh = await window.showSaveFilePicker({ suggestedName: name });
            return { h: newH({ w: await fh.createWritable(), name: fh.name }), path: fh.name };
          } catch (e) { if (e.name === 'AbortError') return null; }
        }
        return { h: newH({ chunks: [], name }), path: name };
      },
      openIncoming: async (name) => ({ h: newH({ chunks: [], name: String(name).replace(/[\\/:*?"<>|]/g, '_') || 'file' }), path: name }),
      reveal: async () => {},
      open: async (t) => { const u = urls.get(t); if (u) window.open(u, '_blank'); },
    },
    teach: {
      prepare: async (tokens) => {
        if (!tokens || !tokens.length) return null;
        const fs0 = tokens.map(fileOf);
        const ext = fs0[0].name.split('.').pop().toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'].includes(ext)) return { kind: 'images', name: fs0[0].name, items: await Promise.all(fs0.map(async (f) => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))) };
        if (ext !== 'pdf') err('線上版無法轉換 PowerPoint／Keynote，請先在簡報軟體「另存為 PDF」再開啟（桌面版可自動轉檔）');
        return { kind: 'pdf', name: fs0[0].name, data: new Uint8Array(await fs0[0].arrayBuffer()) };
      },
    },
    folders: { installArea: async () => err('線上版不支援') },
    win: {
      fullscreen: async (on) => {
        try {
          if (on && !document.fullscreenElement) { await document.documentElement.requestFullscreen(); if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {}); }
          if (!on && document.fullscreenElement) await document.exitFullscreen();
        } catch {}
      },
      attention: async (title, body) => {
        flashTitle(title || '');
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification(title || '', { body: body || '' });
      },
      minimize: async () => {},
      restore: async () => {},
    },
    clip: {
      read: async () => { try { return await navigator.clipboard.readText(); } catch { return ''; } },
      write: async (t) => { try { await navigator.clipboard.writeText(String(t || '')); } catch {} return true; },
    },
    openExternal: async (u) => { if (/^https:\/\//.test(u)) window.open(u, '_blank'); },
    pathOf: (file) => reg(file),
  };
  const names = new Map();
})();

'use strict';
// 被控端資料夾授權：所有遠端檔案操作都必須經過這裡檢查。
// perm: 'r' 可讀（列出、下載、執行安裝檔）、'w' 可寫（上傳、建立資料夾、刪除；只看得到子資料夾）、'rw' 可讀寫。
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PERMS = ['r', 'w', 'rw'];

function rootId(p) {
  return crypto.createHash('sha1').update(path.resolve(p).toLowerCase()).digest('hex').slice(0, 10);
}

function canRead(perm) { return perm === 'r' || perm === 'rw'; }
function canWrite(perm) { return perm === 'w' || perm === 'rw'; }

function sameOrInside(child, parent) {
  const norm = (s) => (process.platform === 'win32' || process.platform === 'darwin') ? s.toLowerCase() : s;
  const c = norm(path.resolve(child));
  const p = norm(path.resolve(parent));
  if (c === p) return true;
  const withSep = p.endsWith(path.sep) ? p : p + path.sep;
  return c.startsWith(withSep);
}

class FsGuard {
  constructor(getFolders) {
    this.getFolders = getFolders; // () => [{path, perm, name?}]
  }

  roots() {
    return this.getFolders()
      .filter((f) => f && f.path && PERMS.includes(f.perm))
      .map((f) => ({ id: rootId(f.path), name: f.name || path.basename(f.path) || f.path, path: f.path, perm: f.perm }));
  }

  publicRoots() {
    return this.roots().map(({ id, name, perm }) => ({ id, name, perm }));
  }

  // 將（授權根目錄 id、相對路徑）轉成實際路徑，並確認沒有跳出授權範圍（含 .. 與符號連結）。
  resolve(id, rel, need) {
    const root = this.roots().find((r) => r.id === id);
    if (!root) throw new Error('此資料夾未授權');
    if (need === 'r' && !canRead(root.perm)) throw new Error('此資料夾沒有「讀取」權限');
    if (need === 'w' && !canWrite(root.perm)) throw new Error('此資料夾沒有「寫入」權限');
    rel = String(rel || '').replace(/\\/g, '/');
    if (rel.split('/').some((seg) => seg === '..') || rel.includes(':') || rel.includes('\0') || rel.startsWith('/')) throw new Error('路徑不合法');
    const base = path.resolve(root.path);
    const target = path.resolve(base, '.' + path.sep + rel);
    if (!sameOrInside(target, base)) throw new Error('路徑超出授權範圍');
    // 已存在的路徑：用真實路徑再檢查一次，防止符號連結/捷徑跳出
    let realBase = base;
    try { realBase = fs.realpathSync(base); } catch { throw new Error('授權資料夾不存在'); }
    let probe = target;
    while (!fs.existsSync(probe) && probe !== path.dirname(probe)) probe = path.dirname(probe);
    const realProbe = fs.realpathSync(probe);
    if (!sameOrInside(realProbe, realBase)) throw new Error('路徑超出授權範圍');
    return { root, abs: target, isRoot: path.resolve(target) === base };
  }

  list(id, rel) {
    const root = this.roots().find((r) => r.id === id);
    if (!root) throw new Error('此資料夾未授權');
    const { abs } = this.resolve(id, rel, null);
    const entries = [];
    for (const d of fs.readdirSync(abs, { withFileTypes: true })) {
      if (d.isSymbolicLink()) continue;
      const isDir = d.isDirectory();
      if (!isDir && !canRead(root.perm)) continue; // 只可寫：看不到檔案
      let size = 0, mtime = 0;
      try { const st = fs.statSync(path.join(abs, d.name)); size = st.size; mtime = st.mtimeMs; } catch { continue; }
      entries.push({ name: d.name, dir: isDir, size: isDir ? 0 : size, mtime });
    }
    entries.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, 'zh-Hant'));
    return { perm: root.perm, entries };
  }

  // 寫入用：父資料夾必須在範圍內、檔名不可含路徑字元
  resolveNew(id, dirRel, name) {
    if (!name || /[\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new Error('檔名不合法');
    const dir = this.resolve(id, dirRel, 'w');
    const target = path.join(dir.abs, name);
    if (!sameOrInside(target, dir.root.path)) throw new Error('路徑超出授權範圍');
    return target;
  }
}

module.exports = { FsGuard, rootId, canRead, canWrite, sameOrInside, PERMS };

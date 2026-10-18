// 檔案上傳下載：主控端的檔案總管 ＋ 被控端的授權檢查服務
import { h, fmtBytes, toast, modal, errMsg } from './util.js';

const xk = window.xk;
const PERM_TEXT = { r: '可讀', w: '可寫', rw: '可讀寫' };
const canRead = (p) => p === 'r' || p === 'rw';
const canWrite = (p) => p === 'w' || p === 'rw';
const join = (a, b) => (a ? a + '/' + b : b);

// ---------- 被控端 ----------
export function serveHostFiles(ch, log, remoteName) {
  ch.serve('fs-roots', () => xk.fs.roots());
  ch.serve('fs-list', (id, rel) => xk.fs.list(id, rel));
  ch.serve('fs-mkdir', async (id, dir, name) => { await xk.fs.mkdir(id, dir, name); log(`建立資料夾 ${join(dir, name)}`); return true; });
  ch.serve('fs-delete', async (id, rel) => { await xk.fs.delete(id, rel); log(`刪除 ${rel}`); return true; });
  ch.serve('fs-run', async (id, rel) => { log(`要求執行 ${rel}`); await xk.fs.run(id, rel, remoteName()); log(`已執行 ${rel}`); return true; });
  ch.serve('fs-download', async (id, rel, xid) => {
    const f = await xk.fs.openRead(id, rel);
    log(`對方下載 ${rel}（${fmtBytes(f.size)}）`);
    ch.streamOut(xid, f.size, (off, len) => xk.io.read(f.h, off, len)).catch(() => {}).finally(() => xk.io.close(f.h, false));
    return { size: f.size, name: f.name };
  });
  ch.serve('fs-upload', async (id, dir, name, size, xid) => {
    const w = await xk.fs.openWrite(id, dir, name);
    log(`對方上傳 ${join(dir, w.name)}（${fmtBytes(size)}）`);
    ch.expect(xid, (d) => xk.io.write(w.h, new Uint8Array(d)))
      .then(async () => { await xk.io.close(w.h, true); ch.sendF({ t: 'fs-upload-done', xid, ok: true, name: w.name }); log(`上傳完成 ${join(dir, w.name)}`); })
      .catch(async (e) => { await xk.io.close(w.h, false); ch.sendF({ t: 'fs-upload-done', xid, ok: false, e: errMsg(e) }); });
    return { name: w.name };
  });
}

// ---------- 主控端 ----------
export class FileManager {
  constructor(root) {
    this.root = root;
    this.ch = null;
    this.rootInfo = null; // {id,name,perm}
    this.dir = '';
    this.entries = [];
    this.sel = new Set();
    this.uploadWaits = new Map();
    root.innerHTML = '';
    this.crumbs = h('div', { class: 'crumbs' });
    this.b = {
      up: h('button', { onclick: () => this.goUp(), title: '上一層' }, '⬆'),
      refresh: h('button', { onclick: () => this.refresh(), title: '重新整理' }, '🔄'),
      download: h('button', { onclick: () => this.download() }, '⬇ 下載'),
      upload: h('button', { onclick: () => this.upload() }, '⤒ 上傳'),
      mkdir: h('button', { onclick: () => this.mkdir() }, '📁 新資料夾'),
      del: h('button', { onclick: () => this.del() }, '🗑 刪除'),
      run: h('button', { onclick: () => this.run(), title: '在被控端執行安裝程式（對方需按允許）' }, '▶ 執行安裝'),
    };
    this.list = h('div', { class: 'list' });
    this.xfers = h('div', { class: 'xfers' });
    root.append(h('div', { class: 'fm' }, this.crumbs, h('div', { class: 'ftools' }, ...Object.values(this.b)), this.list, this.xfers));
    // 拖曳本機檔案進來 = 上傳
    this.list.addEventListener('dragover', (e) => { e.preventDefault(); });
    this.list.addEventListener('drop', (e) => {
      e.preventDefault();
      const paths = [...e.dataTransfer.files].map((f) => xk.pathOf(f)).filter(Boolean);
      if (paths.length) this.uploadPaths(paths);
    });
  }

  attach(ch) {
    this.ch = ch;
    ch.on('fs-upload-done', (m) => { const w = this.uploadWaits.get(m.xid); if (w) { this.uploadWaits.delete(m.xid); m.ok ? w.resolve(m.name) : w.reject(new Error(m.e)); } });
    this.showRoots();
  }

  updateTools() {
    const p = this.rootInfo ? this.rootInfo.perm : null;
    const selFiles = this.selected().filter((e) => !e.dir);
    this.b.up.disabled = !this.rootInfo;
    this.b.download.disabled = !p || !canRead(p) || !selFiles.length;
    this.b.upload.disabled = !p || !canWrite(p);
    this.b.mkdir.disabled = !p || !canWrite(p);
    this.b.del.disabled = !p || !canWrite(p) || !this.sel.size;
    this.b.run.disabled = !p || !canRead(p) || selFiles.length !== 1;
  }

  selected() { return this.entries.filter((e) => this.sel.has(e.name)); }

  renderCrumbs() {
    this.crumbs.innerHTML = '';
    this.crumbs.append(h('a', { onclick: () => this.showRoots() }, '🖥 被控端授權資料夾'));
    if (!this.rootInfo) return;
    this.crumbs.append(' › ', h('a', { onclick: () => this.open('') }, this.rootInfo.name), ' ', h('span', { class: 'perm ' + this.rootInfo.perm }, PERM_TEXT[this.rootInfo.perm]));
    let acc = '';
    for (const seg of this.dir.split('/').filter(Boolean)) {
      acc = join(acc, seg);
      const target = acc;
      this.crumbs.append(' › ', h('a', { onclick: () => this.open(target) }, seg));
    }
  }

  async showRoots() {
    this.rootInfo = null; this.dir = ''; this.sel.clear(); this.entries = [];
    this.renderCrumbs(); this.updateTools();
    this.list.innerHTML = '';
    try {
      const roots = await this.ch.request('fs-roots');
      if (!roots.length) { this.list.append(h('div', { class: 'empty' }, '被控端尚未授權任何資料夾。\n請對方在「資料夾授權」頁新增。')); return; }
      for (const r of roots) {
        this.list.append(h('div', { class: 'item', ondblclick: () => { this.rootInfo = r; this.open(''); }, onclick: () => { this.rootInfo = r; this.open(''); } },
          h('span', {}, '📂'), h('span', { class: 'nm' }, r.name), h('span', { class: 'perm ' + r.perm }, PERM_TEXT[r.perm])));
      }
    } catch (e) { this.list.append(h('div', { class: 'empty' }, '讀取失敗：' + errMsg(e))); }
  }

  async open(dir) {
    this.dir = dir; this.sel.clear();
    this.renderCrumbs();
    this.list.innerHTML = '';
    this.list.append(h('div', { class: 'empty' }, '讀取中…'));
    try {
      const r = await this.ch.request('fs-list', [this.rootInfo.id, dir]);
      this.entries = r.entries;
      this.renderList();
    } catch (e) { this.list.innerHTML = ''; this.list.append(h('div', { class: 'empty' }, '讀取失敗：' + errMsg(e))); }
    this.updateTools();
  }

  renderList() {
    this.list.innerHTML = '';
    if (!this.entries.length) this.list.append(h('div', { class: 'empty' }, canRead(this.rootInfo.perm) ? '（空資料夾）' : '（只可寫：看不到檔案，可直接上傳）'));
    for (const e of this.entries) {
      const row = h('div', { class: 'item' + (this.sel.has(e.name) ? ' sel' : '') },
        h('span', {}, e.dir ? '📁' : '📄'), h('span', { class: 'nm' }, e.name), h('span', { class: 'sz' }, e.dir ? '' : fmtBytes(e.size)));
      row.addEventListener('click', (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) this.sel.clear();
        this.sel.has(e.name) ? this.sel.delete(e.name) : this.sel.add(e.name);
        this.renderList(); this.updateTools();
      });
      row.addEventListener('dblclick', () => { if (e.dir) this.open(join(this.dir, e.name)); else if (canRead(this.rootInfo.perm)) this.download([e]); });
      this.list.append(row);
    }
  }

  goUp() { if (!this.rootInfo) return; if (!this.dir) return this.showRoots(); this.open(this.dir.split('/').slice(0, -1).join('/')); }
  refresh() { this.rootInfo ? this.open(this.dir) : this.showRoots(); }

  xferRow(name, dirText, size) {
    const bar = h('i'); const st = h('span', {}, '準備中');
    const cancel = h('button', { class: 'icon', title: '取消' }, '✖');
    const el = h('div', { class: 'xfer' }, h('div', { class: 'top' }, h('span', {}, `${dirText} ${name}`), h('span', {}, st, cancel)), h('div', { class: 'prog' }, bar));
    this.xfers.prepend(el);
    const t0 = Date.now();
    return {
      cancel, el,
      prog: (n) => { bar.style.width = (100 * n / (size || 1)) + '%'; const s = n / Math.max(0.2, (Date.now() - t0) / 1000); st.textContent = `${fmtBytes(n)} / ${fmtBytes(size)} · ${fmtBytes(s)}/s`; },
      done: (txt) => { bar.style.width = '100%'; st.textContent = txt; cancel.remove(); },
      fail: (e) => { st.textContent = ''; st.append(h('span', { class: 'err' }, '失敗：' + errMsg(e))); cancel.remove(); },
    };
  }

  async download(list) {
    list = list || this.selected().filter((e) => !e.dir);
    for (const e of list) {
      const save = await xk.local.saveTo(e.name);
      if (!save) continue;
      const xid = this.ch.newXid('d');
      const row = this.xferRow(e.name, '⬇', e.size);
      row.cancel.onclick = () => this.ch.cancel(xid);
      const done = this.ch.expect(xid, (d) => xk.io.write(save.h, new Uint8Array(d)), row.prog);
      try {
        await this.ch.request('fs-download', [this.rootInfo.id, join(this.dir, e.name), xid]);
        await done;
        const p = await xk.io.close(save.h, true);
        row.done('✅ 完成');
        row.el.querySelector('.top span').append(' ', h('a', { href: '#', onclick: (ev) => { ev.preventDefault(); xk.local.reveal(p); } }, '顯示'));
      } catch (err) { this.ch.sinks.delete(xid); await xk.io.close(save.h, false); row.fail(err); }
    }
  }

  async upload() { const ps = await xk.local.pickFiles({ multi: true }); if (ps.length) this.uploadPaths(ps); }

  async uploadPaths(paths) {
    if (!this.rootInfo || !canWrite(this.rootInfo.perm)) return toast('請先進入「可寫」的授權資料夾', 'err');
    const rootId = this.rootInfo.id, dir = this.dir;
    for (const p of paths) {
      let f;
      try { f = await xk.local.openRead(p); } catch (e) { toast(errMsg(e), 'err'); continue; }
      const xid = this.ch.newXid('u');
      const row = this.xferRow(f.name, '⤒', f.size);
      row.cancel.onclick = () => this.ch.cancel(xid);
      try {
        const committed = new Promise((resolve, reject) => this.uploadWaits.set(xid, { resolve, reject }));
        const r = await this.ch.request('fs-upload', [rootId, dir, f.name, f.size, xid]);
        await this.ch.streamOut(xid, f.size, (off, len) => xk.io.read(f.h, off, len), row.prog);
        const name = await committed;
        row.done(name !== f.name ? `✅ 完成（存為 ${name}）` : '✅ 完成');
        if (r && this.rootInfo && this.rootInfo.id === rootId && this.dir === dir) this.refresh();
      } catch (e) { this.uploadWaits.delete(xid); row.fail(e); }
      finally { xk.io.close(f.h, false); }
    }
  }

  async mkdir() {
    const inp = h('input', { placeholder: '新資料夾' });
    setTimeout(() => inp.focus(), 50);
    const ok = await modal('新增資料夾', inp, [{ label: '取消', value: false }, { label: '建立', value: true, primary: true }]);
    if (!ok || !inp.value.trim()) return;
    try { await this.ch.request('fs-mkdir', [this.rootInfo.id, this.dir, inp.value.trim()]); this.refresh(); } catch (e) { toast(errMsg(e), 'err'); }
  }

  async del() {
    const items = this.selected();
    if (!items.length) return;
    const ok = await modal('刪除', `確定要刪除被控端的 ${items.map((e) => e.name).join('、')}？此動作無法復原。`, [{ label: '取消', value: false }, { label: '刪除', value: true, danger: true }]);
    if (!ok) return;
    for (const e of items) { try { await this.ch.request('fs-delete', [this.rootInfo.id, join(this.dir, e.name)]); } catch (err) { toast(errMsg(err), 'err'); } }
    this.refresh();
  }

  async run() {
    const e = this.selected().find((x) => !x.dir);
    if (!e) return;
    toast('已送出執行要求，等待被控端按「允許執行」…');
    try { await this.ch.request('fs-run', [this.rootInfo.id, join(this.dir, e.name)], 300000); toast('被控端已開始執行 ' + e.name, 'ok'); } catch (err) { toast(errMsg(err), 'err'); }
  }
}

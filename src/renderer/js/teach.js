// 遠端線上教學：主控端（老師）把簡報或自己的螢幕推送到被控端（學生）
import * as pdfjsLib from '../../../node_modules/pdfjs-dist/build/pdf.min.mjs';
import { h, $, toast, modal, closeModal, errMsg, fmtBytes } from './util.js';

const xk = window.xk;
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../../../node_modules/pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('../../../node_modules/pdfjs-dist/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../../../node_modules/pdfjs-dist/standard_fonts/', import.meta.url).href,
};

// ---------- 投影片顯示（雙方共用） ----------
export class SlideView {
  constructor(container) {
    this.container = container;
    this.base = h('canvas');
    this.ink = h('canvas', { class: 'ink' });
    this.laserDot = h('div', { class: 'laser' });
    this.box = h('div', { class: 'slide-box' }, this.base, this.ink, this.laserDot);
    this.area = h('div', { class: 'slide-area' }, this.box);
    container.append(this.area);
    this.page = 1; this.count = 0; this.strokes = {}; this.aspect = 16 / 9;
    this.pdf = null; this.images = null; this.renderTask = null;
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.area);
  }

  destroy() { this.ro.disconnect(); this.area.remove(); if (this.pdf) this.pdf.destroy(); (this.images || []).forEach((i) => URL.revokeObjectURL(i.src)); }

  async load(deck) {
    if (deck.kind === 'pdf') {
      this.pdf = await pdfjsLib.getDocument({ data: new Uint8Array(deck.data), ...PDF_OPTS }).promise;
      this.count = this.pdf.numPages;
    } else {
      this.images = await Promise.all(deck.items.map(async (it) => {
        const img = new Image(); img.src = URL.createObjectURL(new Blob([it.data])); await img.decode(); return img;
      }));
      this.count = this.images.length;
    }
    await this.show(1);
  }

  async show(n) {
    if (!this.count) return;
    this.page = Math.min(Math.max(1, n), this.count);
    await this.render();
  }

  async render() {
    if (!this.count) return;
    const W = this.area.clientWidth - 24, H = this.area.clientHeight - 24;
    if (W < 50 || H < 50) return;
    let pageW, pageH, pdfPage = null, img = null;
    if (this.pdf) { pdfPage = await this.pdf.getPage(this.page); const vp = pdfPage.getViewport({ scale: 1 }); pageW = vp.width; pageH = vp.height; }
    else { img = this.images[this.page - 1]; pageW = img.naturalWidth; pageH = img.naturalHeight; }
    const k = Math.min(W / pageW, H / pageH);
    const cw = Math.floor(pageW * k), chh = Math.floor(pageH * k);
    this.box.style.width = cw + 'px'; this.box.style.height = chh + 'px';
    const dpr = window.devicePixelRatio || 1;
    for (const c of [this.base, this.ink]) { c.width = Math.floor(cw * dpr); c.height = Math.floor(chh * dpr); }
    const ctx = this.base.getContext('2d');
    if (pdfPage) {
      if (this.renderTask) { try { this.renderTask.cancel(); } catch {} }
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, this.base.width, this.base.height);
      this.renderTask = pdfPage.render({ canvasContext: ctx, viewport: pdfPage.getViewport({ scale: k * dpr }) });
      try { await this.renderTask.promise; } catch { /* 被新的繪製取消 */ }
    } else {
      ctx.drawImage(img, 0, 0, this.base.width, this.base.height);
    }
    this.redrawInk();
  }

  // 筆畫座標皆為 0~1 正規化
  redrawInk() {
    const ctx = this.ink.getContext('2d');
    ctx.clearRect(0, 0, this.ink.width, this.ink.height);
    for (const s of Object.values(this.strokes[this.page] || {})) this.drawStroke(ctx, s);
  }
  drawStroke(ctx, s) {
    if (!s.pts.length) return;
    ctx.strokeStyle = s.c; ctx.lineWidth = s.w * (this.ink.width / 1000); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    ctx.beginPath();
    s.pts.forEach(([x, y], i) => { const px = x * this.ink.width, py = y * this.ink.height; i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); });
    if (s.pts.length === 1) ctx.lineTo(s.pts[0][0] * this.ink.width + 0.1, s.pts[0][1] * this.ink.height);
    ctx.stroke();
  }
  addInk(page, id, c, w, pts) {
    const pg = (this.strokes[page] ||= {});
    const s = (pg[id] ||= { c, w, pts: [] });
    s.pts.push(...pts);
    if (page === this.page) this.redrawInk();
  }
  clearInk(page) { delete this.strokes[page]; if (page === this.page) this.redrawInk(); }
  laser(x, y, on) {
    this.laserDot.style.display = on ? 'block' : 'none';
    if (on) { this.laserDot.style.left = (x * 100) + '%'; this.laserDot.style.top = (y * 100) + '%'; }
  }
  norm(e) { const b = this.ink.getBoundingClientRect(); return [Math.min(Math.max((e.clientX - b.left) / b.width, 0), 1), Math.min(Math.max((e.clientY - b.top) / b.height, 0), 1)]; }
}

// ---------- 老師（主控端） ----------
export class TeachController {
  constructor(panel, stage, opts) {
    this.panel = panel; this.stage = stage; this.o = opts; // { peer, remotePeerId(), showStage(bool) }
    this.ch = null; this.view = null; this.deck = null; this.tool = 'pointer'; this.color = '#ff3b30';
    this.screenCall = null; this.screenStream = null; this.active = false; this.strokeSeq = 0;
    this.buildPanel();
  }

  buildPanel() {
    const p = this.panel;
    p.innerHTML = '';
    this.status = h('div', { class: 'muted' }, '尚未開始教學。');
    this.btnOpen = h('button', { class: 'primary', onclick: () => this.openDeck() }, '📂 開啟簡報並推送');
    this.btnScreen = h('button', { onclick: () => this.shareScreen() }, '🖥 推送我的螢幕／視窗');
    this.btnEnd = h('button', { class: 'danger', onclick: () => this.end(true), disabled: true }, '結束教學');
    this.btnView = h('button', { onclick: () => this.toggleStage(), disabled: true }, '切換：簡報 / 遠端畫面');
    p.append(h('div', { class: 'tpanel' },
      h('p', { class: 'muted small' }, '支援 PDF、PowerPoint（.pptx/.ppt，需安裝 PowerPoint、Keynote 或 LibreOffice 自動轉檔）、圖片（可多選，一張一頁）。推送後被控端會全螢幕顯示，翻頁、雷射筆與畫筆會同步。'),
      this.btnOpen, this.btnScreen, this.btnView, this.btnEnd, this.status));
  }

  attach(ch) {
    this.ch = ch;
    ch.serve('teach-pull', (xid) => { this._push(xid); return true; });
    ch.on('teach-ready', () => { this.status.textContent = `✅ 學生已載入「${this.deck.name}」，共 ${this.view.count} 頁`; this.sendPage(); });
    ch.on('teach-failed', (m) => { this.status.textContent = '❌ 被控端載入失敗：' + m.e; });
    ch.on('close', () => this.end(false));
  }

  async openDeck() {
    const ps = await xk.local.pickFiles({ multi: true, filters: [{ name: '簡報與圖片', extensions: ['pdf', 'pptx', 'ppt', 'ppsx', 'pps', 'odp', 'key', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    if (ps.length) await this.startDeck(ps);
  }

  async startDeck(ps) {
    this.status.textContent = /\.(pptx?|ppsx?|odp|key)$/i.test(ps[0]) ? '正在把簡報轉成 PDF…' : '讀取中…';
    let deck;
    try { deck = await xk.teach.prepare(ps); } catch (e) { this.status.textContent = '❌ ' + errMsg(e); return; }
    await this.startDeckWith(deck);
  }

  // 已準備好的簡報（多台廣播時共用同一份）
  async startDeckWith(deck) {
    await this.end(true, true);
    this.deck = deck;
    this.stage.innerHTML = '';
    const nav = h('div', { class: 'tnav' });
    this.stage.append(nav);
    this.view = new SlideView(this.stage);
    try { await this.view.load(deck); } catch (e) { this.status.textContent = '❌ 無法開啟：' + errMsg(e); return; }
    this.buildNav(nav);
    this.bindInk();
    this.active = true;
    this.o.showStage(true);
    this.btnEnd.disabled = false; this.btnView.disabled = false;
    // 傳送給學生
    const bytes = deck.kind === 'pdf' ? [deck.data] : deck.items.map((i) => i.data);
    const total = bytes.reduce((a, b) => a + b.byteLength, 0);
    this.payload = new Uint8Array(total);
    let off = 0; for (const b of bytes) { this.payload.set(b, off); off += b.byteLength; }
    this.xid = this.ch.newXid('t');
    this.status.textContent = `傳送簡報給學生（${fmtBytes(total)}）…`;
    this.ch.send({ t: 'teach-offer', xid: this.xid, kind: deck.kind, name: deck.name, size: total, sizes: bytes.map((b) => b.byteLength) });
  }

  _push(xid) {
    if (xid !== this.xid || !this.payload) throw new Error('簡報已更換');
    const data = this.payload;
    this.ch.streamOut(xid, data.byteLength, async (off, len) => data.subarray(off, off + len), (n) => { this.status.textContent = `傳送簡報給學生… ${Math.round(100 * n / data.byteLength)}%`; })
      .catch((e) => { this.status.textContent = '❌ 傳送失敗：' + errMsg(e); });
  }

  buildNav(nav) {
    const pageLbl = h('span', {});
    const upd = () => { pageLbl.textContent = `${this.view.page} / ${this.view.count}`; };
    this.updPage = upd;
    const tb = (tool, label) => { const b = h('button', { onclick: () => { this.tool = tool; [...nav.querySelectorAll('[data-tool]')].forEach((x) => x.classList.toggle('on', x.dataset.tool === tool)); this.view.ink.style.pointerEvents = tool === 'pointer' ? 'none' : 'auto'; this.view.ink.style.cursor = tool === 'pen' ? 'crosshair' : tool === 'laser' ? 'none' : ''; }, 'data-tool': tool }, label); if (tool === this.tool) b.classList.add('on'); return b; };
    const color = h('input', { type: 'color', value: this.color });
    color.addEventListener('input', () => { this.color = color.value; });
    nav.append(h('div', { class: 'tools-row' },
      h('button', { onclick: () => this.go(-1) }, '◀ 上一頁'), pageLbl, h('button', { onclick: () => this.go(1) }, '下一頁 ▶'),
      h('span', { class: 'muted' }, '｜'), tb('pointer', '🖱 游標'), tb('laser', '🔴 雷射筆'), tb('pen', '✏️ 畫筆'), color,
      h('button', { onclick: () => { this.view.clearInk(this.view.page); this.ch.send({ t: 'teach-clear', page: this.view.page }); } }, '🧽 清除本頁'),
      h('span', { class: 'spacer' }), h('button', { onclick: () => this.o.showStage(false) }, '↩ 回遠端畫面')));
    this.view.ink.style.pointerEvents = 'none';
    upd();
    this.keyHandler = (e) => {
      if (!this.active || !this.stage.isConnected || this.stage.classList.contains('hidden') || e.target.closest('textarea,input')) return;
      if (['ArrowRight', 'PageDown', ' '].includes(e.key)) { e.preventDefault(); this.go(1); }
      if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); this.go(-1); }
    };
    window.addEventListener('keydown', this.keyHandler);
  }

  async go(d) { await this.view.show(this.view.page + d); this.updPage(); this.sendPage(); }
  sendPage() { if (this.view) this.ch.send({ t: 'teach-page', n: this.view.page }); }

  bindInk() {
    const ink = this.view.ink;
    let cur = null, last = 0, buf = [];
    const flush = () => { if (cur && buf.length) { this.ch.send({ t: 'teach-ink', page: this.view.page, id: cur.id, c: cur.c, w: cur.w, pts: buf }); buf = []; } };
    ink.addEventListener('pointerdown', (e) => {
      if (this.tool !== 'pen') return;
      ink.setPointerCapture(e.pointerId);
      cur = { id: 's' + (++this.strokeSeq), c: this.color, w: 4 };
      const p = this.view.norm(e);
      this.view.addInk(this.view.page, cur.id, cur.c, cur.w, [p]); buf.push(p);
    });
    ink.addEventListener('pointermove', (e) => {
      const p = this.view.norm(e);
      if (this.tool === 'laser') {
        this.view.laser(p[0], p[1], true);
        if (Date.now() - last > 30) { last = Date.now(); this.ch.send({ t: 'teach-laser', x: p[0], y: p[1], on: true }); }
        return;
      }
      if (!cur) return;
      this.view.addInk(this.view.page, cur.id, cur.c, cur.w, [p]); buf.push(p);
      if (Date.now() - last > 40) { last = Date.now(); flush(); }
    });
    const up = () => { flush(); cur = null; };
    ink.addEventListener('pointerup', up);
    ink.addEventListener('pointercancel', up);
    ink.addEventListener('pointerleave', () => { if (this.tool === 'laser') { this.view.laser(0, 0, false); this.ch.send({ t: 'teach-laser', on: false }); } });
  }

  toggleStage() { this.o.showStage(this.stage.classList.contains('hidden')); }

  async shareScreen() {
    let sources;
    try { sources = await xk.cap.windows(); } catch (e) { return toast(errMsg(e), 'err'); }
    const grid = h('div', { class: 'srcgrid' });
    const picked = new Promise((resolve) => {
      for (const s of sources) grid.append(h('div', { onclick: () => { resolve(s); closeModal(null); } }, h('img', { src: s.thumb }), h('div', {}, s.name)));
    });
    const r = await Promise.race([picked, modal('選擇要推送給學生的螢幕或視窗', grid, [{ label: '取消', value: null }])]);
    if (!r) return;
    await this.end(true, true);
    try {
      this.screenStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: r.id, maxWidth: 1920, maxHeight: 1080, maxFrameRate: 15 } } });
    } catch (e) { return toast('無法擷取畫面：' + errMsg(e), 'err'); }
    this.screenCall = this.o.peer.call(this.o.remotePeerId(), this.screenStream, { metadata: { kind: 'teach-screen', name: r.name } });
    this.screenStream.getVideoTracks()[0].addEventListener('ended', () => this.end(true));
    this.active = true;
    this.btnEnd.disabled = false;
    this.status.textContent = `🖥 正在推送「${r.name}」給學生`;
  }

  async end(notify, silent) {
    const was = this.active;
    if (notify && was && this.ch && !this.ch.closed) this.ch.send({ t: 'teach-end' });
    if (this.screenCall) { try { this.screenCall.close(); } catch {} this.screenCall = null; }
    if (this.screenStream) { this.screenStream.getTracks().forEach((t) => t.stop()); this.screenStream = null; }
    if (this.view) { this.view.destroy(); this.view = null; }
    if (this.keyHandler) { window.removeEventListener('keydown', this.keyHandler); this.keyHandler = null; }
    this.stage.innerHTML = '';
    this.payload = null; this.deck = null; this.active = false;
    this.o.showStage(false);
    this.btnEnd.disabled = true; this.btnView.disabled = true;
    if (!silent && was) this.status.textContent = '教學已結束。';
  }
}

// ---------- 學生（被控端） ----------
export class TeachStudent {
  constructor(opts) {
    this.o = opts; // { log(text) }
    this.overlay = $('#teachOverlay');
    this.stage = $('#teachStudentStage');
    this.title = $('#tTitle');
    this.pageLbl = $('#tPage');
    this.view = null; this.video = null; this.call = null;
    $('#tWindow').onclick = () => { this.full = !this.full; xk.win.fullscreen(this.full); };
  }

  attach(ch) {
    this.ch = ch;
    ch.on('teach-offer', (m) => this.receive(m));
    ch.on('teach-page', (m) => { if (this.view) this.view.show(m.n).then(() => this.updPage()); else this.pendingPage = m.n; });
    ch.on('teach-ink', (m) => this.view && this.view.addInk(m.page, m.id, m.c, m.w, m.pts));
    ch.on('teach-clear', (m) => this.view && this.view.clearInk(m.page));
    ch.on('teach-laser', (m) => this.view && this.view.laser(m.x, m.y, m.on));
    ch.on('teach-end', () => this.close());
    ch.on('close', () => this.close());
  }

  open(title) {
    this.clear();
    this.title.textContent = title;
    this.pageLbl.textContent = '';
    this.overlay.classList.remove('hidden');
    this.full = true;
    xk.win.fullscreen(true);
  }

  updPage() { if (this.view) this.pageLbl.textContent = `第 ${this.view.page} / ${this.view.count} 頁`; }

  async receive(m) {
    this.open(`「${m.name}」`);
    this.o.log(`老師推送簡報 ${m.name}`);
    const msg = h('div', { class: 'stage-msg' }, '接收簡報中…');
    this.stage.append(msg);
    const buf = new Uint8Array(m.size);
    let off = 0;
    try {
      const done = this.ch.expect(m.xid, async (d) => { buf.set(new Uint8Array(d), off); off += d.byteLength; }, (n) => { msg.textContent = `接收簡報中… ${Math.round(100 * n / (m.size || 1))}%`; });
      await this.ch.request('teach-pull', [m.xid]);
      await done;
      msg.remove();
      let deck;
      if (m.kind === 'pdf') deck = { kind: 'pdf', data: buf };
      else { let o = 0; deck = { kind: 'images', items: m.sizes.map((s) => { const d = buf.slice(o, o + s); o += s; return { data: d }; }) }; }
      this.view = new SlideView(this.stage);
      await this.view.load(deck);
      if (this.pendingPage) { await this.view.show(this.pendingPage); this.pendingPage = null; }
      this.updPage();
      this.ch.send({ t: 'teach-ready' });
    } catch (e) {
      msg.textContent = '簡報載入失敗：' + errMsg(e);
      this.ch.send({ t: 'teach-failed', e: errMsg(e) });
    }
  }

  // 老師推送螢幕畫面
  onScreenCall(call) {
    this.open(`老師的畫面：${(call.metadata && call.metadata.name) || ''}`);
    this.o.log('老師開始推送螢幕畫面');
    this.call = call;
    call.answer();
    this.video = h('video', { class: 'screen', autoplay: true, playsinline: true, muted: true });
    this.stage.append(this.video);
    call.on('stream', (s) => { this.video.srcObject = s; this.video.play().catch(() => {}); });
    call.on('close', () => { if (this.call === call) this.close(); });
  }

  clear() {
    if (this.view) { this.view.destroy(); this.view = null; }
    if (this.call) { const c = this.call; this.call = null; try { c.close(); } catch {} }
    if (this.video) { this.video.srcObject = null; this.video = null; }
    this.stage.innerHTML = '';
  }

  close() {
    if (this.overlay.classList.contains('hidden')) return;
    this.clear();
    this.overlay.classList.add('hidden');
    xk.win.fullscreen(false);
    this.o.log('線上教學結束');
  }
}

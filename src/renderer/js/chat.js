// 互相聊天：文字、語音交談、畫面擷取（可裁切）、圖片、檔案互傳
import { h, $, fmtBytes, fmtTime, toast, modal, closeModal, errMsg, toAB } from './util.js';

const xk = window.xk;

// 裁切對話框：傳回裁切後的 PNG Blob（或 null）
export async function cropDialog(blob, title = '擷取畫面') {
  const url = URL.createObjectURL(blob);
  const img = h('img', { src: url, draggable: 'false' });
  const rect = h('div', { class: 'crop-rect hidden' });
  const wrap = h('div', { class: 'crop-wrap' }, img, rect);
  let sel = null, start = null;
  wrap.addEventListener('mousedown', (e) => {
    const b = img.getBoundingClientRect();
    start = { x: e.clientX - b.left, y: e.clientY - b.top };
    sel = null;
    rect.classList.remove('hidden');
    Object.assign(rect.style, { left: start.x + 'px', top: start.y + 'px', width: 0, height: 0 });
  });
  wrap.addEventListener('mousemove', (e) => {
    if (!start || !(e.buttons & 1)) return;
    const b = img.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX - b.left, 0), b.width), y = Math.min(Math.max(e.clientY - b.top, 0), b.height);
    sel = { x: Math.min(x, start.x), y: Math.min(y, start.y), w: Math.abs(x - start.x), h: Math.abs(y - start.y) };
    Object.assign(rect.style, { left: sel.x + 'px', top: sel.y + 'px', width: sel.w + 'px', height: sel.h + 'px' });
  });
  window.addEventListener('mouseup', () => { start = null; }, { once: false });
  const body = h('div', {}, h('p', { class: 'muted small' }, '可拖曳選取要傳送的範圍；不選取則傳送整個畫面。'), wrap);
  const ok = await modal(title, body, [{ label: '取消', value: false }, { label: '傳送', value: true, primary: true }]);
  if (!ok) { URL.revokeObjectURL(url); return null; }
  if (!sel || sel.w < 8 || sel.h < 8) return blob;
  await img.decode().catch(() => {});
  const k = img.naturalWidth / img.getBoundingClientRect().width || img.naturalWidth / img.width;
  const c = document.createElement('canvas');
  c.width = Math.round(sel.w * k); c.height = Math.round(sel.h * k);
  c.getContext('2d').drawImage(img, sel.x * k, sel.y * k, c.width, c.height, 0, 0, c.width, c.height);
  URL.revokeObjectURL(url);
  return new Promise((r) => c.toBlob(r, 'image/png'));
}

export class ChatPanel {
  constructor(root, opts) {
    this.root = root;
    this.o = opts; // { peer, remotePeerId(), myName, remoteName(), displayId(), onUnread(n), isVisible() }
    this.ch = null;
    this.call = null;
    this.mic = null;
    this.unread = 0;
    root.innerHTML = '';
    this.vstate = h('span', { class: 'vstate' }, '語音：未通話');
    this.btnVoice = h('button', { onclick: () => this.toggleVoice() }, '🎤 語音交談');
    this.btnMute = h('button', { class: 'hidden', onclick: () => this.toggleMute() }, '🔇 靜音');
    this.voicebar = h('div', { class: 'voicebar' }, this.vstate, this.btnMute, this.btnVoice);
    this.audio = h('audio', { autoplay: true });
    this.msgs = h('div', { class: 'msgs' });
    this.input = h('textarea', { placeholder: '輸入訊息，Enter 送出、Shift+Enter 換行' });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.sendText(); } });
    const tools = h('div', { class: 'tools' },
      h('button', { onclick: () => this.sendMyScreenshot(), title: '擷取本機畫面（可裁切）傳給對方' }, '📷 擷取我的畫面'),
      h('button', { onclick: () => this.pickImage() }, '🖼 圖片'),
      h('button', { onclick: () => this.pickFiles() }, '📎 傳送檔案'),
    );
    const send = h('div', { class: 'send' }, this.input, h('button', { class: 'primary', onclick: () => this.sendText() }, '送出'));
    root.append(h('div', { class: 'chat' }, this.voicebar, this.msgs, h('div', { class: 'composer' }, tools, send), this.audio));
  }

  attach(ch) {
    this.ch = ch;
    ch.on('chat', (m) => { this.add({ who: 'them', text: m.text, ts: m.ts }); this.notify(m.text); });
    ch.on('chat-img', (m) => this.receiveImage(m));
    ch.on('chat-file', (m) => this.receiveFile(m));
    ch.on('voice-end', () => this.endVoice(true));
    ch.on('voice-reject', () => { this.sys('對方拒絕語音交談'); this.endVoice(false); });
    ch.serve('chat-pull', (xid) => this._startPush(xid));
    this.outgoing = new Map();
    ch.on('close', () => this.endVoice(false));
  }

  notify(text) {
    if (this.o.isVisible && !this.o.isVisible()) { this.unread++; this.o.onUnread && this.o.onUnread(this.unread); }
    xk.win.attention(`${this.o.remoteName()} 傳來訊息`, text);
  }
  clearUnread() { this.unread = 0; this.o.onUnread && this.o.onUnread(0); }

  add({ who, text, ts, node }) {
    const el = h('div', { class: 'msg ' + (who === 'me' ? 'me' : who === 'sys' ? 'sys' : '') });
    if (node) el.append(node); else el.append(text);
    if (who !== 'sys') el.append(h('div', { class: 'meta' }, `${who === 'me' ? '我' : this.o.remoteName()} · ${fmtTime(ts || Date.now())}`));
    this.msgs.append(el);
    this.msgs.scrollTop = this.msgs.scrollHeight;
    return el;
  }
  sys(text) { this.add({ who: 'sys', text }); }

  sendText() {
    const text = this.input.value.trim();
    if (!text || !this.ch) return;
    const ts = Date.now();
    this.ch.send({ t: 'chat', text, ts });
    this.add({ who: 'me', text, ts });
    this.input.value = '';
  }

  addImage(blob, who, name = '截圖.png') {
    const url = URL.createObjectURL(blob);
    const img = h('img', { src: url, title: '點兩下另存圖片' });
    img.addEventListener('click', () => {
      modal(name, h('img', { src: url, style: 'max-width:85vw;max-height:75vh' }), [{ label: '另存…', value: 'save' }, { label: '關閉', value: false, primary: true }])
        .then((v) => v === 'save' && this.saveBlob(blob, name));
    });
    this.add({ who, node: img });
  }

  async saveBlob(blob, name) {
    const r = await xk.local.saveTo(name);
    if (!r) return;
    await xk.io.write(r.h, new Uint8Array(await blob.arrayBuffer()));
    await xk.io.close(r.h, true);
    toast('已儲存：' + r.path, 'ok');
  }

  async sendImageBlob(blob, name = '截圖.png') {
    if (!this.ch) return;
    const d = await blob.arrayBuffer();
    if (d.byteLength > 20 * 1024 * 1024) return toast('圖片太大，請改用「傳送檔案」', 'err');
    const xid = this.ch.newXid('i');
    this.outgoing.set(xid, { mem: new Uint8Array(d), size: d.byteLength });
    this.ch.send({ t: 'chat-img', xid, size: d.byteLength, mime: blob.type || 'image/png', name });
    this.addImage(blob, 'me', name);
  }

  async receiveImage(m) {
    const buf = new Uint8Array(m.size);
    let off = 0;
    try {
      const done = this.ch.expect(m.xid, async (d) => { buf.set(new Uint8Array(d), off); off += d.byteLength; });
      await this.ch.request('chat-pull', [m.xid]);
      await done;
      this.addImage(new Blob([buf], { type: m.mime || 'image/png' }), 'them', m.name);
      this.notify('傳來一張圖片');
    } catch (e) { this.sys('圖片接收失敗：' + errMsg(e)); }
  }

  async sendMyScreenshot() {
    try {
      const png = await xk.cap.screenshot(this.o.displayId ? this.o.displayId() : null);
      const blob = await cropDialog(new Blob([png], { type: 'image/png' }), '擷取我的畫面');
      if (blob) await this.sendImageBlob(blob, `畫面擷取_${new Date().toLocaleTimeString('zh-TW', { hour12: false }).replace(/:/g, '')}.png`);
    } catch (e) { toast('擷取失敗：' + errMsg(e), 'err'); }
  }

  async pickImage() {
    const ps = await xk.local.pickFiles({ multi: true, filters: [{ name: '圖片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
    for (const p of ps) {
      const d = await xk.local.readAll(p);
      const ext = p.split('.').pop().toLowerCase();
      await this.sendImageBlob(new Blob([d], { type: ext === 'jpg' ? 'image/jpeg' : 'image/' + ext }), p.split(/[\\/]/).pop());
    }
  }

  // ---- 檔案互傳（對方準備好接收後，才由對方「拉」） ----
  fileCard(name, size, label) {
    const bar = h('i');
    const st = h('span', { class: 'small muted' }, label);
    const node = h('div', { class: 'file' }, h('b', {}, '📄 ' + name), h('span', { class: 'small muted' }, fmtBytes(size)), h('div', { class: 'prog' }, bar), st);
    return { node, bar, st };
  }

  async pickFiles() {
    if (!this.ch) return;
    this.sendPaths(await xk.local.pickFiles({ multi: true }));
  }

  async sendPaths(ps) {
    for (const p of ps) {
      try {
        const f = await xk.local.openRead(p);
        const xid = this.ch.newXid('c');
        const card = this.fileCard(f.name, f.size, '等待對方接收…');
        this.add({ who: 'me', node: card.node });
        this.outgoing.set(xid, { ...f, card });
        this.ch.send({ t: 'chat-file', xid, name: f.name, size: f.size });
      } catch (e) { toast(errMsg(e), 'err'); }
    }
  }

  _startPush(xid) {
    const f = this.outgoing.get(xid);
    if (!f) throw new Error('找不到檔案');
    this.outgoing.delete(xid);
    if (f.mem) {
      this.ch.streamOut(xid, f.size, async (off, len) => f.mem.subarray(off, off + len)).catch(() => {});
      return true;
    }
    f.card.st.textContent = '傳送中…';
    this.ch.streamOut(xid, f.size, (off, len) => xk.io.read(f.h, off, len), (n) => { f.card.bar.style.width = (100 * n / (f.size || 1)) + '%'; })
      .then(() => { f.card.st.textContent = '✅ 已送達'; f.card.bar.style.width = '100%'; })
      .catch((e) => { f.card.st.textContent = '❌ ' + errMsg(e); })
      .finally(() => xk.io.close(f.h, false));
    return true;
  }

  async receiveFile(m) {
    const card = this.fileCard(m.name, m.size, '接收中…');
    this.add({ who: 'them', node: card.node });
    this.notify('傳來檔案 ' + m.name);
    let w;
    try {
      w = await xk.local.openIncoming(m.name);
      const done = this.ch.expect(m.xid, (d) => xk.io.write(w.h, new Uint8Array(d)), (n) => { card.bar.style.width = (100 * n / (m.size || 1)) + '%'; });
      if (m.size === 0) { /* 空檔案也走同一流程 */ }
      await this.ch.request('chat-pull', [m.xid]);
      await done;
      const p = await xk.io.close(w.h, true);
      card.bar.style.width = '100%';
      card.st.innerHTML = '';
      card.st.append('✅ 已存到 ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); xk.local.reveal(p); } }, '下載資料夾'), '　', h('a', { href: '#', onclick: (e) => { e.preventDefault(); xk.local.open(p); } }, '開啟'));
    } catch (e) {
      if (w) xk.io.close(w.h, false);
      card.st.textContent = '❌ ' + errMsg(e);
    }
  }

  // ---- 語音交談 ----
  setVoiceUI(state) {
    this.voicebar.classList.toggle('on', state === 'on');
    this.vstate.textContent = { off: '語音：未通話', calling: '語音：撥號中…', on: '🟢 語音通話中' }[state];
    this.btnVoice.textContent = state === 'off' ? '🎤 語音交談' : '⏹ 結束語音';
    this.btnMute.classList.toggle('hidden', state !== 'on');
  }

  async getMic() {
    await xk.sys.askMicrophone();
    return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
  }

  async toggleVoice() {
    if (this.call || this.mic) return this.endVoice(false, true);
    try {
      this.mic = await this.getMic();
      this.setVoiceUI('calling');
      const call = this.o.peer.call(this.o.remotePeerId(), this.mic, { metadata: { kind: 'voice' } });
      this._setupCall(call);
    } catch (e) { toast('無法開啟麥克風：' + errMsg(e), 'err'); this.endVoice(false); }
  }

  async onVoiceCall(call) {
    if (this.call) { call.close(); return; }
    this.sys('對方邀請語音交談');
    xk.win.attention('語音交談邀請', `${this.o.remoteName()} 邀請你語音交談`);
    const ok = await modal('語音交談邀請', `${this.o.remoteName()} 邀請你語音交談，要接聽嗎？`, [{ label: '拒絕', value: false }, { label: '接聽', value: true, primary: true }], { timeout: 45000, timeoutValue: false });
    if (!ok) { call.close(); this.ch && this.ch.send({ t: 'voice-reject' }); return; }
    try {
      this.mic = await this.getMic();
      call.answer(this.mic);
      this._setupCall(call);
    } catch (e) { toast('無法開啟麥克風：' + errMsg(e), 'err'); call.close(); this.ch && this.ch.send({ t: 'voice-reject' }); }
  }

  _setupCall(call) {
    this.call = call;
    call.on('stream', (s) => { this.audio.srcObject = s; this.audio.play().catch(() => {}); this.setVoiceUI('on'); this.sys('語音通話已接通'); });
    call.on('close', () => { if (this.call === call) this.endVoice(false); });
    call.on('error', () => { if (this.call === call) this.endVoice(false); });
  }

  toggleMute() {
    if (!this.mic) return;
    const t = this.mic.getAudioTracks()[0];
    t.enabled = !t.enabled;
    this.btnMute.textContent = t.enabled ? '🔇 靜音' : '🔈 取消靜音';
  }

  endVoice(remote, notify) {
    const had = !!(this.call || this.mic);
    if (notify && this.ch) this.ch.send({ t: 'voice-end' });
    if (this.call) { try { this.call.close(); } catch {} this.call = null; }
    if (this.mic) { this.mic.getTracks().forEach((t) => t.stop()); this.mic = null; }
    this.audio.srcObject = null;
    this.setVoiceUI('off');
    if (had) this.sys(remote ? '對方結束了語音交談' : '語音交談已結束');
  }
}

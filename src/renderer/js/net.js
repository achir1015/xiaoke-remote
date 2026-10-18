// 網路層：ID 伺服器（PeerJS 信令）＋ WebRTC 資料通道上的訊息、RPC 與分段傳檔
import { Emitter, sleep, errMsg, toAB } from './util.js';

const PeerCtor = window.Peer || (window.peerjs && window.peerjs.Peer);
export const PREFIX = 'xkr-';
export const CHUNK = 64 * 1024;
export const peerIdOf = (deviceId) => PREFIX + String(deviceId).replace(/\D/g, '');

export function iceServers(s) {
  const list = String(s.stun || '').split(/\s+/).filter(Boolean).map((u) => ({ urls: u }));
  if (s.turn && s.turn.urls) list.push({ urls: s.turn.urls.split(/[\s,]+/).filter(Boolean), username: s.turn.username, credential: s.turn.credential });
  return list;
}

export function peerOptions(s) {
  const o = { debug: 1, config: { iceServers: iceServers(s), sdpSemantics: 'unified-plan' } };
  if (s.server && s.server.mode === 'custom' && s.server.host) {
    Object.assign(o, { host: s.server.host, port: Number(s.server.port) || (s.server.secure ? 443 : 9000), path: s.server.path || '/', key: s.server.key || 'peerjs', secure: !!s.server.secure });
  }
  return o;
}

// 建立本機節點；ID 被占用時回傳錯誤碼 unavailable-id
export function createPeer(settings) {
  return new Promise((resolve, reject) => {
    const peer = new PeerCtor(peerIdOf(settings.deviceId), peerOptions(settings));
    let opened = false;
    peer.on('open', () => { opened = true; resolve(peer); });
    peer.on('error', (e) => { if (!opened) { peer.destroy(); reject(e); } });
  });
}

export class Channel extends Emitter {
  constructor(ctl) {
    super();
    this.ctl = ctl;
    this.file = null;
    this.pending = new Map();
    this.sinks = new Map();
    this.handlers = {};
    this.cancelled = new Set();
    this.seq = 0;
    this.closed = false;
    this.lastSeen = Date.now();
    ctl.on('data', (m) => { this.lastSeen = Date.now(); this._onData(m); });
    ctl.on('close', () => this._close('ctl'));
    // 心跳：對方程式當掉或網路斷掉時，WebRTC 要很久才會發現，這裡 12 秒沒收到任何資料就判定斷線
    this.hb = setInterval(() => {
      if (Date.now() - this.lastSeen > 12000) {
        try { this.ctl.close(); } catch {}
        try { this.file && this.file.close(); } catch {}
        this._close();
        return;
      }
      this.send({ t: 'ping' });
    }, 3000);
    ctl.on('error', (e) => console.warn('ctl error', e));
  }

  attachFile(conn) {
    this.file = conn;
    conn.on('data', (m) => { this.lastSeen = Date.now(); this._onData(m); });
    conn.on('close', () => { if (this.file === conn) this.file = null; });
  }

  _close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.hb);
    for (const p of this.pending.values()) p.reject(new Error('連線已中斷'));
    this.pending.clear();
    for (const s of this.sinks.values()) s.fail(new Error('連線已中斷'));
    this.sinks.clear();
    this.emit('close');
  }

  close() {
    try { this.send({ t: 'bye' }); } catch {}
    setTimeout(() => { try { this.ctl.close(); } catch {} try { this.file && this.file.close(); } catch {} this._close(); }, 150);
  }

  send(m) { if (!this.closed && this.ctl.open) this.ctl.send(m); }
  sendF(m) { const c = this.file && this.file.open ? this.file : this.ctl; if (!this.closed && c.open) c.send(m); }

  async drain() {
    const c = this.file && this.file.open ? this.file : this.ctl;
    for (;;) {
      if (this.closed) throw new Error('連線已中斷');
      const dc = c.dataChannel;
      const queued = (dc ? dc.bufferedAmount : 0) + (c.bufferSize || 0) * 16300;
      if (queued < 2 * 1024 * 1024) return;
      await sleep(8);
    }
  }

  _onData(m) {
    if (!m || typeof m !== 'object' || !m.t) return;
    switch (m.t) {
      case 'ping': break;
      case 'req': this._serve(m); break;
      case 'res': {
        const p = this.pending.get(m.id);
        if (p) { this.pending.delete(m.id); clearTimeout(p.timer); m.ok ? p.resolve(m.r) : p.reject(new Error(m.e)); }
        break;
      }
      case 'chunk': { const s = this.sinks.get(m.xid); if (s) s.push(m.d); break; }
      case 'chunk-end': { const s = this.sinks.get(m.xid); if (s) { this.sinks.delete(m.xid); s.end(); } break; }
      case 'chunk-err': { const s = this.sinks.get(m.xid); if (s) { this.sinks.delete(m.xid); s.fail(new Error(m.e || '傳輸失敗')); } break; }
      case 'xfer-cancel': {
        this.cancelled.add(m.xid);
        const s = this.sinks.get(m.xid);
        if (s) { this.sinks.delete(m.xid); s.fail(new Error('對方已取消')); }
        this.emit('xfer-cancel', m);
        break;
      }
      case 'bye': {
        try { this.ctl.close(); } catch {}
        try { this.file && this.file.close(); } catch {}
        this._close();
        break;
      }
      default: this.emit(m.t, m);
    }
  }

  serve(op, fn) { this.handlers[op] = fn; }

  async _serve(m) {
    try {
      const fn = this.handlers[m.op];
      if (!fn) throw new Error('對方不支援此功能：' + m.op);
      const r = await fn(...(m.args || []));
      this.sendF({ t: 'res', id: m.id, ok: true, r });
    } catch (e) {
      this.sendF({ t: 'res', id: m.id, ok: false, e: errMsg(e) });
    }
  }

  request(op, args = [], timeout = 120000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error('連線已中斷'));
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('對方沒有回應')); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.sendF({ t: 'req', id, op, args });
    });
  }

  newXid(prefix) { return `${prefix}${Date.now().toString(36)}${(++this.seq).toString(36)}`; }

  // 傳出：read(offset, len) → Uint8Array
  async streamOut(xid, size, read, onProgress) {
    let off = 0;
    try {
      while (off < size) {
        if (this.cancelled.has(xid)) throw new Error('已取消');
        const u8 = await read(off, Math.min(CHUNK, size - off));
        if (!u8.byteLength) throw new Error('讀取檔案失敗');
        await this.drain();
        this.sendF({ t: 'chunk', xid, d: toAB(u8) });
        off += u8.byteLength;
        if (onProgress) onProgress(off);
      }
      this.sendF({ t: 'chunk-end', xid });
    } catch (e) {
      if (!this.cancelled.has(xid)) this.sendF({ t: 'chunk-err', xid, e: errMsg(e) });
      throw e;
    } finally {
      this.cancelled.delete(xid);
    }
  }

  // 接收：write(ArrayBuffer) 依序執行；完成時 resolve 總位元組數
  expect(xid, write, onProgress) {
    let chain = Promise.resolve();
    let got = 0;
    let failed = null;
    return new Promise((resolve, reject) => {
      this.sinks.set(xid, {
        push: (d) => {
          chain = chain.then(async () => {
            if (failed) return;
            await write(d);
            got += d.byteLength;
            if (onProgress) onProgress(got);
          }).catch((e) => {
            if (failed) return;
            failed = e;
            this.sinks.delete(xid);
            this.sendF({ t: 'xfer-cancel', xid });
            reject(e);
          });
        },
        end: () => { chain.then(() => { if (!failed) resolve(got); }); },
        fail: (e) => { failed = e; chain.then(() => reject(e)); },
      });
    });
  }

  cancel(xid) {
    this.cancelled.add(xid);
    this.sendF({ t: 'xfer-cancel', xid });
    const s = this.sinks.get(xid);
    if (s) { this.sinks.delete(xid); s.fail(new Error('已取消')); }
  }
}

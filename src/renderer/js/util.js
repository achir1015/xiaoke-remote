// 共用小工具
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / 1024 ** i).toFixed(i ? 1 : 0) + ' ' + u[i];
}
export const fmtTime = (ts) => new Date(ts).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
export const fmtId = (id) => String(id || '').replace(/\D/g, '').replace(/(\d{3})(?=\d)/g, '$1 ');
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const errMsg = (e) => (e && (e.message || e.error)) ? String(e.message || e.error).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e);

export function toast(text, kind = '', ms = 4000) {
  const el = h('div', { class: 'toast ' + kind }, text);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), ms);
}

// 對話框：buttons = [{label, value, primary, danger}]，回傳按下的 value
export function modal(title, body, buttons = [{ label: '確定', value: true, primary: true }], opts = {}) {
  const m = document.getElementById('modal');
  const mb = document.getElementById('mBody');
  document.getElementById('mTitle').textContent = title;
  mb.innerHTML = '';
  if (typeof body === 'string') mb.append(h('p', {}, body)); else if (body) mb.append(body);
  const btns = document.getElementById('mBtns');
  btns.innerHTML = '';
  m.classList.remove('hidden');
  return new Promise((resolve) => {
    let timer = null;
    const done = (v) => { clearTimeout(timer); m.classList.add('hidden'); m._close = null; resolve(v); };
    m._close = done;
    for (const b of buttons) btns.append(h('button', { class: b.primary ? 'primary' : b.danger ? 'danger' : '', onclick: () => done(b.value) }, b.label));
    if (opts.timeout) timer = setTimeout(() => done(opts.timeoutValue), opts.timeout);
  });
}
export function closeModal(v) { const m = document.getElementById('modal'); if (m._close) m._close(v); }

export class Emitter {
  constructor() { this._h = {}; }
  on(t, f) { (this._h[t] ||= []).push(f); return () => this.off(t, f); }
  off(t, f) { this._h[t] = (this._h[t] || []).filter((x) => x !== f); }
  emit(t, ...a) { for (const f of [...(this._h[t] || [])]) { try { f(...a); } catch (e) { console.error(e); } } for (const f of [...(this._h['*'] || [])]) f(t, ...a); }
}

export const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
export const randCode = (n = 6) => { const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; const a = crypto.getRandomValues(new Uint32Array(n)); return [...a].map((x) => cs[x % cs.length]).join(''); };

// 主控端：可同時連線多台被控端（導播式分割畫面），點選一台放大操控
import { $, $$, h, toast, modal, closeModal, errMsg, fmtId, sleep } from './util.js';
import { Channel, peerIdOf, PREFIX } from './net.js';
import { ChatPanel, cropDialog } from './chat.js';
import { FileManager } from './files.js';
import { TeachController } from './teach.js';

const xk = window.xk;
const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const MAX_LINKS = 20;
let S, showView, renderHome;

export function initClient(state, fns) {
  S = state;
  ({ showView, renderHome } = fns);
  S.links = new Map();   // remotePeer → link
  S.pending = new Map(); // remotePeer → 連線中
  S.focus = null;        // 目前放大操控的 link
  Object.defineProperty(S, 'client', { get: () => S.focus, configurable: true }); // 相容單台模式與測試
  S.broadcastDeck = (paths) => broadcastDeck(paths); // 自動化測試用
  bindSessionToolbar();
  bindMulti();
}

export const hasLinks = () => S.links.size > 0 || S.pending.size > 0;

export function onPeerError(e) {
  if (e.type !== 'peer-unavailable') return;
  const m = String(e.message || '').match(/xkr-\d+/);
  const p = m && S.pending.get(m[0]);
  if (p && p.fail) p.fail(new Error('找不到這個 ID，或對方目前不在線上'));
  else if (!m) for (const x of S.pending.values()) x.fail && x.fail(new Error('找不到這個 ID，或對方目前不在線上'));
}

export function onClientCall(call) {
  const kind = call.metadata && call.metadata.kind;
  const link = S.links.get(call.peer);
  if (kind === 'screen') {
    if (link) { link.onScreen(call); return true; }
    const p = S.pending.get(call.peer);
    if (p) { p.pendingScreen = call; return true; }
  }
  if (kind === 'voice' && link) { link.chat.onVoiceCall(call); return true; }
  return false;
}

// ---------------- 建立連線 ----------------
async function connectTo(id, code, viewOnly, onWait) {
  const remotePeer = peerIdOf(id);
  if (S.links.has(remotePeer) || S.pending.has(remotePeer)) throw new Error('已經連線到這台電腦');
  if (!S.peer || S.peer.disconnected) throw new Error('尚未連上 ID 伺服器，請稍候');
  const pending = { remotePeer };
  S.pending.set(remotePeer, pending);
  let ch = null;
  try {
    const info = await new Promise((resolve, reject) => {
      pending.fail = reject;
      const timer = setTimeout(() => reject(new Error('連線逾時，請確認對方在線上，或在設定中加入 TURN 中繼伺服器')), 25000);
      const conn = S.peer.connect(remotePeer, { label: 'xk-ctl', reliable: true, serialization: 'binary' });
      conn.on('error', (e) => reject(e));
      conn.on('open', () => {
        ch = new Channel(conn);
        ch.send({ t: 'hello', code, name: S.settings.deviceName, os: S.info.platform, viewOnly, ver: S.info.version });
        ch.on('auth-wait', () => { clearTimeout(timer); onWait && onWait(); setTimeout(() => reject(new Error('對方沒有回應')), 40000); });
        ch.on('auth-ok', (m) => { clearTimeout(timer); resolve(m); });
        ch.on('auth-fail', (m) => { clearTimeout(timer); reject(new Error(m.reason)); });
        ch.on('close', () => reject(new Error('連線被對方關閉')));
      });
    });
    return createLink(ch, remotePeer, id, info, viewOnly, pending.pendingScreen);
  } catch (e) {
    if (ch) ch.close();
    throw e;
  } finally {
    S.pending.delete(remotePeer);
  }
}

function createLink(ch, remotePeer, id, info, viewOnly, pendingScreen) {
  const link = {
    ch, remotePeer, id, name: info.name, os: info.os, allow: info.allow, inputOk: info.inputOk, viewOnly, info,
    stream: null, screenCall: null, timers: [], multi: false, unread: 0, stat: '',
    control: !viewOnly,
    chatRoot: h('div', { class: 'pane-inner' }), filesRoot: h('div', { class: 'pane-inner' }), teachRoot: h('div', { class: 'pane-inner' }),
    teachStage: h('div', { class: 'teach-host hidden' }),
  };
  S.links.set(remotePeer, link);
  const fconn = S.peer.connect(remotePeer, { label: 'xk-file', reliable: true, serialization: 'binary' });
  fconn.on('open', () => ch.attachFile(fconn));

  link.chat = new ChatPanel(link.chatRoot, {
    peer: S.peer, remotePeerId: () => remotePeer, myName: S.settings.deviceName, remoteName: () => link.name,
    displayId: () => null, isVisible: () => S.focus === link && activePane() === 'chat' && !$('#drawer').classList.contains('collapsed'),
    onUnread: (n) => { link.unread = n; if (S.focus === link) setBadge(n); updateTile(link); },
  });
  link.chat.attach(ch);
  link.files = new FileManager(link.filesRoot);
  link.files.attach(ch);
  link.teach = new TeachController(link.teachRoot, link.teachStage, {
    peer: S.peer, remotePeerId: () => remotePeer,
    showStage: (on) => link.teachStage.classList.toggle('hidden', !on),
  });
  link.teach.attach(ch);

  link.chat.sys(`已連線到 ${info.name}${viewOnly ? '（僅檢視）' : ''}`);
  if (!viewOnly && !info.allow && !info.web) link.chat.sys('對方設定為不允許操控，目前僅能檢視');
  if (!viewOnly && info.allow && info.inputOk === false) link.chat.sys('⚠️ 對方的鍵鼠控制模組無法載入，可能無法操控');
  if (info.web) link.chat.sys('對方使用線上版（瀏覽器）：可以看畫面、聊天、語音、傳檔與教學，但無法操控滑鼠鍵盤，也不能遠端執行程式。');
  else if (info.os === 'darwin' && !viewOnly) link.chat.sys('提示：對方是 Mac，需在「系統設定 › 隱私權與安全性」開啟「螢幕錄製」與「輔助使用」才能看到畫面與操控。');

  ch.on('display-ok', () => toast('已切換螢幕'));
  ch.on('notice', (m) => toast(`${link.name}：${m.text}`));
  ch.on('ctl-state', (m) => {
    link.allow = m.allow;
    if (S.focus === link) updControl();
    toast(`${link.name}：${m.allow ? '對方已允許操控' : '對方暫停了操控，目前僅能檢視'}`);
  });

  link.onScreen = (call) => {
    link.screenCall = call;
    call.answer();
    call.on('stream', (s) => {
      link.stream = s;
      if (link.tileVideo) { link.tileVideo.srcObject = s; link.tileVideo.play().catch(() => {}); }
      if (S.focus === link) showFocusStream();
      updateTile(link);
    });
    call.on('close', () => { link.stream = null; if (S.focus === link) { $('#stageMsg').textContent = '遠端畫面已停止'; $('#stageMsg').classList.remove('hidden'); } updateTile(link); });
  };
  if (pendingScreen) link.onScreen(pendingScreen);

  // 連線品質統計
  let lastBytes = 0, lastTs = 0;
  link.timers.push(setInterval(async () => {
    const pc = link.screenCall && link.screenCall.peerConnection;
    if (!pc) return;
    const st = await pc.getStats();
    let fps = 0, bytes = 0, w = 0, hh = 0, route = '', sel = null;
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') { fps = r.framesPerSecond || 0; bytes = r.bytesReceived; w = r.frameWidth; hh = r.frameHeight; }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') sel = r;
    });
    if (sel) { const lc = st.get(sel.localCandidateId); route = lc && lc.candidateType === 'relay' ? '中繼' : '直連'; }
    const now = Date.now();
    const rate = lastTs ? ((bytes - lastBytes) * 8 / ((now - lastTs) / 1000) / 1e6).toFixed(1) : '0';
    lastBytes = bytes; lastTs = now;
    link.stat = `${route} · ${w || 0}×${hh || 0} · ${Math.round(fps)}fps · ${rate}Mbps`;
    if (S.focus === link) $('#sStat').textContent = link.stat;
    if (link.tileStat) link.tileStat.textContent = link.stat;
  }, 2000));

  ch.on('close', () => closeLink(link, true));
  return link;
}

function closeLink(link, remote) {
  if (!S.links.has(link.remotePeer)) return;
  S.links.delete(link.remotePeer);
  link.timers.forEach(clearInterval);
  try { link.screenCall && link.screenCall.close(); } catch {}
  try { link.chat.endVoice(false); } catch {}
  try { link.teach.end(false, true); } catch {}
  if (!link.ch.closed) link.ch.close();
  const wasFocus = S.focus === link;
  if (wasFocus) unfocus();
  if (link.multi) {
    const d = device(link.id);
    if (d) { d.link = null; d.state = remote ? '已中斷' : '未連線'; renderDevices(); renderGrid(); }
    if (remote && multiOn && d) scheduleReconnect(d);
    if (wasFocus) showView('multi');
  } else if (wasFocus) {
    closeModal(false);
    xk.win.fullscreen(false);
    $('#drawer').classList.remove('collapsed');
    showView('home');
  }
  toast(`與 ${link.name} 的連線已結束`);
}

// ---------------- 單台模式（首頁） ----------------
export async function startClient(viewOnly) {
  if (S.host) return toast('本機正在被遠端連線中', 'err');
  const id = $('#remoteId').value.replace(/\D/g, '');
  const code = $('#remoteCode').value.trim();
  if (id.length < 6) return toast('請輸入正確的遠端 ID', 'err');
  if (!code) return toast('請輸入授權碼', 'err');
  if (id === String(S.settings.deviceId)) return toast('不能連線到自己', 'err');
  if (S.links.size >= MAX_LINKS) return toast(`最多同時連線 ${MAX_LINKS} 台`, 'err');
  const btn = $('#btnConnect');
  if (btn.disabled) return;
  btn.disabled = true; btn.textContent = '連線中…';
  try {
    const link = await connectTo(id, code, viewOnly, () => { btn.textContent = '等待對方接受…'; });
    const recent = [{ id, name: link.name, ts: Date.now() }, ...(S.settings.recent || []).filter((r) => r.id !== id)].slice(0, 8);
    S.settings = await xk.settings.set({ recent });
    renderHome();
    focusLink(link);
  } catch (e) {
    toast('連線失敗：' + errMsg(e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = '連線並操控';
  }
}

// ---------------- 放大操控 ----------------
function activePane() { const b = $('#drawer .dtabs button.active'); return b && b.dataset.pane; }
function setBadge(n) { const b = $('#chatBadge'); b.textContent = n; b.classList.toggle('hidden', !n); }
function setPane(name) {
  $$('#drawer .dtabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $$('#drawer .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'chat' && S.focus) S.focus.chat.clearUnread();
}

const canControl = () => { const l = S.focus; return !!l && !l.viewOnly && l.allow && l.control; };
function updControl() {
  const l = S.focus;
  if (!l) return;
  $('#sControl').disabled = l.viewOnly || !l.allow;
  $('#sControl').checked = canControl();
  $('#vwrap').classList.toggle('control', canControl());
}

function showFocusStream() {
  const v = $('#rvideo');
  const l = S.focus;
  if (l && l.stream) { v.srcObject = l.stream; v.play().catch(() => {}); $('#stageMsg').classList.add('hidden'); }
  else { v.srcObject = null; $('#stageMsg').textContent = '等待遠端畫面…'; $('#stageMsg').classList.remove('hidden'); }
}

export function focusLink(link) {
  if (S.focus && S.focus !== link) unfocus();
  S.focus = link;
  const info = link.info;
  $('#sTitle').textContent = `${link.name}（${OS_NAME[link.os] || link.os}）`;
  $('#sBack').classList.toggle('hidden', !link.multi);
  $('#sClose').textContent = link.multi ? '中斷這台' : '中斷連線';
  $('#ctrlChat').replaceChildren(link.chatRoot);
  $('#ctrlFiles').replaceChildren(link.filesRoot);
  $('#ctrlTeach').replaceChildren(link.teachRoot);
  $('#stage').append(link.teachStage);
  setBadge(link.unread);

  const sel = $('#sDisplay');
  sel.innerHTML = '';
  info.displays.forEach((d, i) => sel.append(h('option', { value: d.id, selected: d.id === (link.display || info.current) }, `螢幕 ${i + 1}${d.primary ? '（主）' : ''} ${d.w}×${d.h}`)));
  sel.classList.toggle('hidden', info.displays.length < 2);
  sel.onchange = () => { link.display = sel.value; link.ch.send({ t: 'display', id: sel.value }); };

  const keys = $('#sKeys');
  keys.innerHTML = '';
  const combos = link.os === 'darwin'
    ? [['⌘ Command', ['MetaLeft']], ['⌘ + Space（Spotlight）', ['MetaLeft', 'Space']], ['⌘ + Tab', ['MetaLeft', 'Tab']], ['⌘ + Q', ['MetaLeft', 'KeyQ']], ['⌥⌘ + Esc（強制結束）', ['AltLeft', 'MetaLeft', 'Escape']], ['⌘⇧ + 3（截圖）', ['MetaLeft', 'ShiftLeft', 'Digit3']]]
    : [['Win 鍵（開始）', ['MetaLeft']], ['Ctrl + Shift + Esc（工作管理員）', ['ControlLeft', 'ShiftLeft', 'Escape']], ['Alt + Tab', ['AltLeft', 'Tab']], ['Alt + F4', ['AltLeft', 'F4']], ['Win + D（顯示桌面）', ['MetaLeft', 'KeyD']], ['Win + E（檔案總管）', ['MetaLeft', 'KeyE']], ['Win + R（執行）', ['MetaLeft', 'KeyR']], ['Print Screen', ['PrintScreen']]];
  for (const [label, codes] of combos) keys.append(h('button', { onclick: () => canControl() && link.ch.send({ t: 'combo', codes, raw: true }) }, label));

  $('#sStat').textContent = link.stat;
  updControl();
  showFocusStream();
  bindVideoInput(link);
  link.ch.send({ t: 'quality', q: S.settings.quality });
  if (!activePane()) setPane('chat'); else if (activePane() === 'chat') link.chat.clearUnread();
  showView('session');
  $('#rvideo').focus();
}

function unfocus() {
  const l = S.focus;
  if (!l) return;
  (l.unbind || []).forEach((f) => f());
  l.unbind = [];
  if (l.multi && S.links.has(l.remotePeer)) l.ch.send({ t: 'quality', q: 'thumb' });
  l.teachStage.remove();
  $('#rvideo').srcObject = null;
  S.focus = null;
}

function bindVideoInput(link) {
  const video = $('#rvideo');
  const send = (m) => { if (canControl() && S.focus === link) link.ch.send(m); };
  const pos = (e) => {
    const r = video.getBoundingClientRect();
    const vw = video.videoWidth || r.width, vh = video.videoHeight || r.height;
    const k = Math.min(r.width / vw, r.height / vh);
    const cw = vw * k, chh = vh * k;
    const ox = r.left + (r.width - cw) / 2, oy = r.top + (r.height - chh) / 2;
    return { x: (e.clientX - ox) / cw, y: (e.clientY - oy) / chh };
  };
  let pendingMove = null, raf = 0;
  const held = new Set();
  link.unbind = [];
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); link.unbind.push(() => el.removeEventListener(ev, fn, opt)); };
  on(video, 'mousemove', (e) => {
    if (!canControl()) return;
    pendingMove = pos(e);
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; if (pendingMove) { send({ t: 'mm', ...pendingMove }); pendingMove = null; } });
  });
  on(video, 'mousedown', (e) => { if (!canControl()) return; e.preventDefault(); video.focus(); send({ t: 'md', b: e.button, ...pos(e) }); });
  on(video, 'mouseup', (e) => { if (!canControl()) return; e.preventDefault(); send({ t: 'mu', b: e.button, ...pos(e) }); });
  on(video, 'contextmenu', (e) => e.preventDefault());
  on(video, 'wheel', (e) => {
    if (!canControl()) return;
    e.preventDefault();
    const k = e.deltaMode === 1 ? 40 : e.deltaMode === 2 ? 400 : 1;
    send({ t: 'wheel', dx: e.deltaX * k, dy: e.deltaY * k });
  }, { passive: false });
  const isTyping = (e) => e.target.closest && e.target.closest('textarea, input, select, .modal:not(.hidden)');
  on(window, 'keydown', (e) => {
    if (!canControl() || isTyping(e) || !link.teachStage.classList.contains('hidden')) return;
    if (document.activeElement !== video) return;
    e.preventDefault();
    held.add(e.code);
    send({ t: 'kd', code: e.code });
  }, true);
  on(window, 'keyup', (e) => {
    if (!held.has(e.code)) return;
    e.preventDefault();
    held.delete(e.code);
    send({ t: 'ku', code: e.code });
  }, true);
  const releaseAll = () => { for (const c of held) link.ch.send({ t: 'ku', code: c }); held.clear(); };
  on(window, 'blur', releaseAll);
  on(video, 'blur', releaseAll);
  link.unbind.push(releaseAll);
}

function bindSessionToolbar() {
  $$('#drawer .dtabs button').forEach((b) => b.addEventListener('click', () => {
    const d = $('#drawer');
    if (d.classList.contains('collapsed')) d.classList.remove('collapsed');
    setPane(b.dataset.pane);
  }));
  $('#sControl').onchange = () => { if (S.focus) { S.focus.control = $('#sControl').checked; updControl(); } };
  $('#sClose').onclick = () => S.focus && closeLink(S.focus, false);
  $('#sBack').onclick = () => { unfocus(); xk.win.fullscreen(false); showView('multi'); renderGrid(); };
  $('#sFit').onclick = () => $('#vwrap').classList.toggle('actual');
  let full = false;
  $('#sFull').onclick = () => { full = !full; xk.win.fullscreen(full); $('#drawer').classList.toggle('collapsed', full); };
  $('#sClipSend').onclick = async () => {
    if (!S.focus) return;
    const text = await xk.clip.read();
    if (!text) return toast('本機剪貼簿沒有文字');
    S.focus.ch.send({ t: 'clip-set', text });
    toast('已把剪貼簿文字送到遠端，可在遠端按貼上');
  };
  $('#sClipGet').onclick = async () => {
    if (!S.focus) return;
    try { const t = await S.focus.ch.request('clip-get', [], 10000); await xk.clip.write(t || ''); toast(t ? '已取得遠端剪貼簿文字' : '遠端剪貼簿沒有文字'); } catch (e) { toast(errMsg(e), 'err'); }
  };
  $('#sShot').onclick = async () => {
    const v = $('#rvideo');
    const l = S.focus;
    if (!l || !v.videoWidth) return toast('尚未收到遠端畫面', 'err');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const cropped = await cropDialog(blob, '擷取遠端畫面');
    if (cropped && S.links.has(l.remotePeer)) { await l.chat.sendImageBlob(cropped, `遠端畫面_${Date.now()}.png`); setPane('chat'); }
  };
}

// ================= 多台監看（導播式分割畫面） =================
let multiOn = false;      // 按過「全部連線」後，斷線會自動重連
const devState = new Map(); // id → { state, link, retry }
const device = (id) => { const d = (S.settings.devices || []).find((x) => x.id === id); if (!d) return null; const st = devState.get(id) || { state: '未連線' }; devState.set(id, st); return Object.assign(st, { id, dev: d }); };

function bindMulti() {
  $('#mAdd').onclick = addDevice;
  $('#mAddCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') addDevice(); });
  $('#mAddId').addEventListener('input', (e) => { const v = fmtId(e.target.value).slice(0, 15); if (v !== e.target.value) e.target.value = v; });
  $('#mConnectAll').onclick = connectAll;
  $('#mDisconnectAll').onclick = disconnectAll;
  $('#mLayout').onchange = renderGrid;
  $('#mBroadcast').onclick = broadcastText;
  $('#mBroadcastText').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) broadcastText(); });
  $('#mTeachOpen').onclick = broadcastTeach;
  $('#mTeachPrev').onclick = () => multiLinks().forEach((l) => l.teach.view && l.teach.go(-1));
  $('#mTeachNext').onclick = () => multiLinks().forEach((l) => l.teach.view && l.teach.go(1));
  $('#mTeachEnd').onclick = () => { multiLinks().forEach((l) => l.teach.end(true)); $('#mTeachState').textContent = ''; };
  window.addEventListener('keydown', (e) => {
    if (!$('#view-multi').classList.contains('active') || e.target.closest('input, textarea, select')) return;
    const n = Number(e.key);
    if (n >= 1 && n <= 9) { const l = multiLinks()[n - 1]; if (l) focusLink(l); }
  });
  renderDevices();
  renderGrid();
}

const multiLinks = () => (S.settings.devices || []).map((d) => devState.get(d.id)).filter((s) => s && s.link).map((s) => s.link);

export function onMultiShown() { renderDevices(); renderGrid(); }

async function addDevice() {
  const id = $('#mAddId').value.replace(/\D/g, '');
  const code = $('#mAddCode').value.trim();
  const name = $('#mAddName').value.trim();
  if (id.length < 6) return toast('請輸入正確的 ID', 'err');
  if (!code) return toast('請輸入被控端的固定授權碼', 'err');
  if (id === String(S.settings.deviceId)) return toast('不能加入自己', 'err');
  const list = S.settings.devices || [];
  if (list.length >= MAX_LINKS) return toast(`最多 ${MAX_LINKS} 台`, 'err');
  if (list.some((d) => d.id === id)) return toast('這台已經在清單中', 'err');
  S.settings = await S.saveSettings({ devices: [...list, { id, code, name }] });
  $('#mAddId').value = ''; $('#mAddCode').value = ''; $('#mAddName').value = '';
  renderDevices(); renderGrid();
  if (multiOn) connectDevice(id);
}

async function removeDevice(id) {
  const st = devState.get(id);
  if (st && st.link) closeLink(st.link, false);
  if (st && st.retry) clearTimeout(st.retry);
  devState.delete(id);
  S.settings = await S.saveSettings({ devices: (S.settings.devices || []).filter((d) => d.id !== id) });
  renderDevices(); renderGrid();
}

function scheduleReconnect(st) {
  clearTimeout(st.retry);
  st.state = '離線，15 秒後重試';
  renderDevices(); renderGrid();
  st.retry = setTimeout(() => { if (multiOn && device(st.id)) connectDevice(st.id); }, 15000);
}

async function connectDevice(id) {
  const st = device(id);
  if (!st || st.link || st.state === '連線中…') return;
  if (S.host) return toast('本機正在被遠端連線中，無法同時當主控端', 'err');
  clearTimeout(st.retry);
  st.state = '連線中…';
  renderDevices(); renderGrid();
  try {
    const link = await connectTo(id, st.dev.code, false, () => { st.state = '等待對方接受…'; renderDevices(); renderGrid(); });
    link.multi = true;
    st.link = link; st.state = '已連線';
    if (link.name && link.name !== st.dev.name && !st.dev.name) { st.dev.name = link.name; S.settings = await S.saveSettings({ devices: S.settings.devices }); }
    if (S.focus !== link) link.ch.send({ t: 'quality', q: 'thumb' });
  } catch (e) {
    st.state = '失敗：' + errMsg(e);
    if (multiOn && !/授權碼|拒絕/.test(st.state)) scheduleReconnect(st);
  }
  renderDevices(); renderGrid();
}

async function connectAll() {
  multiOn = true;
  const list = S.settings.devices || [];
  if (!list.length) return toast('請先在左側加入被控端', 'err');
  for (const d of list) { connectDevice(d.id); await sleep(250); }
}

function disconnectAll() {
  multiOn = false;
  for (const d of S.settings.devices || []) {
    const st = devState.get(d.id);
    if (!st) continue;
    clearTimeout(st.retry);
    if (st.link) closeLink(st.link, false);
    st.state = '未連線';
  }
  renderDevices(); renderGrid();
}

function renderDevices() {
  const ul = $('#mDevices');
  if (!ul) return;
  ul.innerHTML = '';
  const list = S.settings.devices || [];
  if (!list.length) ul.append(h('li', { class: 'muted small' }, '尚未加入任何被控端。被控端需在「設定」改用「固定授權碼」，並可關閉「連入需確認」以便無人值守。'));
  list.forEach((d, i) => {
    const st = device(d.id);
    const dot = st.link ? 'ok' : /失敗|離線|中斷/.test(st.state) ? 'bad' : /中|等待/.test(st.state) ? 'wait' : '';
    ul.append(h('li', {},
      h('span', { class: 'dot ' + dot }),
      h('span', { class: 'dn' }, h('b', {}, `${i + 1}. ${d.name || '未命名'}`), h('br'), h('span', { class: 'muted small' }, `${fmtId(d.id)}　${st.state}`)),
      st.link ? h('button', { onclick: () => focusLink(st.link), title: '放大操控' }, '🔍')
        : h('button', { onclick: () => { connectDevice(d.id); }, title: '連線' }, '🔌'),
      h('button', { onclick: () => removeDevice(d.id), title: '移除' }, '✖')));
  });
  $('#mCount').textContent = `${multiLinks().length} / ${list.length} 台已連線`;
}

function gridCols(n) {
  const v = $('#mLayout').value;
  if (v !== 'auto') return Number(v.split('x')[0]);
  return Math.max(1, Math.ceil(Math.sqrt(n)));
}

function renderGrid() {
  const grid = $('#mGrid');
  if (!grid) return;
  const list = S.settings.devices || [];
  const cols = gridCols(list.length);
  const rows = Math.max(1, Math.ceil(list.length / cols));
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
  // 保留既有 video 元素，避免每次重繪都重新播放
  const keep = new Map([...grid.querySelectorAll('.tile')].map((t) => [t.dataset.id, t]));
  grid.innerHTML = '';
  if (!list.length) { grid.append(h('div', { class: 'empty' }, '在左側加入被控端後按「全部連線」，畫面會在這裡分割顯示；點一下畫面即可放大操控。')); return; }
  list.forEach((d, i) => {
    const st = device(d.id);
    let tile = keep.get(d.id);
    if (!tile) {
      const v = h('video', { autoplay: true, playsinline: true, muted: true });
      tile = h('div', { class: 'tile', 'data-id': d.id }, v, h('div', { class: 'tlabel' }), h('div', { class: 'tstat' }), h('div', { class: 'tmsg' }));
      tile.addEventListener('click', () => { const s = devState.get(d.id); if (s && s.link) focusLink(s.link); else connectDevice(d.id); });
    }
    const v = tile.querySelector('video');
    const link = st.link;
    if (link) {
      link.tileVideo = v; link.tileStat = tile.querySelector('.tstat');
      if (link.stream && v.srcObject !== link.stream) { v.srcObject = link.stream; v.play().catch(() => {}); }
    } else v.srcObject = null;
    tile.querySelector('.tlabel').textContent = `${i + 1}　${d.name || fmtId(d.id)}${link && link.unread ? `　💬${link.unread}` : ''}`;
    tile.querySelector('.tstat').textContent = link ? link.stat : '';
    const msg = tile.querySelector('.tmsg');
    msg.textContent = link ? (link.stream ? '' : '等待畫面…') : st.state + (st.state === '未連線' ? '（點一下連線）' : '');
    tile.classList.toggle('off', !link);
    grid.append(tile);
  });
}

function updateTile(link) { if (link.multi && $('#view-multi').classList.contains('active')) renderGrid(); }

function broadcastText() {
  const inp = $('#mBroadcastText');
  const text = inp.value.trim();
  const links = multiLinks();
  if (!text) return;
  if (!links.length) return toast('目前沒有已連線的被控端', 'err');
  const ts = Date.now();
  for (const l of links) { l.ch.send({ t: 'chat', text: '📢 ' + text, ts }); l.chat.add({ who: 'me', text: '📢 ' + text, ts }); }
  inp.value = '';
  toast(`已廣播給 ${links.length} 台`, 'ok');
}

async function broadcastTeach() {
  const links = multiLinks();
  if (!links.length) return toast('目前沒有已連線的被控端', 'err');
  const ps = await xk.local.pickFiles({ multi: true, filters: [{ name: '簡報與圖片', extensions: ['pdf', 'pptx', 'ppt', 'ppsx', 'pps', 'odp', 'key', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'] }] });
  if (!ps.length) return;
  await broadcastDeck(ps);
}

export async function broadcastDeck(paths) {
  const links = multiLinks();
  $('#mTeachState').textContent = /\.(pptx?|ppsx?|odp|key)$/i.test(paths[0]) ? '轉檔中…' : '讀取中…';
  let deck;
  try { deck = await xk.teach.prepare(paths); } catch (e) { $('#mTeachState').textContent = ''; return toast(errMsg(e), 'err'); }
  await Promise.all(links.map((l) => l.teach.startDeckWith(deck).catch(() => {})));
  $('#mTeachState').textContent = `「${deck.name}」已推送給 ${links.length} 台`;
}

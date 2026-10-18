// 小柯機器人遠端連線：主畫面、被控端、主控端流程
import { $, $$, h, toast, modal, closeModal, errMsg, fmtId, fmtTime, randCode, sleep } from './util.js';
import { createPeer, Channel, peerIdOf, PREFIX } from './net.js';
import { ChatPanel, cropDialog } from './chat.js';
import { FileManager, serveHostFiles } from './files.js';
import { TeachController, TeachStudent } from './teach.js';

const xk = window.xk;
const S = {
  settings: null, info: null, peer: null, code: '', fails: 0, lockUntil: 0,
  host: null,   // 被控端工作階段
  client: null, // 主控端工作階段
  connecting: null,
};
window.__xk = S; // 自動化測試用

const OS_NAME = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
const INPUT_TYPES = ['mm', 'md', 'mu', 'wheel', 'kd', 'ku', 'combo'];

// ================= 開機 =================
async function boot() {
  S.settings = await xk.settings.get();
  S.info = await xk.sys.info();
  $('#aboutVer').textContent = 'v' + S.info.version;
  $('#aboutSys').textContent = `本機：${OS_NAME[S.info.platform] || S.info.platform}　鍵鼠控制模組：${S.info.inputAvailable ? '正常' : '無法載入（' + S.info.inputError + '）'}${S.info.profile ? '　設定檔：' + S.info.profile : ''}`;
  bindTabs();
  bindHome();
  bindFolders();
  bindSettings();
  bindSession();
  newCode();
  renderHome();
  checkMacPermissions();
  connectPeer();
}

function setNet(state, text) {
  const el = $('#netStat');
  el.className = 'netstat ' + state;
  el.querySelector('span').textContent = text;
}

async function connectPeer() {
  if (S.peer) { try { S.peer.destroy(); } catch {} S.peer = null; }
  setNet('', '連線 ID 伺服器中…');
  for (let attempt = 1; ; attempt++) {
    try {
      S.peer = await createPeer(S.settings);
      break;
    } catch (e) {
      if (e.type === 'unavailable-id' && attempt < 6) { setNet('bad', `ID 暫時被占用，重試中（${attempt}）…`); await sleep(4000); continue; }
      if (e.type === 'unavailable-id') {
        setNet('bad', '本機 ID 已被使用');
        const ok = await modal('本機 ID 已被使用', '可能有另一台電腦使用相同的 ID，或上次程式沒有正常結束。要產生新的 ID 嗎？', [{ label: '稍後重試', value: false }, { label: '產生新 ID', value: true, primary: true }]);
        if (ok) { S.settings.deviceId = await xk.settings.newDeviceId(); renderHome(); }
        attempt = 0; continue;
      }
      setNet('bad', '無法連線 ID 伺服器，10 秒後重試');
      await sleep(10000);
    }
  }
  setNet('ok', '已上線');
  const peer = S.peer;
  peer.on('connection', (conn) => onConnection(conn));
  peer.on('call', (call) => onCall(call));
  peer.on('disconnected', () => {
    if (S.peer !== peer || peer.destroyed) return;
    setNet('bad', 'ID 伺服器中斷，重新連線中…');
    setTimeout(() => { if (S.peer === peer && !peer.destroyed && peer.disconnected) peer.reconnect(); }, 2000);
  });
  peer.on('open', () => { if (S.peer === peer) setNet('ok', '已上線'); });
  peer.on('error', (e) => {
    console.warn('peer error', e.type, e);
    if (e.type === 'peer-unavailable' && S.connecting) S.connecting.fail(new Error('找不到這個 ID，或對方目前不在線上'));
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) setNet('bad', 'ID 伺服器連線異常');
  });
}

// ================= 介面：分頁、首頁 =================
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#mainTabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.body.classList.toggle('in-session', name === 'session' || name === 'hosting');
}
function bindTabs() { $$('#mainTabs button').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view))); }

function newCode() { S.code = randCode(6); }
function expectedCode() { return S.settings.codeMode === 'fixed' && S.settings.fixedCode ? S.settings.fixedCode : S.code; }

function renderHome() {
  $('#myId').textContent = fmtId(S.settings.deviceId);
  const fixed = S.settings.codeMode === 'fixed' && S.settings.fixedCode;
  $('#myCode').textContent = fixed ? '••••••（固定）' : S.code;
  $('#refreshCode').classList.toggle('hidden', !!fixed);
  $('#copyCode').classList.toggle('hidden', !!fixed);
  $('#codeHint').textContent = fixed ? '目前使用固定授權碼（可在「設定」修改）。' : '授權碼在每次連線結束後會自動更換。';
  const ul = $('#recentList');
  ul.innerHTML = '';
  for (const r of S.settings.recent || []) {
    ul.append(h('li', { onclick: () => { $('#remoteId').value = fmtId(r.id); $('#remoteCode').focus(); } },
      h('span', {}, h('span', { class: 'id' }, fmtId(r.id)), '　', h('span', { class: 'muted' }, r.name || '')), h('span', { class: 'muted small' }, new Date(r.ts).toLocaleDateString('zh-TW'))));
  }
  if (!ul.children.length) ul.append(h('li', { class: 'muted' }, '（尚無）'));
}

function bindHome() {
  $('#copyId').onclick = () => { xk.clip.write(String(S.settings.deviceId)); toast('已複製 ID'); };
  $('#copyCode').onclick = () => { xk.clip.write(S.code); toast('已複製授權碼'); };
  $('#refreshCode').onclick = () => { newCode(); renderHome(); };
  $('#btnConnect').onclick = () => startClient(false);
  $('#btnConnectView').onclick = () => startClient(true);
  $('#remoteCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') startClient(false); });
  $('#remoteId').addEventListener('input', (e) => { const v = fmtId(e.target.value).slice(0, 15); if (v !== e.target.value) e.target.value = v; });
}

async function checkMacPermissions() {
  if (S.info.platform !== 'darwin') return;
  const p = await xk.sys.permissions(false);
  const box = $('#permWarn');
  box.innerHTML = '';
  const miss = [];
  if (p.screen !== 'granted') miss.push(['screen', '螢幕錄製（被控端分享畫面需要）']);
  if (!p.accessibility) miss.push(['accessibility', '輔助使用（被控端接受滑鼠鍵盤控制需要）']);
  if (!miss.length) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  box.append(h('b', {}, '⚠️ macOS 權限尚未開啟：'), h('br'));
  for (const [k, label] of miss) box.append(h('div', {}, '・' + label, h('button', { onclick: async () => { if (k === 'accessibility') await xk.sys.permissions(true); xk.sys.openPrivacy(k); } }, '前往設定')));
  box.append(h('div', { class: 'small muted' }, '開啟後請重新啟動本程式。'));
}

// ================= 資料夾授權 =================
function bindFolders() {
  $('#addFolder').onclick = async () => {
    const p = await xk.local.pickFolder();
    if (!p) return;
    if ((S.settings.folders || []).some((f) => f.path === p)) return toast('這個資料夾已經在清單中');
    await saveFolders([...(S.settings.folders || []), { path: p, perm: 'r' }]);
  };
  $('#addInstallFolder').onclick = async () => {
    const p = await xk.folders.installArea();
    if ((S.settings.folders || []).some((f) => f.path === p)) return toast('「遠端安裝區」已經授權');
    await saveFolders([...(S.settings.folders || []), { path: p, perm: 'rw', name: '遠端安裝區' }]);
    toast('已建立並授權：' + p, 'ok');
  };
  renderFolders();
}
async function saveFolders(list) { S.settings = await xk.settings.set({ folders: list }); renderFolders(); }
function renderFolders() {
  const tb = $('#folderRows');
  tb.innerHTML = '';
  const list = S.settings.folders || [];
  if (!list.length) tb.append(h('tr', {}, h('td', { colspan: 3, class: 'muted' }, '尚未授權任何資料夾，主控端將無法存取檔案。')));
  list.forEach((f, i) => {
    const sel = h('select', {}, ...[['r', '可讀'], ['w', '可寫'], ['rw', '可讀寫']].map(([v, t]) => h('option', { value: v, selected: f.perm === v }, t)));
    sel.onchange = () => { const l = [...list]; l[i] = { ...f, perm: sel.value }; saveFolders(l); };
    tb.append(h('tr', {}, h('td', { class: 'path' }, f.name ? h('b', {}, f.name + '　') : '', f.path), h('td', {}, sel),
      h('td', {}, h('button', { onclick: () => saveFolders(list.filter((_, j) => j !== i)) }, '移除'))));
  });
}

// ================= 設定 =================
function bindSettings() {
  const s = () => S.settings;
  const fill = () => {
    $('#setName').value = s().deviceName;
    $('#setConfirm').checked = s().confirmIncoming;
    $('#setAllowControl').checked = s().allowControl;
    $('#setCodeMode').value = s().codeMode;
    $('#setFixedCode').value = s().fixedCode || '';
    $('#setTray').checked = s().closeToTray;
    $('#setSwap').checked = s().swapMods;
    $('#setQuality').value = s().quality;
    $('#setServerMode').value = s().server.mode;
    $('#setHost').value = s().server.host; $('#setPort').value = s().server.port; $('#setPath').value = s().server.path; $('#setKey').value = s().server.key; $('#setSecure').checked = s().server.secure;
    $('#setStun').value = s().stun;
    $('#setTurnUrl').value = s().turn.urls; $('#setTurnUser').value = s().turn.username; $('#setTurnPass').value = s().turn.credential;
    toggle();
  };
  const toggle = () => {
    $('#fixedCodeRow').classList.toggle('hidden', $('#setCodeMode').value !== 'fixed');
    $('#customServer').classList.toggle('hidden', $('#setServerMode').value !== 'custom');
  };
  $('#setCodeMode').onchange = toggle;
  $('#setServerMode').onchange = toggle;
  $('#saveSettings').onclick = async () => {
    const fixed = $('#setFixedCode').value.trim();
    if ($('#setCodeMode').value === 'fixed' && fixed.length < 6) return toast('固定授權碼至少 6 碼', 'err');
    const before = JSON.stringify([s().server, s().stun, s().turn]);
    S.settings = await xk.settings.set({
      deviceName: $('#setName').value.trim() || S.info.hostname,
      confirmIncoming: $('#setConfirm').checked,
      allowControl: $('#setAllowControl').checked,
      codeMode: $('#setCodeMode').value,
      fixedCode: fixed,
      closeToTray: $('#setTray').checked,
      swapMods: $('#setSwap').checked,
      quality: $('#setQuality').value,
      server: { mode: $('#setServerMode').value, host: $('#setHost').value.trim(), port: Number($('#setPort').value) || 9000, path: $('#setPath').value.trim() || '/', key: $('#setKey').value.trim() || 'peerjs', secure: $('#setSecure').checked },
      stun: $('#setStun').value.trim(),
      turn: { urls: $('#setTurnUrl').value.trim(), username: $('#setTurnUser').value.trim(), credential: $('#setTurnPass').value },
    });
    renderHome();
    toast('設定已儲存', 'ok');
    if (before !== JSON.stringify([s().server, s().stun, s().turn]) && !S.host && !S.client) connectPeer();
  };
  $('#newDeviceId').onclick = async () => {
    if (S.host || S.client) return toast('連線中無法更換 ID', 'err');
    const ok = await modal('重新產生本機 ID', '更換後，對方需要使用新的 ID 才能連到這台電腦。確定嗎？', [{ label: '取消', value: false }, { label: '更換', value: true, primary: true }]);
    if (!ok) return;
    S.settings.deviceId = await xk.settings.newDeviceId();
    renderHome();
    connectPeer();
  };
  fill();
}

// ================= 連線分派 =================
function onConnection(conn) {
  if (conn.label === 'xk-file') {
    const sess = S.host && S.host.remotePeer === conn.peer ? S.host : null;
    if (!sess) { conn.on('open', () => conn.close()); return; }
    conn.on('open', () => sess.ch.attachFile(conn));
    return;
  }
  if (conn.label !== 'xk-ctl') { conn.close(); return; }
  conn.on('open', () => hostHandshake(conn));
}

function onCall(call) {
  const kind = call.metadata && call.metadata.kind;
  const sess = [S.host, S.client].find((s) => s && s.remotePeer === call.peer);
  if (kind === 'screen' && S.client && S.client.remotePeer === call.peer) return S.client.onScreen(call);
  if (kind === 'screen' && S.connecting && S.connecting.remotePeer === call.peer) { S.connecting.pendingScreen = call; return; }
  if (kind === 'voice' && sess) return sess.chat.onVoiceCall(call);
  if (kind === 'teach-screen' && S.host && S.host.remotePeer === call.peer) return S.host.student.onScreenCall(call);
  call.close();
}

// ================= 被控端 =================
function hostHandshake(conn) {
  const ch = new Channel(conn);
  let decided = false;
  const timer = setTimeout(() => { if (!decided) ch.close(); }, 90000);
  ch.on('hello', async (m) => {
    if (decided) return;
    decided = true;
    const fail = (reason) => { clearTimeout(timer); ch.send({ t: 'auth-fail', reason }); setTimeout(() => ch.close(), 300); };
    if (S.host || S.client) return fail('對方目前正在另一個遠端連線中');
    if (Date.now() < S.lockUntil) return fail('授權碼錯誤次數過多，請 1 分鐘後再試');
    if (String(m.code || '').trim().toUpperCase() !== expectedCode().toUpperCase()) {
      if (++S.fails >= 5) { S.fails = 0; S.lockUntil = Date.now() + 60000; }
      hostState(`有人以錯誤的授權碼嘗試連線（${fmtTime(Date.now())}）`);
      return fail('授權碼錯誤');
    }
    S.fails = 0;
    if (S.settings.confirmIncoming) {
      xk.win.attention('遠端連線要求', `${m.name} 想要連線到這台電腦`);
      ch.send({ t: 'auth-wait' });
      const ok = await modal('遠端連線要求',
        h('div', {}, h('p', {}, h('b', {}, m.name || '對方'), `（${OS_NAME[m.os] || m.os}，ID ${fmtId(String(conn.peer).replace(PREFIX, ''))}）想要${m.viewOnly ? '檢視' : '操控'}這台電腦。`), h('p', { class: 'muted small' }, '30 秒內未回應將自動拒絕。')),
        [{ label: '拒絕', value: false }, { label: '接受', value: true, primary: true }], { timeout: 30000, timeoutValue: false });
      if (!ok || ch.closed) return fail('被控端拒絕連線');
    }
    clearTimeout(timer);
    startHosting(ch, conn, m).catch((e) => { toast('無法開始分享畫面：' + errMsg(e), 'err'); fail('被控端無法分享畫面：' + errMsg(e)); endHosting(); });
  });
  ch.on('close', () => clearTimeout(timer));
}

function hostState(text) { $('#hostState').textContent = text; }

async function captureDisplay(src, quality) {
  const w = Math.round(src.width * src.scale), hh = Math.round(src.height * src.scale);
  const k = Math.min(1, 2560 / w);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: Math.round(w * k), maxHeight: Math.round(hh * k), minFrameRate: 5, maxFrameRate: quality === 'high' ? 20 : 30 } },
  });
  const t = stream.getVideoTracks()[0];
  t.contentHint = quality === 'smooth' ? 'motion' : 'detail';
  return stream;
}

async function tuneSender(call, quality) {
  const pc = call.peerConnection;
  if (!pc) return;
  for (const s of pc.getSenders()) {
    if (!s.track || s.track.kind !== 'video') continue;
    const p = s.getParameters();
    p.encodings = p.encodings && p.encodings.length ? p.encodings : [{}];
    p.encodings[0].maxBitrate = quality === 'high' ? 10e6 : quality === 'smooth' ? 4e6 : 6e6;
    p.degradationPreference = quality === 'smooth' ? 'maintain-framerate' : 'maintain-resolution';
    try { await s.setParameters(p); } catch (e) { console.warn(e); }
  }
}

async function startHosting(ch, conn, hello) {
  const sources = await xk.cap.sources();
  if (!sources.length) throw new Error('找不到可分享的螢幕');
  let src = sources.find((s) => s.primary) || sources[0];
  let quality = S.settings.quality;
  let stream = await captureDisplay(src, quality);
  await xk.input.setDisplay(src.displayId);
  const allow = S.settings.allowControl && !hello.viewOnly;
  await xk.input.session(allow ? { remoteOs: hello.os } : null);

  const sess = S.host = {
    ch, remotePeer: conn.peer, name: hello.name || '對方', os: hello.os, allow, call: null,
    log: (t) => { const d = h('div', {}, `${fmtTime(Date.now())}　${t}`); $('#hLog').prepend(d); },
  };
  ch.send({ t: 'auth-ok', name: S.settings.deviceName, os: S.info.platform, allow, inputOk: S.info.inputAvailable, displays: sources.map((s) => ({ id: s.displayId, name: s.name, w: s.width, h: s.height, primary: s.primary })), current: src.displayId });

  const callRemote = () => {
    const call = S.peer.call(conn.peer, stream, { metadata: { kind: 'screen' } });
    sess.call = call;
    call.on('stream', () => {});
    const pc = call.peerConnection;
    if (pc) pc.addEventListener('connectionstatechange', () => { if (pc.connectionState === 'connected') tuneSender(call, quality); });
  };
  callRemote();

  // 遠端輸入
  for (const t of INPUT_TYPES) ch.on(t, (m) => { if (sess.allow) xk.input.event(m); });
  ch.on('display', async (m) => {
    const ns = sources.find((s) => s.displayId === String(m.id));
    if (!ns) return;
    try {
      const old = stream;
      stream = await captureDisplay(ns, quality);
      src = ns;
      const sender = sess.call.peerConnection.getSenders().find((s) => s.track && s.track.kind === 'video');
      await sender.replaceTrack(stream.getVideoTracks()[0]);
      old.getTracks().forEach((t) => t.stop());
      await xk.input.setDisplay(ns.displayId);
      ch.send({ t: 'display-ok', id: ns.displayId });
    } catch (e) { ch.send({ t: 'notice', text: '切換螢幕失敗：' + errMsg(e) }); }
  });
  ch.on('quality', async (m) => {
    quality = m.q;
    const t = stream.getVideoTracks()[0];
    t.contentHint = quality === 'smooth' ? 'motion' : 'detail';
    tuneSender(sess.call, quality);
  });
  ch.on('clip-set', (m) => { xk.clip.write(m.text); sess.log('對方傳來剪貼簿文字'); });
  ch.serve('clip-get', () => xk.clip.read());
  serveHostFiles(ch, sess.log, () => sess.name);

  // 聊天、教學
  sess.chat = new ChatPanel($('#hostChat'), {
    peer: S.peer, remotePeerId: () => conn.peer, myName: S.settings.deviceName, remoteName: () => sess.name,
    displayId: () => src.displayId, isVisible: () => true,
  });
  sess.chat.attach(ch);
  sess.student = new TeachStudent({ log: sess.log });
  sess.student.attach(ch);

  // 畫面
  $('#hTitle').textContent = `${sess.name} 正在${allow ? '遠端操控' : '檢視'}這台電腦`;
  $('#hAllow').checked = allow;
  $('#hAllow').disabled = !S.settings.allowControl || hello.viewOnly;
  const updCtl = () => { $('#hCtl').textContent = sess.allow ? '可操控' : '僅檢視'; $('#hCtlText').textContent = sess.allow ? '並操作滑鼠鍵盤' : '（目前不能操作滑鼠鍵盤）'; };
  updCtl();
  $('#hAllow').onchange = async () => {
    sess.allow = $('#hAllow').checked;
    await xk.input.session(sess.allow ? { remoteOs: sess.os } : null);
    ch.send({ t: 'ctl-state', allow: sess.allow });
    updCtl();
  };
  $('#hClose').onclick = () => ch.close();
  $('#hLog').innerHTML = '';
  sess.log(`${sess.name}（${OS_NAME[sess.os] || sess.os}）已連線`);
  sess.chat.sys(`已與 ${sess.name} 連線`);
  showView('hosting');
  hostState(`${sess.name} 連線中`);
  ch.on('close', () => endHosting());
  sess.stopStream = () => stream.getTracks().forEach((t) => t.stop());
}

function endHosting() {
  const sess = S.host;
  if (!sess) return;
  S.host = null;
  try { sess.stopStream && sess.stopStream(); } catch {}
  try { sess.call && sess.call.close(); } catch {}
  try { sess.chat && sess.chat.endVoice(false); } catch {}
  try { sess.student && sess.student.close(); } catch {}
  xk.input.session(null);
  closeModal(false);
  if (S.settings.codeMode !== 'fixed') newCode();
  renderHome();
  showView('home');
  hostState(`上次連線：${sess.name}，於 ${fmtTime(Date.now())} 結束`);
  toast(`${sess.name} 已中斷連線`);
}

// ================= 主控端 =================
async function startClient(viewOnly) {
  if (S.client || S.connecting) return;
  if (S.host) return toast('本機正在被遠端連線中', 'err');
  if (!S.peer || S.peer.disconnected) return toast('尚未連上 ID 伺服器，請稍候', 'err');
  const id = $('#remoteId').value.replace(/\D/g, '');
  const code = $('#remoteCode').value.trim();
  if (id.length < 6) return toast('請輸入正確的遠端 ID', 'err');
  if (!code) return toast('請輸入授權碼', 'err');
  if (id === String(S.settings.deviceId)) return toast('不能連線到自己', 'err');
  const remotePeer = peerIdOf(id);
  const btn = $('#btnConnect');
  btn.disabled = true; btn.textContent = '連線中…';
  let ch = null;
  const pending = S.connecting = { remotePeer };
  try {
    const result = await new Promise((resolve, reject) => {
      pending.fail = reject;
      const timer = setTimeout(() => reject(new Error('連線逾時，請確認對方在線上，或在設定中加入 TURN 中繼伺服器')), 25000);
      const conn = S.peer.connect(remotePeer, { label: 'xk-ctl', reliable: true, serialization: 'binary' });
      conn.on('error', (e) => reject(e));
      conn.on('open', () => {
        ch = new Channel(conn);
        ch.send({ t: 'hello', code, name: S.settings.deviceName, os: S.info.platform, viewOnly, ver: S.info.version });
        ch.on('auth-wait', () => { clearTimeout(timer); btn.textContent = '等待對方接受…'; setTimeout(() => reject(new Error('對方沒有回應')), 40000); });
        ch.on('auth-ok', (m) => { clearTimeout(timer); resolve(m); });
        ch.on('auth-fail', (m) => { clearTimeout(timer); reject(new Error(m.reason)); });
        ch.on('close', () => reject(new Error('連線被對方關閉')));
      });
    });
    S.connecting = null;
    const recent = [{ id, name: result.name, ts: Date.now() }, ...(S.settings.recent || []).filter((r) => r.id !== id)].slice(0, 8);
    S.settings = await xk.settings.set({ recent });
    renderHome();
    openClientSession(ch, remotePeer, result, viewOnly, pending.pendingScreen);
  } catch (e) {
    S.connecting = null;
    if (ch) ch.close();
    toast('連線失敗：' + errMsg(e), 'err');
  } finally {
    btn.disabled = false; btn.textContent = '連線並操控';
  }
}

function openClientSession(ch, remotePeer, info, viewOnly, pendingScreen) {
  const video = $('#rvideo');
  const vwrap = $('#vwrap');
  const sess = S.client = { ch, remotePeer, name: info.name, os: info.os, allow: info.allow, viewOnly, screenCall: null, timers: [] };
  // 第二條資料通道專門傳檔，避免大檔案卡住滑鼠鍵盤
  const fconn = S.peer.connect(remotePeer, { label: 'xk-file', reliable: true, serialization: 'binary' });
  fconn.on('open', () => ch.attachFile(fconn));

  $('#sTitle').textContent = `${info.name}（${OS_NAME[info.os] || info.os}）`;
  $('#stageMsg').textContent = '等待遠端畫面…';
  $('#stageMsg').classList.remove('hidden');
  const sel = $('#sDisplay');
  sel.innerHTML = '';
  info.displays.forEach((d, i) => sel.append(h('option', { value: d.id, selected: d.id === info.current }, `螢幕 ${i + 1}${d.primary ? '（主）' : ''} ${d.w}×${d.h}`)));
  sel.classList.toggle('hidden', info.displays.length < 2);
  sel.onchange = () => ch.send({ t: 'display', id: sel.value });
  ch.on('display-ok', () => toast('已切換螢幕'));
  ch.on('notice', (m) => toast(m.text));
  ch.on('ctl-state', (m) => { sess.allow = m.allow; updControl(); toast(m.allow ? '對方已允許操控' : '對方暫停了操控，目前僅能檢視'); });

  // 特殊鍵
  const keys = $('#sKeys');
  keys.innerHTML = '';
  const combos = info.os === 'darwin'
    ? [['⌘ Command', ['MetaLeft']], ['⌘ + Space（Spotlight）', ['MetaLeft', 'Space']], ['⌘ + Tab', ['MetaLeft', 'Tab']], ['⌘ + Q', ['MetaLeft', 'KeyQ']], ['⌥⌘ + Esc（強制結束）', ['AltLeft', 'MetaLeft', 'Escape']], ['⌘⇧ + 3（截圖）', ['MetaLeft', 'ShiftLeft', 'Digit3']]]
    : [['Win 鍵（開始）', ['MetaLeft']], ['Ctrl + Shift + Esc（工作管理員）', ['ControlLeft', 'ShiftLeft', 'Escape']], ['Alt + Tab', ['AltLeft', 'Tab']], ['Alt + F4', ['AltLeft', 'F4']], ['Win + D（顯示桌面）', ['MetaLeft', 'KeyD']], ['Win + E（檔案總管）', ['MetaLeft', 'KeyE']], ['Win + R（執行）', ['MetaLeft', 'KeyR']], ['Print Screen', ['PrintScreen']]];
  for (const [label, codes] of combos) keys.append(h('button', { onclick: () => canControl() && ch.send({ t: 'combo', codes, raw: true }) }, label));

  // 聊天、檔案、教學
  sess.chat = new ChatPanel($('#ctrlChat'), {
    peer: S.peer, remotePeerId: () => remotePeer, myName: S.settings.deviceName, remoteName: () => sess.name,
    displayId: () => null, isVisible: () => activePane() === 'chat' && !$('#drawer').classList.contains('collapsed'),
    onUnread: (n) => { const b = $('#chatBadge'); b.textContent = n; b.classList.toggle('hidden', !n); },
  });
  sess.chat.attach(ch);
  sess.files = new FileManager($('#ctrlFiles'));
  sess.files.attach(ch);
  sess.teach = new TeachController($('#ctrlTeach'), $('#teachHostStage'), {
    peer: S.peer, remotePeerId: () => remotePeer,
    showStage: (on) => { $('#teachHostStage').classList.toggle('hidden', !on); },
  });
  sess.teach.attach(ch);
  setPane('chat');
  sess.chat.sys(`已連線到 ${info.name}${viewOnly ? '（僅檢視）' : ''}`);
  if (!viewOnly && !info.allow) sess.chat.sys('對方設定為不允許操控，目前僅能檢視');
  if (!viewOnly && info.allow && info.inputOk === false) sess.chat.sys('⚠️ 對方的鍵鼠控制模組無法載入，可能無法操控');
  if (info.os === 'darwin' && !viewOnly) sess.chat.sys('提示：對方是 Mac，需在「系統設定 › 隱私權與安全性」開啟「螢幕錄製」與「輔助使用」才能看到畫面與操控。');

  // 畫面
  sess.onScreen = (call) => {
    sess.screenCall = call;
    call.answer();
    call.on('stream', (s) => { video.srcObject = s; video.play().catch(() => {}); $('#stageMsg').classList.add('hidden'); });
    call.on('close', () => { if (S.client === sess) { $('#stageMsg').textContent = '遠端畫面已停止'; $('#stageMsg').classList.remove('hidden'); } });
  };
  if (pendingScreen) sess.onScreen(pendingScreen);
  ch.send({ t: 'quality', q: S.settings.quality });

  // 狀態列
  let lastBytes = 0, lastTs = 0;
  sess.timers.push(setInterval(async () => {
    const pc = sess.screenCall && sess.screenCall.peerConnection;
    if (!pc) return;
    const st = await pc.getStats();
    let fps = 0, bytes = 0, w = 0, hh = 0, route = '';
    const pairs = {};
    st.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'video') { fps = r.framesPerSecond || 0; bytes = r.bytesReceived; w = r.frameWidth; hh = r.frameHeight; }
      if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') pairs.sel = r;
    });
    if (pairs.sel) { const lc = st.get(pairs.sel.localCandidateId); route = lc && lc.candidateType === 'relay' ? '中繼' : '直連'; }
    const now = Date.now();
    const rate = lastTs ? ((bytes - lastBytes) * 8 / ((now - lastTs) / 1000) / 1e6).toFixed(1) : '0';
    lastBytes = bytes; lastTs = now;
    $('#sStat').textContent = `${route} · ${w}×${hh} · ${Math.round(fps)}fps · ${rate}Mbps`;
  }, 2000));

  // 操控
  const canControl = () => !viewOnly && sess.allow && $('#sControl').checked && S.client === sess;
  const updControl = () => {
    $('#sControl').disabled = viewOnly || !sess.allow;
    $('#sControl').checked = !viewOnly && sess.allow && $('#sControl').checked;
    vwrap.classList.toggle('control', canControl());
  };
  $('#sControl').checked = !viewOnly;
  updControl();
  $('#sControl').onchange = updControl;
  bindVideoInput(sess, video, canControl);

  ch.on('close', () => endClient());
  showView('session');
  video.focus();
}

function bindVideoInput(sess, video, canControl) {
  const send = (m) => { if (canControl()) sess.ch.send(m); };
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
  sess.unbind = [];
  const on = (el, ev, fn, opt) => { el.addEventListener(ev, fn, opt); sess.unbind.push(() => el.removeEventListener(ev, fn, opt)); };
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
    if (!canControl() || isTyping(e) || !$('#teachHostStage').classList.contains('hidden')) return;
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
  const releaseAll = () => { for (const c of held) sess.ch.send({ t: 'ku', code: c }); held.clear(); };
  on(window, 'blur', releaseAll);
  on(video, 'blur', releaseAll);
}

function activePane() { const b = $('#drawer .dtabs button.active'); return b && b.dataset.pane; }
function setPane(name) {
  $$('#drawer .dtabs button').forEach((b) => b.classList.toggle('active', b.dataset.pane === name));
  $$('#drawer .pane').forEach((p) => p.classList.toggle('active', p.dataset.pane === name));
  if (name === 'chat' && S.client) S.client.chat.clearUnread();
}

function bindSession() {
  $$('#drawer .dtabs button').forEach((b) => b.addEventListener('click', () => {
    const d = $('#drawer');
    if (d.classList.contains('collapsed')) d.classList.remove('collapsed');
    setPane(b.dataset.pane);
  }));
  $('#sClose').onclick = () => S.client && S.client.ch.close();
  $('#sFit').onclick = () => $('#vwrap').classList.toggle('actual');
  let full = false;
  $('#sFull').onclick = () => { full = !full; xk.win.fullscreen(full); $('#drawer').classList.toggle('collapsed', full); };
  $('#sClipSend').onclick = async () => {
    if (!S.client) return;
    const text = await xk.clip.read();
    if (!text) return toast('本機剪貼簿沒有文字');
    S.client.ch.send({ t: 'clip-set', text });
    toast('已把剪貼簿文字送到遠端，可在遠端按貼上');
  };
  $('#sClipGet').onclick = async () => {
    if (!S.client) return;
    try { const t = await S.client.ch.request('clip-get', [], 10000); await xk.clip.write(t || ''); toast(t ? '已取得遠端剪貼簿文字' : '遠端剪貼簿沒有文字'); } catch (e) { toast(errMsg(e), 'err'); }
  };
  $('#sShot').onclick = async () => {
    const v = $('#rvideo');
    if (!S.client || !v.videoWidth) return toast('尚未收到遠端畫面', 'err');
    const c = document.createElement('canvas');
    c.width = v.videoWidth; c.height = v.videoHeight;
    c.getContext('2d').drawImage(v, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const cropped = await cropDialog(blob, '擷取遠端畫面');
    if (cropped && S.client) { await S.client.chat.sendImageBlob(cropped, `遠端畫面_${Date.now()}.png`); setPane('chat'); }
  };
}

function endClient() {
  const sess = S.client;
  if (!sess) return;
  S.client = null;
  sess.timers.forEach(clearInterval);
  (sess.unbind || []).forEach((f) => f());
  try { sess.screenCall && sess.screenCall.close(); } catch {}
  try { sess.chat.endVoice(false); } catch {}
  try { sess.teach.end(false, true); } catch {}
  const v = $('#rvideo'); v.srcObject = null;
  $('#sStat').textContent = '';
  closeModal(false);
  xk.win.fullscreen(false);
  $('#drawer').classList.remove('collapsed');
  showView('home');
  toast(`與 ${sess.name} 的連線已結束`);
}

boot().catch((e) => { console.error(e); toast('啟動失敗：' + errMsg(e), 'err', 15000); });

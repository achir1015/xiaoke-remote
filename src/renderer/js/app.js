// 小柯機器人遠端連線：主畫面、被控端、主控端流程
import { $, $$, h, toast, modal, closeModal, errMsg, fmtId, fmtTime, randCode, sleep } from './util.js';
import { createPeer, Channel, peerIdOf, PREFIX } from './net.js';
import { ChatPanel } from './chat.js';
import { serveHostFiles } from './files.js';
import { TeachStudent } from './teach.js';
import { initClient, startClient, hasLinks, onClientCall, onPeerError, onMultiShown } from './client.js';

const xk = window.xk;
const S = {
  settings: null, info: null, peer: null, code: '', fails: 0, lockUntil: 0,
  host: null,   // 被控端工作階段（主控端的連線在 client.js 的 S.links）
};
S.saveSettings = (patch) => xk.settings.set(patch);
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
  initClient(S, { showView, renderHome });
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
    if (e.type === 'peer-unavailable') onPeerError(e);
    else if (['network', 'server-error', 'socket-error', 'socket-closed'].includes(e.type)) setNet('bad', 'ID 伺服器連線異常');
  });
}

// ================= 介面：分頁、首頁 =================
function showView(name) {
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  $$('#mainTabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.body.classList.toggle('in-session', name === 'session' || name === 'hosting');
  if (name === 'multi') onMultiShown();
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
    $('#setAutoMin').checked = s().autoMinimize !== false;
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
      autoMinimize: $('#setAutoMin').checked,
      swapMods: $('#setSwap').checked,
      quality: $('#setQuality').value,
      server: { mode: $('#setServerMode').value, host: $('#setHost').value.trim(), port: Number($('#setPort').value) || 9000, path: $('#setPath').value.trim() || '/', key: $('#setKey').value.trim() || 'peerjs', secure: $('#setSecure').checked },
      stun: $('#setStun').value.trim(),
      turn: { urls: $('#setTurnUrl').value.trim(), username: $('#setTurnUser').value.trim(), credential: $('#setTurnPass').value },
    });
    renderHome();
    toast('設定已儲存', 'ok');
    if (before !== JSON.stringify([s().server, s().stun, s().turn]) && !S.host && !hasLinks()) connectPeer();
  };
  $('#newDeviceId').onclick = async () => {
    if (S.host || hasLinks()) return toast('連線中無法更換 ID', 'err');
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
  if (onClientCall(call)) return;
  if (kind === 'voice' && S.host && S.host.remotePeer === call.peer) return S.host.chat.onVoiceCall(call);
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
    if (S.host || hasLinks()) return fail('對方目前正在另一個遠端連線中');
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
    const enc = p.encodings[0];
    if (quality === 'thumb') {
      // 多台分割畫面的縮圖：約 640 寬、5fps、350kbps，20 台合計約 7Mbps
      const w = (s.track.getSettings && s.track.getSettings().width) || 1920;
      enc.scaleResolutionDownBy = Math.max(1, w / 640);
      enc.maxBitrate = 350e3;
      enc.maxFramerate = 5;
    } else {
      enc.scaleResolutionDownBy = 1;
      enc.maxFramerate = 30;
      enc.maxBitrate = quality === 'high' ? 10e6 : quality === 'smooth' ? 4e6 : 6e6;
    }
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
  $('#hMin').onclick = () => xk.win.minimize();
  $('#hLog').innerHTML = '';
  sess.log(`${sess.name}（${OS_NAME[sess.os] || sess.os}）已連線`);
  sess.chat.sys(`已與 ${sess.name} 連線`);
  showView('hosting');
  hostState(`${sess.name} 連線中`);
  // 自動縮小，主控端第一眼看到的就是被控端桌面；有聊天、檔案、語音邀請、教學時會自動再開啟
  if (S.settings.autoMinimize !== false) setTimeout(() => { if (S.host === sess) xk.win.minimize(); }, 600);
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
  xk.win.restore();
  hostState(`上次連線：${sess.name}，於 ${fmtTime(Date.now())} 結束`);
  toast(`${sess.name} 已中斷連線`);
}

boot().catch((e) => { console.error(e); toast('啟動失敗：' + errMsg(e), 'err', 15000); });

// 端對端測試：在同一台電腦開兩個實例（A=主控端、B=被控端），透過本機自架伺服器連線，測試全部功能。
// 用法：node e2e/run.mjs <測試資料夾（內含 deck.pdf、big.bin）>
// 滑鼠鍵盤使用 --dry-input（只記錄、不真的移動本機滑鼠）。
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.resolve(process.argv[2] || path.join(ROOT, 'e2e', 'fixtures'));
const PORT = 9123;
const appData = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support');
const results = [];
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name, extra]); console.log(cond ? '✅' : '❌', name, extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 20000, step = 200) { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

// 1. 伺服器
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await sleep(1500);

// 2. 兩個設定檔
const share = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-share-'));
fs.writeFileSync(path.join(share, 'hello.txt'), '你好，小柯！');
fs.copyFileSync(path.join(FIX, 'big.bin'), path.join(share, 'big.bin'));
const base = { server: { mode: 'custom', host: '127.0.0.1', port: PORT, path: '/', key: 'peerjs', secure: false }, stun: '', closeToTray: false };
const prof = {
  e2eA: { ...base, deviceId: '111222333', deviceName: '主控端A' },
  e2eB: { ...base, deviceId: '444555666', deviceName: '被控端B', confirmIncoming: false, folders: [{ path: share, perm: 'rw' }] },
};
for (const [p, s] of Object.entries(prof)) {
  const dir = path.join(appData, 'xiaoke-remote-' + p);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s));
}
const launch = (p) => electron.launch({ args: [ROOT, `--profile=${p}`, '--dry-input', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], cwd: ROOT });
const A = await launch('e2eA');
const B = await launch('e2eB');
const a = await A.firstWindow();
const b = await B.firstWindow();
const logs = [];
for (const [n, w] of [['A', a], ['B', b]]) w.on('console', (m) => { if (['error', 'warning'].includes(m.type())) logs.push(`[${n}] ${m.text()}`); });

try {
  ok('A 上線', await until(() => a.evaluate(() => document.querySelector('#netStat').classList.contains('ok'))));
  ok('B 上線', await until(() => b.evaluate(() => document.querySelector('#netStat').classList.contains('ok'))));
  const code = await b.evaluate(() => window.__xk.code);

  // 錯誤授權碼
  await a.fill('#remoteId', '444 555 666');
  await a.fill('#remoteCode', 'WRONG1');
  await a.click('#btnConnect');
  ok('錯誤授權碼被拒絕', await until(() => a.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('授權碼錯誤')))));

  // 正確連線
  await a.fill('#remoteCode', code);
  await a.click('#btnConnect');
  ok('A 進入遠端工作階段', await until(() => a.evaluate(() => document.querySelector('#view-session').classList.contains('active'))));
  ok('B 顯示被連線中', await until(() => b.evaluate(() => document.querySelector('#view-hosting').classList.contains('active'))));
  const vw = await until(() => a.evaluate(() => document.querySelector('#rvideo').videoWidth || 0), 20000);
  ok('A 收到遠端畫面', vw > 0, `寬 ${vw}`);
  await a.screenshot({ path: path.join(FIX, 'shot-controller.png') });

  // 遠端操控
  const box = await a.locator('#rvideo').boundingBox();
  await a.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.5);
  await a.mouse.down(); await a.mouse.up();
  await a.keyboard.press('KeyA');
  const ilog = await until(async () => { const l = await b.evaluate(() => window.xk.input.log()); return l.some((x) => x.includes('"kd"')) && l; });
  ok('B 收到滑鼠鍵盤事件', !!ilog, ilog ? ilog.slice(-4).join(' ') : '');
  const mm = ilog && ilog.map((x) => JSON.parse(x)).find((e) => e.t === 'md');
  ok('滑鼠座標正確對應', mm && Math.abs(mm.x - 0.25) < 0.05 && Math.abs(mm.y - 0.5) < 0.05, mm ? `x=${mm.x.toFixed(3)} y=${mm.y.toFixed(3)}` : '');

  // 文字聊天
  await a.fill('#ctrlChat textarea', '哈囉，我是主控端');
  await a.press('#ctrlChat textarea', 'Enter');
  ok('B 收到文字訊息', await until(() => b.evaluate(() => document.querySelector('#hostChat .msgs').textContent.includes('哈囉，我是主控端'))));
  await b.fill('#hostChat textarea', '收到，被控端回覆');
  await b.press('#hostChat textarea', 'Enter');
  ok('A 收到回覆', await until(() => a.evaluate(() => document.querySelector('#ctrlChat .msgs').textContent.includes('收到，被控端回覆'))));

  // 畫面擷取傳送（B 擷取自己的畫面送給 A）
  await b.evaluate(async () => { const png = await window.xk.cap.screenshot(null); await window.__xk.host.chat.sendImageBlob(new Blob([png], { type: 'image/png' }), 'b.png'); });
  ok('A 收到畫面擷取圖片', await until(() => a.evaluate(() => { const i = document.querySelector('#ctrlChat .msgs img'); return i && i.naturalWidth > 0; })));

  // 聊天互傳檔案（B → A）
  await b.evaluate((p) => window.__xk.host.chat.sendPaths([p]), path.join(FIX, 'big.bin'));
  ok('A 收到聊天檔案', await until(() => a.evaluate(() => document.querySelector('#ctrlChat .msgs').textContent.includes('已存到')), 30000));

  // 檔案管理：列出、下載、上傳
  await a.click('#drawer .dtabs button[data-pane="files"]');
  const listed = await until(() => a.evaluate(async () => { const c = window.__xk.client.ch; const r = await c.request('fs-roots'); const l = await c.request('fs-list', [r[0].id, '']); return { r, names: l.entries.map((e) => e.name) }; }));
  ok('A 列出被控端授權資料夾', listed && listed.names.includes('hello.txt'), listed ? listed.names.join(',') : '');
  const dl = await a.evaluate(async (rid) => {
    const c = window.__xk.client.ch; const xid = c.newXid('t'); const parts = [];
    const done = c.expect(xid, async (d) => { parts.push(new Uint8Array(d)); });
    await c.request('fs-download', [rid, 'big.bin', xid]); await done;
    const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0)); let o = 0; for (const p of parts) { all.set(p, o); o += p.length; }
    const h = await crypto.subtle.digest('SHA-256', all); return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }, listed.r[0].id);
  ok('下載 3MB 檔案內容一致', dl === sha(fs.readFileSync(path.join(share, 'big.bin'))));
  await a.evaluate(() => { const f = window.__xk.client.files; f.rootInfo = null; return f.showRoots(); });
  await a.evaluate(async () => { const f = window.__xk.client.files; const r = await f.ch.request('fs-roots'); f.rootInfo = r[0]; await f.open(''); });
  await a.evaluate((p) => window.__xk.client.files.uploadPaths([p]), path.join(FIX, 'deck.pdf'));
  ok('上傳到被控端', await until(async () => fs.existsSync(path.join(share, 'deck.pdf')) && sha(fs.readFileSync(path.join(share, 'deck.pdf'))) === sha(fs.readFileSync(path.join(FIX, 'deck.pdf')))));
  const traversal = await a.evaluate(async (rid) => { try { await window.__xk.client.ch.request('fs-list', [rid, '../']); return 'allowed'; } catch (e) { return e.message; } }, listed.r[0].id);
  ok('阻擋跳出授權資料夾', traversal !== 'allowed', traversal);

  // 權限改成「只可讀」→ 上傳應失敗
  await b.evaluate((p) => window.xk.settings.set({ folders: [{ path: p, perm: 'r' }] }), share);
  const denied = await a.evaluate(async (rid) => { try { await window.__xk.client.ch.request('fs-upload', [rid, '', 'x.txt', 1, 'zz']); return 'allowed'; } catch (e) { return e.message; } }, listed.r[0].id);
  ok('只可讀資料夾拒絕上傳', denied.includes('寫入'), denied);
  await b.evaluate((p) => window.xk.settings.set({ folders: [{ path: p, perm: 'w' }] }), share);
  const wl = await a.evaluate(async (rid) => (await window.__xk.client.ch.request('fs-list', [rid, ''])).entries.length, listed.r[0].id);
  ok('只可寫資料夾看不到檔案', wl === 0);

  // 剪貼簿
  await b.evaluate(() => window.xk.clip.write('B 的剪貼簿'));
  const clip = await a.evaluate(() => window.__xk.client.ch.request('clip-get'));
  ok('取得遠端剪貼簿', clip === 'B 的剪貼簿');

  // 線上教學：推送 PDF
  await a.evaluate((p) => window.__xk.client.teach.startDeck([p]), path.join(FIX, 'deck.pdf'));
  ok('B 進入教學畫面', await until(() => b.evaluate(() => !document.querySelector('#teachOverlay').classList.contains('hidden'))));
  ok('B 載入簡報 3 頁', await until(() => b.evaluate(() => document.querySelector('#tPage').textContent.includes('/ 3'))), await b.evaluate(() => document.querySelector('#tPage').textContent));
  await a.evaluate(() => window.__xk.client.teach.go(1));
  ok('翻頁同步', await until(() => b.evaluate(() => document.querySelector('#tPage').textContent.includes('第 2 /'))));
  await a.evaluate(() => { const t = window.__xk.client.teach; t.view.addInk(2, 'x1', '#f00', 4, [[0.1, 0.1], [0.5, 0.5]]); t.ch.send({ t: 'teach-ink', page: 2, id: 'x1', c: '#f00', w: 4, pts: [[0.1, 0.1], [0.5, 0.5]] }); });
  await sleep(800);
  await b.screenshot({ path: path.join(FIX, 'shot-student.png') });
  await a.screenshot({ path: path.join(FIX, 'shot-teacher.png') });
  if (fs.existsSync(path.join(FIX, 'deck.pptx'))) {
    await a.evaluate((p) => window.__xk.client.teach.startDeck([p]), path.join(FIX, 'deck.pptx'));
    ok('PowerPoint 轉檔並推送', await until(() => b.evaluate(() => /\/ \d+ 頁/.test(document.querySelector('#tPage').textContent) && document.querySelector('#tTitle').textContent.includes('pptx')), 90000));
  }
  await a.evaluate(() => window.__xk.client.teach.end(true));
  ok('結束教學', await until(() => b.evaluate(() => document.querySelector('#teachOverlay').classList.contains('hidden'))));

  // 老師推送螢幕
  await a.evaluate(async () => {
    const t = window.__xk.client.teach; const src = (await window.xk.cap.windows()).find((s) => s.id.startsWith('screen'));
    t.screenStream = await navigator.mediaDevices.getUserMedia({ video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: src.id, maxWidth: 1280, maxHeight: 720 } } });
    t.screenCall = t.o.peer.call(t.o.remotePeerId(), t.screenStream, { metadata: { kind: 'teach-screen', name: '測試' } }); t.active = true;
  });
  ok('B 收到老師螢幕', await until(() => b.evaluate(() => { const v = document.querySelector('#teachStudentStage video'); return v && v.videoWidth > 0; })));
  await a.evaluate(() => window.__xk.client.teach.end(true));

  // 語音交談（假麥克風）
  await a.click('#drawer .dtabs button[data-pane="chat"]');
  await a.evaluate(() => window.__xk.client.chat.toggleVoice());
  await until(() => b.evaluate(() => !document.querySelector('#modal').classList.contains('hidden') && document.querySelector('#mTitle').textContent.includes('語音')));
  await b.click('#mBtns button.primary');
  ok('語音通話接通（A）', await until(() => a.evaluate(() => document.querySelector('#ctrlChat .voicebar').classList.contains('on'))));
  ok('語音通話接通（B）', await until(() => b.evaluate(() => document.querySelector('#hostChat .voicebar').classList.contains('on'))));
  await a.evaluate(() => window.__xk.client.chat.endVoice(false, true));
  ok('語音結束同步', await until(() => b.evaluate(() => !document.querySelector('#hostChat .voicebar').classList.contains('on'))));

  // 被控端暫停操控
  await b.click('#hAllow');
  ok('A 收到暫停操控通知', await until(() => a.evaluate(() => document.querySelector('#sControl').disabled)));

  // 中斷
  const codeBefore = code;
  await a.click('#sClose');
  ok('A 回到首頁', await until(() => a.evaluate(() => document.querySelector('#view-home').classList.contains('active'))));
  ok('B 回到首頁', await until(() => b.evaluate(() => document.querySelector('#view-home').classList.contains('active'))));
  ok('B 授權碼自動更換', (await b.evaluate(() => window.__xk.code)) !== codeBefore);
} catch (e) {
  ok('測試執行', false, e.stack);
} finally {
  if (logs.length) console.log('--- console ---\n' + logs.slice(-30).join('\n'));
  await A.close().catch(() => {});
  await B.close().catch(() => {});
  srv.kill();
  fs.rmSync(share, { recursive: true, force: true });
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n結果：${results.length - fail} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}

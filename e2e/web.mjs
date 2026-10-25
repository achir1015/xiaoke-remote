// 線上版端對端測試（需先 node scripts/build-web.mjs）：
//  1. 線上版主控端（Chrome）→ 桌面版被控端：畫面、操控、聊天、上傳下載、教學
//  2. 桌面版主控端 → 線上版被控端：接受、分享畫面、聊天、資料夾授權（OPFS）、教學
//  3. 線上版一對多：同時連兩台桌面版被控端
// 用法：node e2e/web.mjs <測試資料夾（內含 deck.pdf）> [Chrome 路徑]
import { _electron as electron, chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { serve } from './serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.resolve(process.argv[2] || path.join(ROOT, 'e2e', 'fixtures'));
const CHROME = process.argv[3] || ['C:/Program Files/Google/Chrome/Application/chrome.exe', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((p) => fs.existsSync(p));
const PEER_PORT = 9125, WEB_PORT = 8795;
const appData = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support');
const results = [];
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name]); console.log(cond ? '✅' : '❌', name, extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 25000, step = 300) { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } }

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, PORT: String(PEER_PORT) }, stdio: 'pipe' });
const web = await serve(WEB_PORT);
await sleep(1200);
const server = { mode: 'custom', host: '127.0.0.1', port: PEER_PORT, path: '/', key: 'peerjs', secure: false };

// 桌面版：B、C 被控端（固定授權碼、免確認），A 主控端
const share = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-webshare-'));
fs.writeFileSync(path.join(share, 'hello.txt'), '桌面版的檔案');
const prof = {
  wA: { server, stun: '', closeToTray: false, deviceId: '600000000', deviceName: '桌面主控A' },
  wB: { server, stun: '', closeToTray: false, deviceId: '600000001', deviceName: '桌面被控B', codeMode: 'fixed', fixedCode: 'BBBBBB', confirmIncoming: false, autoMinimize: false, folders: [{ path: share, perm: 'rw' }] },
  wC: { server, stun: '', closeToTray: false, deviceId: '600000002', deviceName: '桌面被控C', codeMode: 'fixed', fixedCode: 'CCCCCC', confirmIncoming: false, autoMinimize: false },
};
for (const [p, s] of Object.entries(prof)) {
  const dir = path.join(appData, 'xiaoke-remote-' + p);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s));
}
const apps = {}, w = {};
for (const p of Object.keys(prof)) { apps[p] = await electron.launch({ args: [ROOT, `--profile=${p}`, '--dry-input'], cwd: ROOT }); w[p] = await apps[p].firstWindow(); }

// 線上版：W 主控端、H 被控端（各自獨立的瀏覽器設定檔）
const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--lang=en-US'] });
async function webPage(id, name, extra = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 860 } });
  await ctx.addInitScript((s) => { if (!localStorage.getItem('xkr-settings')) localStorage.setItem('xkr-settings', JSON.stringify(s)); }, { server, stun: '', deviceId: id, deviceName: name, ...extra });
  const pg = await ctx.newPage();
  pg.on('pageerror', (e) => console.log(`[${name}] pageerror`, e.message));
  await pg.goto(`http://127.0.0.1:${WEB_PORT}/`);
  return pg;
}
const W = await webPage('700000001', '線上主控W', { devices: [{ id: '600000001', code: 'BBBBBB', name: 'B' }, { id: '600000002', code: 'CCCCCC', name: 'C' }] });
const H = await webPage('700000002', '線上被控H');
const online = (pg) => until(() => pg.evaluate(() => document.querySelector('#netStat').classList.contains('ok')));

try {
  for (const [n, pg] of [['A', w.wA], ['B', w.wB], ['C', w.wC], ['W', W], ['H', H]]) ok(`${n} 上線`, await online(pg));
  ok('線上版顯示說明提示', await W.evaluate(() => document.body.classList.contains('web') && document.querySelector('#permWarn').textContent.includes('線上版')));

  // ---- 1. 線上版主控 → 桌面版被控 ----
  await W.fill('#remoteId', '600 000 001');
  await W.fill('#remoteCode', 'BBBBBB');
  await W.click('#btnConnect');
  ok('[W→B] 進入遠端畫面', await until(() => W.evaluate(() => document.querySelector('#view-session').classList.contains('active'))));
  ok('[W→B] 收到畫面', await until(() => W.evaluate(() => document.querySelector('#rvideo').videoWidth > 0), 30000));
  const box = await W.locator('#rvideo').boundingBox();
  await W.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6);
  await W.keyboard.press('KeyZ');
  const il = await until(async () => { const l = await w.wB.evaluate(() => window.xk.input.log()); return l.some((x) => x.includes('KeyZ')) && l; });
  ok('[W→B] 操控事件送達', !!il);
  await W.fill('#ctrlChat textarea', '線上版打招呼');
  await W.press('#ctrlChat textarea', 'Enter');
  ok('[W→B] 聊天', await until(() => w.wB.evaluate(() => document.querySelector('#hostChat .msgs').textContent.includes('線上版打招呼'))));
  await w.wB.fill('#hostChat textarea', '桌面版回覆');
  await w.wB.press('#hostChat textarea', 'Enter');
  ok('[B→W] 聊天', await until(() => W.evaluate(() => document.querySelector('#ctrlChat .msgs').textContent.includes('桌面版回覆'))));
  const dl = await W.evaluate(async () => {
    const c = window.__xk.client.ch; const r = await c.request('fs-roots'); const xid = c.newXid('t'); const parts = [];
    const done = c.expect(xid, async (d) => { parts.push(new Uint8Array(d)); });
    await c.request('fs-download', [r[0].id, 'hello.txt', xid]); await done;
    return new TextDecoder().decode(new Uint8Array(await new Blob(parts).arrayBuffer()));
  });
  ok('[W→B] 下載檔案', dl === '桌面版的檔案', dl);
  await W.evaluate(async () => {
    const f = window.__xk.client.files; const r = await f.ch.request('fs-roots'); f.rootInfo = r[0]; await f.open('');
    await f.uploadPaths([window.xk.pathOf(new File(['從線上版上傳'], 'web-upload.txt'))]);
  });
  ok('[W→B] 上傳檔案', await until(async () => fs.existsSync(path.join(share, 'web-upload.txt')) && fs.readFileSync(path.join(share, 'web-upload.txt'), 'utf8') === '從線上版上傳'));
  const pdfB64 = fs.readFileSync(path.join(FIX, 'deck.pdf')).toString('base64');
  await W.evaluate(async (b64) => { const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)); await window.__xk.client.teach.startDeck([window.xk.pathOf(new File([bin], 'deck.pdf'))]); }, pdfB64);
  ok('[W→B] 教學簡報', await until(() => w.wB.evaluate(() => document.querySelector('#tPage').textContent.includes('/ 3'))));
  await W.evaluate(() => window.__xk.client.teach.end(true));
  await W.screenshot({ path: path.join(FIX, 'shot-web-controller.png') });
  await W.click('#sClose');
  ok('[W→B] 中斷', await until(() => w.wB.evaluate(() => document.querySelector('#view-home').classList.contains('active'))));

  // ---- 2. 桌面版主控 → 線上版被控 ----
  await H.evaluate(async () => { // 用瀏覽器的私有檔案系統（OPFS）模擬使用者授權的資料夾
    const root = await navigator.storage.getDirectory();
    const d = await root.getDirectoryHandle('分享資料夾', { create: true });
    const fh = await d.getFileHandle('web.txt', { create: true }); const wr = await fh.createWritable(); await wr.write('線上版的檔案'); await wr.close();
    const f = await window.xk.fs._addHandle(d, 'rw', '分享資料夾');
    window.__xk.settings = await window.xk.settings.set({ folders: [f] });
  });
  const hcode = await H.evaluate(() => window.__xk.code);
  await w.wA.fill('#remoteId', '700 000 002');
  await w.wA.fill('#remoteCode', hcode);
  await w.wA.click('#btnConnect');
  ok('[A→H] 線上版跳出接受視窗', await until(() => H.evaluate(() => !document.querySelector('#modal').classList.contains('hidden') && document.querySelector('#mTitle').textContent.includes('遠端連線要求'))));
  await H.click('#mBtns button.primary');
  ok('[A→H] 收到線上版畫面', await until(() => w.wA.evaluate(() => document.querySelector('#rvideo').videoWidth > 0), 30000));
  ok('[A→H] 顯示線上版限制說明', await until(() => w.wA.evaluate(() => document.querySelector('#ctrlChat .msgs').textContent.includes('線上版'))));
  ok('[A→H] 線上版被控端顯示「無法被操控」說明與下載連結', await H.evaluate(() => { const b = document.querySelector('.webhost'); return b && b.offsetParent !== null && b.textContent.includes('免安裝版'); }));
  ok('[A→H] 分享整個螢幕時不顯示警告', await H.evaluate(() => document.querySelector('#hShareWarn').classList.contains('hidden') && document.querySelector('#hReshare').classList.contains('hidden')));
  await w.wA.fill('#ctrlChat textarea', '桌面版找線上版');
  await w.wA.press('#ctrlChat textarea', 'Enter');
  ok('[A→H] 聊天', await until(() => H.evaluate(() => document.querySelector('#hostChat .msgs').textContent.includes('桌面版找線上版'))));
  const hl = await w.wA.evaluate(async () => { const c = window.__xk.client.ch; const r = await c.request('fs-roots'); const l = await c.request('fs-list', [r[0].id, '']); return { r, names: l.entries.map((e) => e.name) }; });
  ok('[A→H] 列出線上版授權資料夾', hl.names.includes('web.txt'), hl.names.join(','));
  const hdl = await w.wA.evaluate(async (rid) => {
    const c = window.__xk.client.ch; const xid = c.newXid('t'); const parts = [];
    const done = c.expect(xid, async (d) => { parts.push(new Uint8Array(d)); });
    await c.request('fs-download', [rid, 'web.txt', xid]); await done;
    return new TextDecoder().decode(new Uint8Array(await new Blob(parts).arrayBuffer()));
  }, hl.r[0].id);
  ok('[A→H] 下載線上版檔案', hdl === '線上版的檔案', hdl);
  await w.wA.evaluate(async (p) => { const f = window.__xk.client.files; const r = await f.ch.request('fs-roots'); f.rootInfo = r[0]; await f.open(''); await f.uploadPaths([p]); }, path.join(FIX, 'deck.pdf'));
  const up = await until(() => H.evaluate(async () => { const d = await (await navigator.storage.getDirectory()).getDirectoryHandle('分享資料夾'); try { return (await (await d.getFileHandle('deck.pdf')).getFile()).size; } catch { return 0; } }));
  ok('[A→H] 上傳到線上版資料夾', up === fs.statSync(path.join(FIX, 'deck.pdf')).size, String(up));
  const run = await w.wA.evaluate(async (rid) => { try { await window.__xk.client.ch.request('fs-run', [rid, 'web.txt']); return 'ran'; } catch (e) { return e.message; } }, hl.r[0].id);
  ok('[A→H] 線上版拒絕遠端執行', run.includes('線上版'), run);
  await w.wA.evaluate((p) => window.__xk.client.teach.startDeck([p]), path.join(FIX, 'deck.pdf'));
  ok('[A→H] 線上版顯示教學簡報', await until(() => H.evaluate(() => document.querySelector('#tPage').textContent.includes('/ 3'))));
  await H.screenshot({ path: path.join(FIX, 'shot-web-student.png') });
  await w.wA.evaluate(() => window.__xk.client.teach.end(true));
  await w.wA.click('#sClose');
  ok('[A→H] 中斷', await until(() => H.evaluate(() => document.querySelector('#view-home').classList.contains('active'))));

  // ---- 3. 線上版一對多 ----
  await W.click('#mainTabs button[data-view="multi"]');
  await W.click('#mConnectAll');
  ok('[W 一對多] 2 台已連線', await until(() => W.evaluate(() => window.__xk.links.size === 2)));
  ok('[W 一對多] 2 格都有畫面', await until(() => W.evaluate(() => [...document.querySelectorAll('#mGrid .tile video')].filter((v) => v.videoWidth > 0).length === 2), 30000));
  await W.screenshot({ path: path.join(FIX, 'shot-web-multi.png') });
  await W.click('#mGrid .tile:nth-child(1)');
  ok('[W 一對多] 放大操控', await until(() => W.evaluate(() => document.querySelector('#view-session').classList.contains('active'))));
  await W.click('#sBack');
  await W.click('#mDisconnectAll');
  ok('[W 一對多] 全部中斷', await until(() => W.evaluate(() => window.__xk.links.size === 0)));

  // ---- 4. 線上版被控端只分享一個視窗：雙方都要看到警告 ----
  // 自動化無法在選擇畫面中點選單一視窗，改讓瀏覽器回報 displaySurface = 'window' 來測試警告邏輯
  const b2 = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen', '--lang=en-US'] });
  try {
    const c2 = await b2.newContext({ viewport: { width: 1400, height: 860 } });
    await c2.addInitScript((st) => localStorage.setItem('xkr-settings', JSON.stringify(st)), { server, stun: '', deviceId: '700000003', deviceName: '線上被控H2' });
    await c2.addInitScript(() => { const g = MediaStreamTrack.prototype.getSettings; MediaStreamTrack.prototype.getSettings = function () { const r = g.call(this); if (r.displaySurface) r.displaySurface = 'window'; return r; }; });
    const H2 = await c2.newPage();
    await H2.goto(`http://127.0.0.1:${WEB_PORT}/`);
    await online(H2);
    const code2 = await H2.evaluate(() => window.__xk.code);
    await w.wA.fill('#remoteId', '700 000 003');
    await w.wA.fill('#remoteCode', code2);
    await w.wA.click('#btnConnect');
    await until(() => H2.evaluate(() => !document.querySelector('#modal').classList.contains('hidden')));
    await H2.click('#mBtns button.primary');
    ok('[A→H2] 只分享視窗：被控端顯示警告與「改分享整個螢幕」', await until(() => H2.evaluate(() => !document.querySelector('#hShareWarn').classList.contains('hidden') && !document.querySelector('#hReshare').classList.contains('hidden'))));
    ok('[A→H2] 只分享視窗：主控端收到提醒', await until(() => w.wA.evaluate(() => [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('只分享了一個視窗')))));
    await w.wA.click('#sClose');
    await until(() => H2.evaluate(() => document.querySelector('#view-home').classList.contains('active')));
  } finally { await b2.close().catch(() => {}); }
} catch (e) {
  ok('測試執行', false, e.stack);
} finally {
  await browser.close().catch(() => {});
  for (const x of Object.values(apps)) await x.close().catch(() => {});
  web.close(); srv.kill();
  fs.rmSync(share, { recursive: true, force: true });
  for (const p of Object.keys(prof)) fs.rmSync(path.join(appData, 'xiaoke-remote-' + p), { recursive: true, force: true });
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n結果：${results.length - fail} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}

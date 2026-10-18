// 一對多端對端測試：A 主控端同時連線 B、C、D 三台被控端（分割畫面、放大操控、廣播、全體教學、斷線自動重連）
// 用法：node e2e/multi.mjs <測試資料夾（內含 deck.pdf）>
import { _electron as electron } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIX = path.resolve(process.argv[2] || path.join(ROOT, 'e2e', 'fixtures'));
const PORT = 9124;
const appData = process.env.APPDATA || path.join(os.homedir(), 'Library', 'Application Support');
const results = [];
const ok = (name, cond, extra = '') => { results.push([cond ? 'PASS' : 'FAIL', name]); console.log(cond ? '✅' : '❌', name, extra); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 25000, step = 300) { const t = Date.now(); for (;;) { const v = await fn().catch(() => null); if (v) return v; if (Date.now() - t > ms) return null; await sleep(step); } }

const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], { env: { ...process.env, PORT: String(PORT) }, stdio: 'pipe' });
await sleep(1500);
const base = { server: { mode: 'custom', host: '127.0.0.1', port: PORT, path: '/', key: 'peerjs', secure: false }, stun: '', closeToTray: false };
const hosts = { mB: '500000001', mC: '500000002', mD: '500000003' };
const prof = { mA: { ...base, deviceId: '500000000', deviceName: '老師機', devices: Object.entries(hosts).map(([p, id]) => ({ id, code: 'FIXED123', name: '學生' + p.slice(1) })) } };
for (const [p, id] of Object.entries(hosts)) prof[p] = { ...base, deviceId: id, deviceName: '學生' + p.slice(1), codeMode: 'fixed', fixedCode: 'FIXED123', confirmIncoming: false };
for (const [p, s] of Object.entries(prof)) {
  const dir = path.join(appData, 'xiaoke-remote-' + p);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(s));
}
const launch = (p) => electron.launch({ args: [ROOT, `--profile=${p}`, '--dry-input'], cwd: ROOT });
const apps = {};
for (const p of Object.keys(prof)) apps[p] = await launch(p);
const w = {};
for (const p of Object.keys(prof)) w[p] = await apps[p].firstWindow();
const a = w.mA;
const H = ['mB', 'mC', 'mD'];
const online = (pg) => until(() => pg.evaluate(() => document.querySelector('#netStat').classList.contains('ok')));

try {
  for (const p of Object.keys(prof)) ok(`${p} 上線`, await online(w[p]));
  await a.click('#mainTabs button[data-view="multi"]');
  ok('清單有 3 台', (await a.$$eval('#mDevices li', (l) => l.length)) === 3);
  await a.click('#mConnectAll');
  ok('3 台都已連線', await until(() => a.evaluate(() => window.__xk.links.size === 3)));
  ok('3 格都有畫面', await until(() => a.evaluate(() => [...document.querySelectorAll('#mGrid .tile video')].filter((v) => v.videoWidth > 0).length === 3), 30000));
  for (const p of H) ok(`${p} 顯示被連線`, await until(() => w[p].evaluate(() => document.querySelector('#view-hosting').classList.contains('active'))));
  const thumbW = await until(async () => { const ws = await a.evaluate(() => [...document.querySelectorAll('#mGrid .tile video')].map((v) => v.videoWidth)); return ws.every((x) => x > 0 && x <= 700) && ws; }, 20000);
  ok('分割畫面為縮圖畫質（≤ 700 寬）', !!thumbW, JSON.stringify(thumbW));
  await sleep(1000);
  await a.screenshot({ path: path.join(FIX, 'shot-multi.png') });

  // 放大第 2 格（學生C）
  await a.click('#mGrid .tile:nth-child(2)');
  ok('放大進入操控畫面', await until(() => a.evaluate(() => document.querySelector('#view-session').classList.contains('active') && !document.querySelector('#sBack').classList.contains('hidden'))));
  ok('放大的是學生C', (await a.textContent('#sTitle')).includes('學生C'));
  const fullW = await until(async () => { const x = await a.evaluate(() => document.querySelector('#rvideo').videoWidth); return x > 1000 && x; }, 25000);
  ok('放大後切換高畫質', !!fullW, String(fullW));
  const box = await a.locator('#rvideo').boundingBox();
  await a.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  ok('只有學生C收到點擊', await until(async () => { const c = await w.mC.evaluate(() => window.xk.input.log()); const b = await w.mB.evaluate(() => window.xk.input.log()); return c.some((x) => x.includes('"md"')) && !b.some((x) => x.includes('"md"')); }));
  await a.click('#sBack');
  ok('返回分割畫面', await until(() => a.evaluate(() => document.querySelector('#view-multi').classList.contains('active'))));

  // 廣播訊息
  await a.fill('#mBroadcastText', '請大家打開課本第 5 頁');
  await a.click('#mBroadcast');
  for (const p of H) ok(`${p} 收到廣播`, await until(() => w[p].evaluate(() => document.querySelector('#hostChat .msgs').textContent.includes('請大家打開課本第 5 頁'))));

  // 全體教學
  await a.evaluate((f) => window.__xk.broadcastDeck([f]), path.join(FIX, 'deck.pdf'));
  for (const p of H) ok(`${p} 載入簡報`, await until(() => w[p].evaluate(() => document.querySelector('#tPage').textContent.includes('/ 3'))));
  await a.click('#mTeachNext');
  for (const p of H) ok(`${p} 同步翻到第 2 頁`, await until(() => w[p].evaluate(() => document.querySelector('#tPage').textContent.includes('第 2 /'))));
  await a.click('#mTeachEnd');
  for (const p of H) ok(`${p} 結束教學`, await until(() => w[p].evaluate(() => document.querySelector('#teachOverlay').classList.contains('hidden'))));

  // 斷線自動重連：關掉學生D再開
  await apps.mD.close();
  ok('學生D 斷線後顯示重試', await until(() => a.evaluate(() => document.querySelector('#mDevices').textContent.includes('重試')), 30000));
  ok('學生D 斷線被偵測（剩 2 台）', await until(() => a.evaluate(() => window.__xk.links.size === 2), 30000));
  apps.mD = await launch('mD'); w.mD = await apps.mD.firstWindow();
  ok('學生D 自動重連', await until(() => a.evaluate(() => window.__xk.links.size === 3), 60000));

  // 全部中斷
  await a.click('#mDisconnectAll');
  ok('全部中斷', await until(() => a.evaluate(() => window.__xk.links.size === 0)));
  for (const p of H) ok(`${p} 回到首頁`, await until(() => w[p].evaluate(() => document.querySelector('#view-home').classList.contains('active'))));
} catch (e) {
  ok('測試執行', false, e.stack);
} finally {
  for (const x of Object.values(apps)) await x.close().catch(() => {});
  srv.kill();
  for (const p of Object.keys(prof)) fs.rmSync(path.join(appData, 'xiaoke-remote-' + p), { recursive: true, force: true });
  const fail = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n結果：${results.length - fail} 通過，${fail} 失敗`);
  process.exit(fail ? 1 : 0);
}

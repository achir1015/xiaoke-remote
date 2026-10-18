'use strict';
// 資料夾授權沙箱的單元測試：node --test test/
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { FsGuard, rootId } = require('../src/main/fsguard');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xk-guard-'));
const ro = path.join(tmp, 'ro'); const wo = path.join(tmp, 'wo'); const rw = path.join(tmp, 'rw'); const outside = path.join(tmp, 'outside');
for (const d of [ro, wo, rw, outside, path.join(rw, 'sub')]) fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(ro, 'a.txt'), 'A');
fs.writeFileSync(path.join(wo, 'secret.txt'), 'S');
fs.writeFileSync(path.join(rw, 'sub', 'b.txt'), 'B');
fs.writeFileSync(path.join(outside, 'x.txt'), 'X');
const g = new FsGuard(() => [{ path: ro, perm: 'r' }, { path: wo, perm: 'w' }, { path: rw, perm: 'rw' }]);
const id = (p) => rootId(p);

test('列出授權資料夾', () => {
  assert.deepStrictEqual(g.publicRoots().map((r) => r.perm), ['r', 'w', 'rw']);
});

test('可讀資料夾：可列出與讀取，不可寫入', () => {
  assert.deepStrictEqual(g.list(id(ro), '').entries.map((e) => e.name), ['a.txt']);
  assert.ok(g.resolve(id(ro), 'a.txt', 'r').abs.endsWith('a.txt'));
  assert.throws(() => g.resolveNew(id(ro), '', 'new.txt'), /寫入/);
});

test('只可寫資料夾：看不到檔案、不可下載、可寫入', () => {
  assert.deepStrictEqual(g.list(id(wo), '').entries, []);
  assert.throws(() => g.resolve(id(wo), 'secret.txt', 'r'), /讀取/);
  assert.ok(g.resolveNew(id(wo), '', 'up.txt').endsWith('up.txt'));
});

test('可讀寫資料夾：子資料夾可用', () => {
  assert.strictEqual(g.list(id(rw), 'sub').entries[0].name, 'b.txt');
  assert.ok(g.resolveNew(id(rw), 'sub', 'c.txt'));
});

test('阻擋跳出授權範圍', () => {
  assert.throws(() => g.resolve(id(rw), '../outside/x.txt', 'r'), /不合法|範圍/);
  assert.throws(() => g.resolve(id(rw), 'sub/../../outside/x.txt', 'r'), /不合法|範圍/);
  assert.throws(() => g.resolve(id(rw), path.join(outside, 'x.txt'), 'r'));
  assert.throws(() => g.resolveNew(id(rw), '', '../evil.txt'), /檔名/);
  assert.throws(() => g.resolveNew(id(rw), '', 'a/b.txt'), /檔名/);
  assert.throws(() => g.resolve('nope', '', 'r'), /未授權/);
});

test('阻擋符號連結跳出', (t) => {
  const link = path.join(rw, 'lnk');
  try { fs.symlinkSync(outside, link, 'junction'); } catch { t.skip('無法建立連結'); return; }
  assert.throws(() => g.resolve(id(rw), 'lnk/x.txt', 'r'), /範圍/);
  assert.ok(!g.list(id(rw), '').entries.some((e) => e.name === 'lnk'));
});

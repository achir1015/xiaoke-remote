// 產生線上版網站（site/），與桌面版共用 src/renderer 的程式碼，由 GitHub Pages 發佈。
// 用法：node scripts/build-web.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'site');
const R = path.join(ROOT, 'src', 'renderer');
const NM = path.join(ROOT, 'node_modules');
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'js'), { recursive: true });

const copy = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
const text = (from, to, fn) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.writeFileSync(to, fn(fs.readFileSync(from, 'utf8'))); };

// 頁面：../../node_modules → vendor、../../assets → assets
text(path.join(R, 'index.html'), path.join(OUT, 'index.html'), (s) => s
  .replaceAll('../../node_modules/', 'vendor/')
  .replaceAll('../../assets/', 'assets/')
  .replace('<title>小柯機器人遠端連線</title>', '<title>小柯機器人遠端連線（線上版）</title>\n<link rel="icon" href="assets/icon.png">\n<meta name="viewport" content="width=device-width, initial-scale=1">\n<meta name="description" content="小柯機器人遠端連線線上版：免安裝，用瀏覽器遠端操控、檔案傳輸、文字語音聊天、線上教學，一對多最多 20 台。">'));
copy(path.join(R, 'style.css'), path.join(OUT, 'style.css'));
for (const f of fs.readdirSync(path.join(R, 'js'))) {
  text(path.join(R, 'js', f), path.join(OUT, 'js', f), (s) => s
    .replaceAll('../../../node_modules/', '../vendor/')
    .replaceAll('__XK_VERSION__', version));
}

// 第三方函式庫
copy(path.join(NM, 'peerjs', 'dist', 'peerjs.min.js'), path.join(OUT, 'vendor', 'peerjs', 'dist', 'peerjs.min.js'));
for (const f of ['pdf.min.mjs', 'pdf.worker.min.mjs']) copy(path.join(NM, 'pdfjs-dist', 'build', f), path.join(OUT, 'vendor', 'pdfjs-dist', 'build', f));
copy(path.join(NM, 'pdfjs-dist', 'cmaps'), path.join(OUT, 'vendor', 'pdfjs-dist', 'cmaps'));
copy(path.join(NM, 'pdfjs-dist', 'standard_fonts'), path.join(OUT, 'vendor', 'pdfjs-dist', 'standard_fonts'));
copy(path.join(ROOT, 'assets'), path.join(OUT, 'assets'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// 檢查：網站裡不應再有指向 node_modules 的路徑
const bad = [];
const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== 'vendor') walk(p); } else if (/\.(html|js|mjs|css)$/.test(f.name) && fs.readFileSync(p, 'utf8').includes('node_modules')) bad.push(p); } };
walk(OUT);
if (bad.length) { console.error('仍有 node_modules 路徑：', bad); process.exit(1); }
console.log(`線上版 v${version} 已輸出到 ${OUT}`);

'use strict';
// 小柯機器人遠端連線：自架 ID／信令伺服器
// 用途等同 RustDesk 的 hbbs：讓兩端用 ID 找到彼此、交換連線資訊；畫面與檔案不經過這台伺服器（點對點直連）。
// 直連失敗時需要 TURN 中繼（等同 hbbr），請見 docker-compose.yml 的 coturn。
const { PeerServer } = require('peer');

const port = Number(process.env.PORT) || 9000;
const key = process.env.KEY || 'peerjs';
const path = process.env.BASE_PATH || '/';

const server = PeerServer({
  port,
  path,
  key,
  proxied: process.env.PROXIED === '1', // 放在 nginx / ngrok 等反向代理後面時設為 1
  allow_discovery: false, // 不允許列出線上 ID
  alive_timeout: 60000,
});

server.on('connection', (c) => console.log(new Date().toISOString(), '上線', c.getId()));
server.on('disconnect', (c) => console.log(new Date().toISOString(), '離線', c.getId()));
console.log(`小柯遠端連線伺服器已啟動：port ${port}，path ${path}，key ${key}`);

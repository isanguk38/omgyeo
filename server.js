'use strict';
// 옮겨 서버: 정적 파일 제공 + 기기 연결 중개(시그널링) + 직접 연결이 안 될 때 데이터 중계
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 8080;
const PUBLIC = path.join(__dirname, 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) out.push(a.address);
    }
  }
  // 사설망 주소(192.168, 10., 172.16-31)를 앞으로
  const rank = ip => (ip.startsWith('192.168.') ? 0 : ip.startsWith('10.') ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
  return out.sort((a, b) => rank(a) - rank(b));
}

// ngrok이 이 포트를 열어 두었으면 그 공개 주소를 QR에 쓰도록 알려 줌 (ngrok 로컬 API: 4040)
async function ngrokUrl() {
  try {
    const r = await fetch('http://127.0.0.1:4040/api/tunnels', { signal: AbortSignal.timeout(400) });
    const { tunnels = [] } = await r.json();
    const mine = tunnels.filter(t => String(t.config && t.config.addr).endsWith(`:${PORT}`) || String(t.config && t.config.addr) === String(PORT));
    const t = mine.find(t => t.public_url.startsWith('https://')) || mine[0];
    return t ? t.public_url : null;
  } catch { return null; }
}

// ---------- HTTP ----------
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');

  if (url.pathname === '/api/info') {
    const proto = req.socket.encrypted ? 'https' : 'http';
    const pub = await ngrokUrl();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ lan: lanAddresses().map(ip => `${proto}://${ip}:${PORT}`), public: pub }));
  }

  if (url.pathname === '/qr.svg') {
    const text = (url.searchParams.get('t') || '').slice(0, 600);
    try {
      const svg = await QRCode.toString(text || ' ', { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
      return res.end(svg);
    } catch {
      res.writeHead(400); return res.end();
    }
  }

  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const file = path.normalize(path.join(PUBLIC, rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// HTTPS 인증서가 있으면 HTTPS로 (폰에서 클립보드·공유 기능이 모두 켜짐)
const certDir = path.join(__dirname, 'cert');
const hasCert = fs.existsSync(path.join(certDir, 'key.pem')) && fs.existsSync(path.join(certDir, 'cert.pem'));
const server = hasCert
  ? https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, handle)
  : http.createServer(handle);

// ---------- 방과 기기 ----------
const rooms = new Map();   // roomId -> { peers: Map<id, ws>, code }
const codes = new Map();   // 6자리 코드 -> roomId
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomId = n => Array.from(crypto.randomBytes(n), b => ID_CHARS[b % ID_CHARS.length]).join('');
const ROOM_RE = /^[a-z0-9]{10}$/;

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!codes.has(c)) return c;
  }
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
// pub: 종단간 암호화용 공개키(서버는 전달만 함), dev: 페이지가 살아 있는 동안 유지되는 기기 식별자(이어받기용)
// caps: 기기 능력(fs: 폴더 읽고 쓰기 가능, pid: 브라우저 고유 표식 — 폴더 동기화 짝 기억용)
const info = ws => ({ id: ws.id, name: ws.name, kind: ws.kind, pub: ws.pub, dev: ws.dev, caps: ws.caps });
const sendJSON = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

function join(ws, roomId) {
  if (ws.room === roomId) return;
  leave(ws);
  let room = rooms.get(roomId);
  if (!room) {
    room = { peers: new Map(), code: newCode() };
    rooms.set(roomId, room);
    codes.set(room.code, roomId);
  }
  for (const other of room.peers.values()) sendJSON(other, { type: 'peer-joined', peer: info(ws) });
  const peers = [...room.peers.values()].map(info);
  room.peers.set(ws.id, ws);
  ws.room = roomId;
  sendJSON(ws, { type: 'joined', room: roomId, code: room.code, you: ws.id, peers });
}

function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room) { ws.room = null; return; }
  room.peers.delete(ws.id);
  for (const other of room.peers.values()) sendJSON(other, { type: 'peer-left', id: ws.id });
  if (room.peers.size === 0) { codes.delete(room.code); rooms.delete(ws.room); }
  ws.room = null;
}

function peerOf(ws, id) {
  const room = rooms.get(ws.room);
  return room ? room.peers.get(id) : null;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', ws => {
  ws.id = randomId(8);
  ws.name = '기기';
  ws.kind = 'pc';
  ws.room = null;
  ws.pub = null;
  ws.dev = ws.id;
  ws.caps = { fs: false, pid: ws.id };
  ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  sendJSON(ws, { type: 'welcome', id: ws.id });

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      // 중계 데이터: [받는 기기 id 8바이트][내용] -> [보낸 기기 id 8바이트][내용]
      const buf = Buffer.isBuffer(data) ? data : Buffer.concat(data);
      if (buf.length < 8) return;
      const target = peerOf(ws, buf.toString('latin1', 0, 8));
      if (!target || target.readyState !== 1) return;
      Buffer.from(ws.id, 'latin1').copy(buf, 0);
      target.send(buf, { binary: true });
      return;
    }
    let m;
    try { m = JSON.parse(data.toString()); } catch { return; }
    switch (m.type) {
      case 'hello':
        ws.name = String(m.name || '기기').slice(0, 30);
        ws.kind = ['pc', 'phone', 'tablet'].includes(m.kind) ? m.kind : 'pc';
        ws.pub = typeof m.pub === 'string' && m.pub.length <= 200 ? m.pub : null;
        ws.dev = typeof m.dev === 'string' && /^[a-z0-9]{8,32}$/.test(m.dev) ? m.dev : ws.id;
        ws.caps = {
          fs: !!(m.caps && m.caps.fs),
          pid: m.caps && typeof m.caps.pid === 'string' && /^[a-z0-9]{8,32}$/.test(m.caps.pid) ? m.caps.pid : ws.dev,
        };
        break;
      case 'create':
        join(ws, randomId(10));
        break;
      case 'join': {
        if (m.code) {
          const roomId = codes.get(String(m.code));
          if (!roomId) return sendJSON(ws, { type: 'error', code: 'nocode', message: '그 코드로 열린 연결이 없어요. 숫자를 다시 확인하세요.' });
          join(ws, roomId);
        } else if (ROOM_RE.test(m.room || '')) {
          join(ws, m.room);
        }
        break;
      }
      case 'leave':
        leave(ws);
        break;
      case 'rename': {
        ws.name = String(m.name || '기기').slice(0, 30);
        const room = rooms.get(ws.room);
        if (room) for (const other of room.peers.values()) if (other !== ws) sendJSON(other, { type: 'peer-renamed', id: ws.id, name: ws.name });
        break;
      }
      case 'signal':
      case 'relay': {
        const target = peerOf(ws, m.to);
        if (target) sendJSON(target, { type: m.type, from: ws.id, data: m.data });
        break;
      }
    }
  });

  ws.on('close', () => leave(ws));
});

// 끊긴 연결 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => {
  const proto = hasCert ? 'https' : 'http';
  console.log(`옮겨 서버 실행 중`);
  console.log(`  이 PC:   ${proto}://localhost:${PORT}`);
  for (const ip of lanAddresses()) console.log(`  같은 와이파이: ${proto}://${ip}:${PORT}`);
});

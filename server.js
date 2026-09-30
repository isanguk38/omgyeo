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
  '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8',   // robots.txt, sitemap.xml (검색 색인용)
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

// ---------- 연결 경로 정보 (STUN + 선택적으로 TURN) ----------
// 직접 연결이 막힌 네트워크에서는 TURN(가까운 전송 전용 중계 서버)을 거쳐 연결.
// 키가 없으면 STUN만 알려 주고, 그때는 지금처럼 우리 서버 경유로 넘어감.
//   Cloudflare:  CF_TURN_KEY_ID, CF_TURN_API_TOKEN
//   Metered:     METERED_DOMAIN(예: myapp.metered.live), METERED_API_KEY
//   직접 지정:   TURN_URLS(쉼표로 구분), TURN_USERNAME, TURN_CREDENTIAL
const STUN = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
let iceCache = null;
async function iceServers() {
  if (iceCache && iceCache.exp > Date.now()) return iceCache;
  const env = process.env;
  let list = [...STUN], turn = false, ttl = 6 * 3600e3;
  try {
    if (env.CF_TURN_KEY_ID && env.CF_TURN_API_TOKEN) {
      const r = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CF_TURN_KEY_ID}/credentials/generate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.CF_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttl: 86400 }),
        signal: AbortSignal.timeout(5000),
      });
      const j = await r.json();
      if (j.iceServers) { list.push(...[].concat(j.iceServers)); turn = true; }
      else console.warn('Cloudflare TURN 응답을 해석하지 못했어요', r.status);
    } else if (env.METERED_DOMAIN && env.METERED_API_KEY) {
      const r = await fetch(`https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`, { signal: AbortSignal.timeout(5000) });
      const j = await r.json();
      if (Array.isArray(j) && j.length) { list = [...STUN, ...j]; turn = true; }
      else console.warn('Metered TURN 응답을 해석하지 못했어요', r.status);
    } else if (env.TURN_URLS) {
      list.push({ urls: env.TURN_URLS.split(',').map(s => s.trim()).filter(Boolean), username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
      turn = true;
    }
  } catch (err) {
    console.warn('TURN 정보를 받지 못했어요:', err.message);
    ttl = 60e3;   // 실패하면 1분 뒤 다시 시도
  }
  iceCache = { iceServers: list, turn, exp: Date.now() + ttl };
  return iceCache;
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
  // 검색 결과에 나오지 않게 함 (주소를 아는 사람만 들어오도록). 모든 응답에 붙임
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');

  if (url.pathname === '/api/info') {
    const proto = req.socket.encrypted ? 'https' : 'http';
    const pub = await ngrokUrl();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ lan: lanAddresses().map(ip => `${proto}://${ip}:${PORT}`), public: pub }));
  }

  if (url.pathname === '/api/ice') {
    const ice = await iceServers();
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ iceServers: ice.iceServers, turn: ice.turn }));
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
// known: 이 방에 들어온 적 있는 브라우저(pid). 잠깐 나갔다 돌아오면 기존 기기의 허용 없이 바로 들어옴
const rooms = new Map();   // roomId -> { peers: Map<id, ws>, code, pending: Map<reqId, {ws, timer}>, known: Set<pid> }
const codes = new Map();   // 6자리 코드 -> roomId
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const randomId = n => Array.from(crypto.randomBytes(n), b => ID_CHARS[b % ID_CHARS.length]).join('');
const ROOM_RE = /^[a-z0-9]{10}$/;
const APPROVAL_WAIT = 120000;   // 입장 승인을 기다리는 최대 시간

function newCode() {
  for (let i = 0; i < 50; i++) {
    const c = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
    if (!codes.has(c)) return c;
  }
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}
// pub: 종단간 암호화용 공개키(서버는 전달만 함), dev: 페이지가 살아 있는 동안 유지되는 기기 식별자(이어받기용)
// caps: 기기 능력(fs: 폴더 읽고 쓰기 가능, pid: 브라우저 고유 표식 — 폴더 동기화 짝·신뢰 기기 기억용)
const info = ws => ({ id: ws.id, name: ws.name, kind: ws.kind, pub: ws.pub, dev: ws.dev, caps: ws.caps });
const sendJSON = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };
const Mafia = require('./mafia')(sendJSON);

// ---------- 코드 무작위 대입 막기: 같은 곳에서 10분 안에 10번 틀리면 10분 동안 코드 입장 차단 ----------
const FAIL_WINDOW = 10 * 60e3, FAIL_MAX = 10, BLOCK_FOR = 10 * 60e3;
const fails = new Map();   // ip -> { times: [], until }
function codeBlocked(ip) {
  const f = fails.get(ip);
  return f && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 60000) : 0;
}
function codeFailed(ip) {
  const now = Date.now();
  const f = fails.get(ip) || { times: [], until: 0 };
  f.times = f.times.filter(t => now - t < FAIL_WINDOW);
  f.times.push(now);
  let left = FAIL_MAX - f.times.length;
  if (left <= 0) { f.until = now + BLOCK_FOR; f.times = []; left = 0; }
  fails.set(ip, f);
  return left;
}
setInterval(() => { const now = Date.now(); for (const [ip, f] of fails) if (f.until < now && !f.times.some(t => now - t < FAIL_WINDOW)) fails.delete(ip); }, 60e3);

// ---------- 입장: 방에 이미 기기가 있으면 기존 기기의 허용을 받아야 들어옴 ----------
function requestJoin(ws, roomId) {
  if (ws.room === roomId) return;
  const room = rooms.get(roomId);
  if (!room || room.peers.size === 0) return admit(ws, roomId);   // 빈 방(새 연결·혼자 재접속)은 바로
  // 같은 페이지의 끊긴 이전 연결이 아직 남아 있으면 정리 (요청이 죽은 연결로 가지 않게)
  for (const other of [...room.peers.values()]) if (other !== ws && other.dev === ws.dev) { leave(other); other.terminate(); }
  const pid = ws.caps && ws.caps.pid;
  if (!rooms.has(roomId) || rooms.get(roomId).peers.size === 0) return admit(ws, roomId);
  // 전에 이 방에 들어왔던 기기는 상대 화면이 잠들어 있어도 바로 들어옴
  if (pid && room.known.has(pid)) return admit(ws, roomId);
  leave(ws);
  cancelPending(ws);
  const reqId = randomId(10);
  const timer = setTimeout(() => answer(roomId, reqId, false, 'timeout'), APPROVAL_WAIT);
  room.pending.set(reqId, { ws, timer });
  ws.pending = { roomId, reqId };
  for (const other of room.peers.values()) sendJSON(other, { type: 'join-request', reqId, peer: info(ws) });
  sendJSON(ws, { type: 'waiting', room: roomId });
}
function answer(roomId, reqId, allow, reason, remember = true) {
  const room = rooms.get(roomId);
  const req = room && room.pending.get(reqId);
  if (!req) return;
  clearTimeout(req.timer);
  room.pending.delete(reqId);
  req.ws.pending = null;
  for (const other of room.peers.values()) sendJSON(other, { type: 'join-done', reqId, allowed: !!allow });
  if (allow) admit(req.ws, roomId, remember);
  else sendJSON(req.ws, { type: 'join-denied', reason: reason || 'denied' });
}
function cancelPending(ws) {
  if (!ws.pending) return;
  const { roomId, reqId } = ws.pending;
  ws.pending = null;
  const room = rooms.get(roomId);
  const req = room && room.pending.get(reqId);
  if (!req) return;
  clearTimeout(req.timer);
  room.pending.delete(reqId);
  for (const other of room.peers.values()) sendJSON(other, { type: 'join-done', reqId, allowed: false });
}
function admit(ws, roomId, remember = true) {
  if (ws.room === roomId) return;
  leave(ws);
  cancelPending(ws);
  let room = rooms.get(roomId);
  if (!room) {
    room = { peers: new Map(), code: newCode(), pending: new Map(), known: new Set() };
    rooms.set(roomId, room);
    codes.set(room.code, roomId);
  }
  for (const other of room.peers.values()) sendJSON(other, { type: 'peer-joined', peer: info(ws) });
  const peers = [...room.peers.values()].map(info);
  room.peers.set(ws.id, ws);
  if (remember && ws.caps && ws.caps.pid) room.known.add(ws.caps.pid);
  ws.room = roomId;
  sendJSON(ws, { type: 'joined', room: roomId, code: room.code, you: ws.id, peers });
  Mafia.onJoin(room, ws);   // 게임 중이면 지금 상황을 보여 줌 (구경)
}

function leave(ws) {
  const room = rooms.get(ws.room);
  if (!room) { ws.room = null; return; }
  room.peers.delete(ws.id);
  for (const other of room.peers.values()) sendJSON(other, { type: 'peer-left', id: ws.id });
  Mafia.onLeave(room, ws);
  if (room.peers.size === 0) {
    // 허용해 줄 기기가 모두 나가면 기다리던 요청은 거절
    for (const [reqId] of room.pending) answer(ws.room, reqId, false, 'empty');
    Mafia.stop(room);
    codes.delete(room.code); rooms.delete(ws.room);
  }
  ws.room = null;
}

function peerOf(ws, id) {
  const room = rooms.get(ws.room);
  return room ? room.peers.get(id) : null;
}

const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 2 * 1024 * 1024 });

wss.on('connection', (ws, req) => {
  ws.id = randomId(8);
  ws.ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  ws.name = '기기';
  ws.kind = 'pc';
  ws.room = null;
  ws.pending = null;
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
          lanes: !!(m.caps && m.caps.lanes),
        };
        break;
      case 'create':
        admit(ws, randomId(10));
        break;
      case 'join': {
        if (m.code) {
          const wait = codeBlocked(ws.ip);
          if (wait) return sendJSON(ws, { type: 'error', code: 'blocked', message: `코드를 여러 번 틀려서 ${wait}분 동안 코드 입장이 막혔어요. 잠시 뒤 다시 시도하세요.` });
          const roomId = codes.get(String(m.code));
          if (!roomId) {
            const left = codeFailed(ws.ip);
            if (!left) return sendJSON(ws, { type: 'error', code: 'blocked', message: `코드를 여러 번 틀려서 ${BLOCK_FOR / 60000}분 동안 코드 입장이 막혔어요. 잠시 뒤 다시 시도하세요.` });
            return sendJSON(ws, { type: 'error', code: 'nocode', message: left <= 3
              ? `그 코드로 열린 연결이 없어요. ${left}번 더 틀리면 잠시 막혀요.`
              : '그 코드로 열린 연결이 없어요. 숫자를 다시 확인하세요.' });
          }
          requestJoin(ws, roomId);
        } else if (ROOM_RE.test(m.room || '')) {
          requestJoin(ws, m.room);
        }
        break;
      }
      case 'join-answer':   // 기존 기기가 새 기기를 허용/거절
        if (ws.room) answer(ws.room, String(m.reqId || ''), !!m.allow, 'denied', m.remember !== false);
        break;
      case 'leave':
        cancelPending(ws);
        leave(ws);
        break;
      case 'mafia':   // 마피아 게임 (서버가 사회자)
        if (ws.room) Mafia.onMsg(rooms.get(ws.room), ws, m);
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

  ws.on('close', () => { cancelPending(ws); leave(ws); });
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

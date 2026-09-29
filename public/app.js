'use strict';
/* 옮겨 클라이언트
 * 전송: 기기끼리 WebRTC 데이터 채널로 직접 보내고, 안 되면 서버 WebSocket으로 중계합니다.
 * 암호화: 기기마다 ECDH 키를 만들어 상대와 AES-GCM 키를 합의합니다. 서버는 공개키만 전달하므로
 *         직접 연결이든 서버 경유든 서버가 내용을 볼 수 없습니다. (HTTPS에서만 가능)
 * 이어받기: 파일마다 고유 uid를 두고, 받는 쪽이 "어디까지 받았는지" 답하면 보내는 쪽이 그 지점부터 보냅니다.
 * 프레임: [종류 1바이트] 0=제어(평문) 1=조각(평문) 2=제어(암호) 3=조각(암호)
 *         조각 = [종류][fid 4바이트][(암호일 때) iv 12바이트][내용]
 */

const $ = (s, r = document) => r.querySelector(s);
const CHUNK_DC = 64 * 1024;          // 데이터 채널 조각 크기 (브라우저 간 호환 안전선)
const CHUNK_WS = 256 * 1024;         // 서버 중계 조각 크기
const READ_BLOCK = 1024 * 1024;      // 디스크에서 한 번에 읽는 크기
const HIGH_WATER = 4 * 1024 * 1024;  // 이만큼 쌓이면 잠시 멈춤
const LOW_WATER = 512 * 1024;
const MERGE_AT = 32 * 1024 * 1024;   // 받은 조각을 이만큼마다 Blob으로 묶어 메모리 절약
const P2P_WAIT = 6000;               // 직접 연결을 기다리는 시간
const MAX_RETRY = 8;                 // 같은 기기에 연결된 상태에서 재시도 횟수
const ZIP_LIMIT = 0xFFFFFFFF;        // zip(비압축, zip64 미지원) 한계
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// ---------- 저장소 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

// ---------- 기본 도구 ----------
const enc = new TextEncoder();
const dec = new TextDecoder();
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
const randStr = n => Array.from(crypto.getRandomValues(new Uint8Array(n)), b => ID_CHARS[b % ID_CHARS.length]).join('');
const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
function concat(...arrs) {
  let n = 0; for (const a of arrs) n += a.length;
  const out = new Uint8Array(n); let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function fmtSize(n) {
  if (n < 1024) return `${n}B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(0)}KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)}MB`;
  return `${(n / 1024 ** 3).toFixed(2)}GB`;
}
function ago(ts) {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}
const extOf = name => { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1] : 'file'; };
const cleanName = s => String(s || '이름 없는 파일').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 200);
const safePath = s => String(s || '').split(/[\\/]+/).filter(x => x && x !== '.' && x !== '..').map(cleanName).join('/').slice(0, 800);
function toast(msg, ms = 2600) {
  const el = document.createElement('div');
  el.className = 'toast'; el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), ms);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  let ok = false; try { ok = document.execCommand('copy'); } catch {}
  ta.remove(); return ok;
}

// CRC32 (zip에 필요, 받으면서 조금씩 계산)
const CRC_T = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(crc, u8) {
  let c = crc ^ 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_T[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// ---------- 기기 ----------
function detectDevice() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return { kind: 'phone', label: '아이폰' };
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return { kind: 'tablet', label: '아이패드' };
  if (/Android/.test(ua)) {
    const tablet = !/Mobile/.test(ua);
    const galaxy = /;\s*SM-/.test(ua);
    return { kind: tablet ? 'tablet' : 'phone', label: galaxy ? (tablet ? '갤럭시 탭' : '갤럭시') : (tablet ? '안드로이드 태블릿' : '안드로이드 폰') };
  }
  if (/Windows/.test(ua)) return { kind: 'pc', label: 'Windows PC' };
  if (/Macintosh/.test(ua)) return { kind: 'pc', label: 'Mac' };
  if (/CrOS/.test(ua)) return { kind: 'pc', label: '크롬북' };
  return { kind: 'pc', label: 'PC' };
}
const DEV = detectDevice();
const IS_MOBILE = DEV.kind !== 'pc';
const SESSION_DEV = randStr(16);   // 이 페이지가 살아 있는 동안 같은 기기로 알아보는 표식 (서버 재접속해도 유지)
let myName = store.get('omgyeo.name', DEV.label);

// ---------- 상태 ----------
const S = {
  ws: null, id: null, room: null, code: null, want: null, wsSince: null,
  peers: new Map(),          // 서버 연결 id -> peer
  feed: [],                  // 화면 목록 (최신이 앞)
  partials: new Map(),       // uid -> 받는 중/받은 파일
  fidMap: new Map(),         // `${peerId}:${fid}` -> 받는 파일
  bundlesIn: new Map(),      // `${dev}:${bid}` -> 받는 폴더
  parked: [],                // 상대가 끊겨서 멈춘 보내기 (같은 기기가 돌아오면 이어서)
  targets: null,             // null = 전체, Set = 고른 기기만
  fidSeq: 1, lan: null, pub: null,
};

// ---------- 종단간 암호화 ----------
const CRYPTO_OK = !!(globalThis.isSecureContext && globalThis.crypto && crypto.subtle);
let myKeys = null, myPub = null;
async function initCrypto() {
  if (!CRYPTO_OK) return;
  try {
    myKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
    myPub = b64(await crypto.subtle.exportKey('raw', myKeys.publicKey));
  } catch (err) { console.warn('crypto', err); myKeys = null; myPub = null; }
}
async function deriveKey(p) {
  if (!myKeys || !p.pub) return null;
  try {
    const peerKey = await crypto.subtle.importKey('raw', unb64(p.pub), { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerKey }, myKeys.privateKey, 256);
    const hk = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    const [a, b] = [myPub, p.pub].sort();
    p.key = await crypto.subtle.deriveKey(
      { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(a + b), info: enc.encode('omgyeo-e2e-v1') },
      hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    // 보안 코드: 두 공개키로 만든 숫자. 양쪽 화면에서 같으면 중간에서 키를 바꿔치기한 사람이 없음
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(`${a}|${b}`)));
    p.safety = String(((h[0] << 16) | (h[1] << 8) | h[2]) % 1000000).padStart(6, '0');
    renderPeers();
    return p.key;
  } catch (err) { console.warn('derive', err); return null; }
}
async function frameCtrl(p, obj) {
  const body = enc.encode(JSON.stringify(obj));
  if (!p.key) return concat([0], body);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, p.key, body));
  return concat([2], iv, ct);
}
async function frameChunk(p, fid, data) {
  const head = new Uint8Array(5);
  head[0] = p.key ? 3 : 1;
  new DataView(head.buffer).setUint32(1, fid);
  if (!p.key) return concat(head, data);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: head }, p.key, data));
  return concat(head, iv, ct);
}

// ---------- 서버 연결 ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onopen = () => {
    setNet(true);
    sendServer({ type: 'hello', name: myName, kind: DEV.kind, pub: myPub, dev: SESSION_DEV });
    if (S.want === 'create') sendServer({ type: 'create' });
    else if (S.want) sendServer({ type: 'join', ...S.want });
  };
  ws.onmessage = e => {
    if (typeof e.data === 'string') return onServer(JSON.parse(e.data));
    const u8 = new Uint8Array(e.data);
    const p = S.peers.get(String.fromCharCode(...u8.subarray(0, 8)));
    if (p) onFrame(p, u8.subarray(8));
  };
  ws.onclose = () => {
    setNet(false);
    const list = [...S.peers.values()];
    S.peers.clear();
    for (const p of list) closePeer(p);
    renderPeers();
    setTimeout(connect, 1500);
  };
}
function sendServer(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }

// 무료 서버는 잠들어 있으면 깨어나는 데 시간이 걸려서 안내를 띄움
let wakeTimer = null;
function setNet(on) {
  $('#net').classList.toggle('on', on);
  $('#net').title = on ? '서버에 연결됨' : '서버에 연결하는 중';
  if (on) { S.wsSince = null; clearInterval(wakeTimer); wakeTimer = null; $('#wake').hidden = true; return; }
  if (!S.wsSince) S.wsSince = Date.now();
  if (!wakeTimer) wakeTimer = setInterval(updateWake, 1000);
  updateWake();
}
function updateWake() {
  const s = Math.round((Date.now() - S.wsSince) / 1000);
  $('#wake').hidden = s < 2;
  const long = s >= 5;
  $('#wakeTitle').textContent = long ? '서버를 깨우는 중이에요' : '서버에 연결하는 중…';
  $('#wakeSub').textContent = long ? `무료 서버라 한동안 안 쓰면 잠들어요. 깨어나는 데 30초~1분 걸려요 · ${s}초` : '';
}

function onServer(m) {
  switch (m.type) {
    case 'welcome': S.id = m.id; break;
    case 'joined':
      S.room = m.room; S.code = m.code; S.id = m.you;
      S.want = { room: m.room };
      store.set('omgyeo.last', m.room);
      if (location.search) history.replaceState(null, '', location.pathname);
      for (const p of m.peers) addPeer(p, true);
      remember();
      show('room');
      renderPair(); renderPeers();
      break;
    case 'peer-joined':
      addPeer(m.peer, false);
      remember(); renderPeers();
      break;
    case 'peer-left': {
      const p = S.peers.get(m.id);
      if (p) { S.peers.delete(m.id); closePeer(p); toast(`${p.name} 연결 끊김`); }
      renderPeers();
      break;
    }
    case 'peer-renamed': {
      const p = S.peers.get(m.id);
      if (p) { p.name = m.name; remember(); renderPeers(); }
      break;
    }
    case 'signal': onSignal(m.from, m.data); break;
    case 'error':
      toast(m.message, 3500);
      if (m.code === 'nocode') { S.want = null; $('#codeInput').select(); }
      break;
  }
}

// ---------- 기기 간 연결 ----------
const alive = p => S.peers.get(p.id) === p;
function addPeer(info, initiator) {
  if (S.peers.has(info.id)) return;
  const p = {
    id: info.id, dev: info.dev || info.id, name: info.name, kind: info.kind, pub: info.pub,
    pc: null, dc: null, mode: 'connecting', queue: [], busy: false, pending: [],
    key: null, safety: null, waiters: new Map(), recvChain: Promise.resolve(), sendChain: Promise.resolve(),
  };
  S.peers.set(p.id, p);
  p.keyP = deriveKey(p);

  // 끊겼다 돌아온 기기면 멈춘 전송을 이어서
  const back = S.parked.filter(j => j.dev === p.dev);
  if (back.length) {
    S.parked = S.parked.filter(j => j.dev !== p.dev);
    for (const j of back) { j.peer = p.id; j.tries = 0; p.queue.push(j); }
    toast(`${p.name} 다시 연결됨 · 멈춘 전송을 이어서 보내요`);
    pump(p);
  } else if (!initiator) toast(`${p.name} 연결됨`);

  if (typeof RTCPeerConnection === 'undefined') { p.mode = 'relay'; return; }
  const pc = p.pc = new RTCPeerConnection({ iceServers: ICE });
  pc.onicecandidate = e => { if (e.candidate) sendServer({ type: 'signal', to: p.id, data: { candidate: e.candidate } }); };
  pc.ondatachannel = e => { p.dc = e.channel; setupChannel(p); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState) && alive(p) && p.mode === 'p2p') { p.mode = 'relay'; renderPeers(); }
  };
  if (initiator) {
    p.dc = pc.createDataChannel('omgyeo', { ordered: true });
    setupChannel(p);
    pc.createOffer()
      .then(o => pc.setLocalDescription(o))
      .then(() => sendServer({ type: 'signal', to: p.id, data: { sdp: pc.localDescription } }))
      .catch(err => console.warn('offer', err));
  }
  p.timer = setTimeout(() => { if (p.mode === 'connecting') { p.mode = 'relay'; renderPeers(); } }, P2P_WAIT);
}
function setupChannel(p) {
  const dc = p.dc;
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = LOW_WATER;
  dc.onopen = () => { p.mode = 'p2p'; clearTimeout(p.timer); renderPeers(); };
  dc.onclose = () => {
    if (!alive(p)) return;
    if (p.mode === 'p2p') { p.mode = 'relay'; renderPeers(); }
    rejectAll(p);   // 진행 중이던 전송은 서버 경유로 이어서 보냄
  };
  dc.onmessage = e => onFrame(p, new Uint8Array(e.data));
}
async function onSignal(from, d) {
  const p = S.peers.get(from);
  if (!p || !p.pc) return;
  try {
    if (d.sdp) {
      await p.pc.setRemoteDescription(d.sdp);
      if (d.sdp.type === 'offer') {
        await p.pc.setLocalDescription(await p.pc.createAnswer());
        sendServer({ type: 'signal', to: from, data: { sdp: p.pc.localDescription } });
      }
      for (const c of p.pending.splice(0)) await p.pc.addIceCandidate(c).catch(() => {});
    } else if (d.candidate) {
      if (p.pc.remoteDescription) await p.pc.addIceCandidate(d.candidate).catch(() => {});
      else p.pending.push(d.candidate);
    }
  } catch (err) { console.warn('signal', err); }
}
function closePeer(p) {
  clearTimeout(p.timer);
  rejectAll(p);
  try { p.dc && p.dc.close(); } catch {}
  try { p.pc && p.pc.close(); } catch {}
  for (const job of p.queue) {
    if (['done', 'cancelled', 'failed'].includes(job.state)) continue;
    job.state = 'paused';
    S.parked.push(job);
  }
  p.queue = [];
  for (const inc of S.partials.values()) if (inc.peerId === p.id && inc.state === 'receiving') inc.state = 'paused';
  scheduleFeed();
}

// ---------- 응답 기다리기 ----------
function waitFor(p, key, ms) {
  return new Promise((resolve, reject) => {
    const t = ms ? setTimeout(() => { p.waiters.delete(key); reject(new Error('timeout')); }, ms) : null;
    p.waiters.set(key, { resolve: v => { clearTimeout(t); resolve(v); }, reject: e => { clearTimeout(t); reject(e); } });
  });
}
function settle(p, key, v) { const w = p.waiters.get(key); if (w) { p.waiters.delete(key); w.resolve(v); } }
function rejectAll(p) { for (const w of p.waiters.values()) w.reject(new Error('closed')); p.waiters.clear(); }

// ---------- 보내기 통로 ----------
const via = p => (p.dc && p.dc.readyState === 'open' ? 'dc' : 'relay');
const canSend = (p, how) => alive(p) && (how === 'dc' ? p.dc && p.dc.readyState === 'open' : S.ws && S.ws.readyState === 1);
function rawSend(p, how, u8) {
  if (how === 'dc') return p.dc.send(u8);
  const out = new Uint8Array(8 + u8.length);
  for (let i = 0; i < 8; i++) out[i] = p.id.charCodeAt(i);
  out.set(u8, 8);
  S.ws.send(out);
}
function drain(p, how) {
  return new Promise(resolve => {
    if (how === 'dc') {
      if (!p.dc || p.dc.bufferedAmount < HIGH_WATER) return resolve();
      p.dc.addEventListener('bufferedamountlow', () => resolve(), { once: true });
      p.dc.addEventListener('close', () => resolve(), { once: true });
    } else {
      const tick = () => (!S.ws || S.ws.bufferedAmount < HIGH_WATER ? resolve() : setTimeout(tick, 15));
      tick();
    }
  });
}
// 제어 메시지는 기기마다 순서대로 (암호화가 비동기라 순서가 섞이지 않게)
function sendCtrl(p, obj, how) {
  const task = p.sendChain.then(async () => {
    await p.keyP;
    const h = how || via(p);
    const frame = await frameCtrl(p, obj);
    await drain(p, h);
    if (!canSend(p, h)) throw new Error('closed');
    rawSend(p, h, frame);
  });
  p.sendChain = task.catch(() => {});
  return task;
}

// ---------- 받은 프레임 처리 (기기마다 도착 순서대로) ----------
function onFrame(p, u8) {
  p.recvChain = p.recvChain.then(() => handleFrame(p, u8)).catch(err => console.warn('recv', err));
}
async function handleFrame(p, u8) {
  const t = u8[0];
  if (t === 0) return onCtrl(p, JSON.parse(dec.decode(u8.subarray(1))));
  if (t === 2) {
    const key = p.key || await p.keyP;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(1, 13) }, key, u8.subarray(13));
    return onCtrl(p, JSON.parse(dec.decode(pt)));
  }
  const fid = new DataView(u8.buffer, u8.byteOffset + 1, 4).getUint32(0);
  if (t === 1) return onChunk(p, fid, u8.subarray(5));
  if (t === 3) {
    const key = p.key || await p.keyP;
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: u8.subarray(5, 17), additionalData: u8.subarray(0, 5) }, key, u8.subarray(17));
    return onChunk(p, fid, new Uint8Array(pt));
  }
}
function onCtrl(p, m) {
  switch (m.t) {
    case 'file': return onFileOffer(p, m);
    case 'resume': return settle(p, `resume:${m.uid}`, m.from);
    case 'ack': return settle(p, `ack:${m.uid}`, true);
    case 'cancel': {
      const inc = S.partials.get(m.uid);
      if (inc && inc.state !== 'done') { inc.state = 'cancelled'; inc.parts = null; S.partials.delete(m.uid); scheduleFeed(); }
      return;
    }
    case 'text':
      addFeed({ kind: 'text', dir: 'in', text: String(m.text), peerName: p.name, time: Date.now() });
      toast(`${p.name}에서 글이 왔어요`);
      return;
  }
}

// ---------- 보내기 ----------
function targetPeers() {
  const all = [...S.peers.values()];
  return S.targets ? all.filter(p => S.targets.has(p.id)) : all;
}
function makeJob(p, file, path, extra) {
  return { kind: 'file', dir: 'out', uid: randStr(12), dev: p.dev, peer: p.id, peerName: p.name, file,
    name: cleanName(file.name), path, size: file.size, mime: file.type, done: 0, state: 'queued', time: Date.now(), ...extra };
}
// entries: [{ file, path }] — path에 '/'가 있으면 폴더 안의 파일
function sendEntries(entries) {
  if (!entries.length) return;
  const targets = targetPeers();
  if (!targets.length) return toast('먼저 받을 기기를 연결하세요.');
  const loose = entries.filter(e => !e.path.includes('/'));
  const groups = new Map();
  for (const e of entries) {
    if (!e.path.includes('/')) continue;
    const top = e.path.split('/')[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(e);
  }
  for (const p of targets) {
    for (const e of loose) {
      const job = makeJob(p, e.file, e.path);
      if (e.file.type.startsWith('image/')) job.thumb = URL.createObjectURL(e.file);
      addFeed(job);
      p.queue.push(job);
    }
    for (const [top, list] of groups) {
      const bid = randStr(10);
      const total = list.reduce((s, e) => s + e.file.size, 0);
      const b = { kind: 'bundle', dir: 'out', name: cleanName(top), count: list.length, total, size: total, jobs: [], peerName: p.name, time: Date.now(), state: 'queued', done: 0 };
      addFeed(b);
      for (const e of list) {
        const job = makeJob(p, e.file, e.path, { bid, bname: top, bcount: list.length, btotal: total, bundle: b });
        b.jobs.push(job);
        p.queue.push(job);
      }
    }
    pump(p);
  }
  keepAwake();
}
async function pump(p) {
  if (p.busy) return;
  p.busy = true;
  try {
    while (p.queue.length && alive(p)) {
      const job = p.queue[0];
      if (['done', 'cancelled', 'failed'].includes(job.state)) { p.queue.shift(); continue; }
      await sendJob(p, job);
      if (job.state === 'paused') {
        if (!alive(p)) break;          // 기기가 나갔으면 closePeer가 보관해 둠
        job.tries = (job.tries || 0) + 1;
        if (job.tries > MAX_RETRY) { job.state = 'failed'; p.queue.shift(); scheduleFeed(); continue; }
        await sleep(1200);
        continue;                      // 같은 파일을 받은 지점부터 다시
      }
      p.queue.shift();
    }
  } finally { p.busy = false; keepAwake(); scheduleFeed(); }
}
async function sendJob(p, job) {
  while (p.mode === 'connecting' && alive(p)) await sleep(100);
  if (!alive(p)) { job.state = 'paused'; return; }
  await p.keyP;
  const how = via(p);
  const chunk = how === 'dc' ? CHUNK_DC : CHUNK_WS;
  const fid = S.fidSeq++;
  job.how = how;
  const ackKey = `ack:${job.uid}`, resumeKey = `resume:${job.uid}`;
  try {
    const replyP = waitFor(p, resumeKey, 20000);
    const ackP = waitFor(p, ackKey, 0);
    ackP.catch(() => {});
    await sendCtrl(p, {
      t: 'file', uid: job.uid, fid, name: job.name, size: job.size, mime: job.mime, path: job.path,
      bid: job.bid, bname: job.bname, bcount: job.bcount, btotal: job.btotal,
    }, how);
    const from = await replyP;
    if (from < 0) { p.waiters.delete(ackKey); job.done = job.size; job.state = 'done'; return scheduleFeed(); }
    if (from > 0 && from < job.size) job.resumed = from;
    job.state = 'sending'; job.done = from; job.start = performance.now(); job.startDone = from;
    scheduleFeed();
    let off = from;
    while (off < job.size) {
      if (job.state === 'cancelled') { p.waiters.delete(ackKey); sendCtrl(p, { t: 'cancel', uid: job.uid }).catch(() => {}); return scheduleFeed(); }
      const block = new Uint8Array(await job.file.slice(off, off + READ_BLOCK).arrayBuffer());
      for (let i = 0; i < block.length; i += chunk) {
        const frame = await frameChunk(p, fid, block.subarray(i, i + chunk));
        await drain(p, how);
        if (!canSend(p, how)) throw new Error('closed');
        rawSend(p, how, frame);
      }
      off += block.length;
      job.done = off;
      scheduleFeed();
    }
    job.state = 'wait'; scheduleFeed();
    await Promise.race([ackP, sleep(90000).then(() => { throw new Error('ack timeout'); })]);
    job.state = 'done';
  } catch (err) {
    if (job.state !== 'cancelled' && job.state !== 'done') job.state = 'paused';
    p.waiters.delete(ackKey); p.waiters.delete(resumeKey);
  }
  scheduleFeed();
}
function sendText(text) {
  const targets = targetPeers();
  if (!targets.length) return toast('먼저 받을 기기를 연결하세요.');
  for (const p of targets) sendCtrl(p, { t: 'text', text }).catch(() => toast(`${p.name}에 보내지 못했어요`));
  addFeed({ kind: 'text', dir: 'out', text, peerName: targets.map(p => p.name).join(', '), time: Date.now() });
}

// ---------- 받기 ----------
function onFileOffer(p, m) {
  let inc = S.partials.get(m.uid);
  if (inc && inc.state === 'done') { sendCtrl(p, { t: 'resume', uid: m.uid, from: -1 }).catch(() => {}); return; }
  if (inc) for (const [k, v] of S.fidMap) if (v === inc) S.fidMap.delete(k);   // 끊기기 전 조각은 무시
  if (inc && inc.parts && inc.size === m.size) {
    inc.state = 'receiving'; inc.peerId = p.id; inc.peerName = p.name;
    inc.start = performance.now(); inc.startDone = inc.done;
    if (inc.done > 0) { inc.resumed = true; toast(`${inc.name} ${Math.floor((inc.done / inc.size) * 100)}%부터 이어받아요`); }
  } else {
    inc = {
      kind: 'file', dir: 'in', uid: m.uid, peerId: p.id, peerName: p.name, name: cleanName(m.name),
      path: m.path ? safePath(m.path) : null, size: Number(m.size) || 0, mime: m.mime || 'application/octet-stream',
      done: 0, parts: [], pendingBytes: 0, crc: 0, wantCrc: !!m.bid, state: 'receiving', time: Date.now(), start: performance.now(), startDone: 0,
    };
    S.partials.set(m.uid, inc);
    if (m.bid) {
      const key = `${p.dev}:${m.bid}`;
      let b = S.bundlesIn.get(key);
      if (!b) {
        b = { kind: 'bundle', dir: 'in', key, name: cleanName(m.bname), count: Number(m.bcount) || 1, total: Number(m.btotal) || 0, size: Number(m.btotal) || 0, files: [], peerName: p.name, time: Date.now(), state: 'receiving', done: 0 };
        S.bundlesIn.set(key, b);
        addFeed(b);
      }
      inc.bundle = b;
      b.files.push(inc);
    } else addFeed(inc);
  }
  S.fidMap.set(`${p.id}:${m.fid}`, inc);
  sendCtrl(p, { t: 'resume', uid: m.uid, from: inc.done }).catch(() => {});
  if (inc.size === 0) finishIncoming(p, inc);
  keepAwake(); scheduleFeed();
}
function onChunk(p, fid, data) {
  const inc = S.fidMap.get(`${p.id}:${fid}`);
  if (!inc || !inc.parts || inc.state !== 'receiving') return;
  inc.parts.push(data);
  inc.done += data.length;
  inc.pendingBytes += data.length;
  if (inc.wantCrc) inc.crc = crc32(inc.crc, data);
  if (inc.pendingBytes >= MERGE_AT) { inc.parts = [new Blob(inc.parts)]; inc.pendingBytes = 0; }
  if (inc.done >= inc.size) finishIncoming(p, inc);
  else scheduleFeed();
}
function finishIncoming(p, inc) {
  inc.blob = new Blob(inc.parts, { type: inc.mime });
  inc.parts = null;
  inc.state = 'done';
  inc.url = URL.createObjectURL(inc.blob);
  if (!inc.bundle && inc.mime.startsWith('image/')) inc.thumb = inc.url;
  for (const [k, v] of S.fidMap) if (v === inc) S.fidMap.delete(k);
  sendCtrl(p, { t: 'ack', uid: inc.uid }).catch(() => {});
  if (inc.bundle) {
    const b = inc.bundle;
    if (b.files.length === b.count && b.files.every(f => f.state === 'done')) toast(`${b.name} 폴더 받음 (파일 ${b.count}개)`);
  } else toast(`${inc.name} 받음`);
  scheduleFeed();
  keepAwake();
}

// ---------- zip (비압축) ----------
function buildZip(entries) {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.path);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8 이름
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
    ch.setUint16(28, name.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + e.size;
  }
  const cdSize = central.reduce((s, a) => s + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, entries.length, true); end.setUint16(10, entries.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
}

// ---------- 저장 ----------
async function saveBlobs(items) {   // items: [{ blob, name, mime }]
  if (!items.length) return;
  const files = items.map(it => new File([it.blob], it.name, { type: it.mime || it.blob.type }));
  if (IS_MOBILE && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return true; } catch (e) { if (e.name === 'AbortError') return false; }
  }
  for (const it of items) {
    const url = it.url || URL.createObjectURL(it.blob);
    const a = document.createElement('a');
    a.href = url; a.download = it.name;
    document.body.appendChild(a); a.click(); a.remove();
    if (!it.url) setTimeout(() => URL.revokeObjectURL(url), 60000);
    if (items.length > 1) await sleep(350);
  }
  return true;
}
async function saveBundleZip(b) {
  const files = b.files.filter(f => f.state === 'done');
  const blob = buildZip(files.map(f => ({ path: f.path || f.name, blob: f.blob, crc: f.crc, size: f.size })));
  if (await saveBlobs([{ blob, name: `${b.name}.zip`, mime: 'application/zip' }])) { b.saved = true; scheduleFeed(); }
}

// ---------- 화면: 공통 ----------
function show(which) {
  $('#home').hidden = which !== 'home';
  $('#room').hidden = which !== 'room';
  if (which === 'home') renderRecent();
}
$('#meName').textContent = myName;

// ---------- 화면: 홈 ----------
function remember() {
  if (!S.room) return;
  const list = store.get('omgyeo.recent', []);
  const old = list.find(r => r.room === S.room);
  const names = [...S.peers.values()].map(p => p.name);
  const entry = { room: S.room, names: names.length ? names : (old ? old.names : []), ts: Date.now() };
  store.set('omgyeo.recent', [entry, ...list.filter(r => r.room !== S.room)].slice(0, 6));
}
function renderRecent() {
  const list = store.get('omgyeo.recent', []).filter(r => r.names.length);
  $('#recentBox').hidden = !list.length;
  $('#recentList').innerHTML = list.map(r => `
    <li><div class="rn"><b>${esc(r.names.join(', '))}</b><small>${ago(r.ts)}</small></div>
    <button type="button" data-rejoin="${esc(r.room)}">다시 연결</button>
    <button type="button" class="x" data-forget="${esc(r.room)}" aria-label="목록에서 지우기">✕</button></li>`).join('');
}
$('#recentList').addEventListener('click', e => {
  const r = e.target.closest('[data-rejoin]');
  if (r) { S.want = { room: r.dataset.rejoin }; sendServer({ type: 'join', room: r.dataset.rejoin }); return; }
  const f = e.target.closest('[data-forget]');
  if (f) { store.set('omgyeo.recent', store.get('omgyeo.recent', []).filter(x => x.room !== f.dataset.forget)); renderRecent(); }
});
$('#createBtn').onclick = async () => { await loadInfo(); S.want = 'create'; sendServer({ type: 'create' }); };
$('#codeForm').onsubmit = e => {
  e.preventDefault();
  const code = $('#codeInput').value.replace(/\D/g, '');
  if (code.length !== 6) return toast('6자리 숫자를 입력하세요.');
  S.want = { code };
  sendServer({ type: 'join', code });
};
$('#codeInput').addEventListener('input', e => {
  e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6);
  if (e.target.value.length === 6) $('#codeForm').requestSubmit();
});

// ---------- 화면: 방 ----------
function joinUrl() {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const lanIp = /^(\d+\.){3}\d+$/.test(location.hostname);
  // localhost나 내부 IP로 열었으면 ngrok 공개 주소 → 와이파이 주소 순으로 QR에 넣음
  let base = location.origin;
  if ((local || lanIp) && S.pub) base = S.pub;
  else if (local && S.lan && S.lan.length) base = S.lan[0];
  return `${base}/?r=${S.room}`;
}
async function loadInfo() {
  try {
    const j = await (await fetch('/api/info')).json();
    S.lan = j.lan; S.pub = j.public;
  } catch {}
}
// 좁은 화면에서는 기기가 연결되면 QR을 접어서 보내기 영역이 먼저 보이게
let pairCollapsed = matchMedia('(max-width: 820px)').matches;
function renderPair() {
  if (!S.room) return;
  const url = joinUrl();
  const qrSrc = `/qr.svg?t=${encodeURIComponent(url)}`;
  if ($('#qr').getAttribute('src') !== qrSrc) $('#qr').src = qrSrc;
  $('#codeView').textContent = `${S.code.slice(0, 3)} ${S.code.slice(3)}`;
  $('#urlBtn').textContent = url.replace(/^https?:\/\//, '');
  const hasPeers = S.peers.size > 0;
  $('#pairTitle').textContent = hasPeers ? '기기 더 연결하기' : '다른 기기를 연결하세요';
  $('#pairToggle').hidden = !hasPeers;
  $('#pairBox').classList.toggle('compact', hasPeers && pairCollapsed);
  $('#pairToggle').textContent = pairCollapsed ? 'QR 보기' : '접기';
}
$('#pairToggle').onclick = () => { pairCollapsed = !pairCollapsed; renderPair(); };
$('#urlBtn').onclick = async () => { toast((await copyText(joinUrl())) ? '주소를 복사했어요' : '복사하지 못했어요'); };

const ICONS = {
  pc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
  tablet: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M11 18h2"/></svg>',
  folder: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z"/></svg>',
  lock: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>',
  unlock: '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 7.5-2"/></svg>',
};

function renderPeers() {
  const peers = [...S.peers.values()];
  $('#peerCount').textContent = peers.length;
  $('#emptyPeers').hidden = peers.length > 0;
  $('#peerList').innerHTML = peers.map(p => {
    const b = p.mode === 'p2p' ? ['p2p', '직접 연결'] : p.mode === 'relay' ? ['relay', '서버 경유'] : ['', '연결하는 중'];
    const lock = p.key
      ? `<span class="lock on">${ICONS.lock}종단간 암호화</span>`
      : `<span class="lock off">${ICONS.unlock}${CRYPTO_OK && p.pub ? '암호화 준비 중' : '암호화 안 됨'}</span>`;
    return `<li class="peer"><span class="ic">${ICONS[p.kind] || ICONS.pc}</span>
      <div class="pn"><b>${esc(p.name)}</b>
        <span class="badges"><span class="badge ${b[0]}"><i></i>${b[1]}</span>${lock}</span>
        ${p.safety ? `<span class="safety">보안 코드 <b>${p.safety.slice(0, 3)} ${p.safety.slice(3)}</b></span>` : ''}
      </div></li>`;
  }).join('');
  const anySafe = peers.some(p => p.safety);
  const anyPlain = peers.some(p => !p.key && p.mode !== 'connecting');
  $('#secHint').hidden = !(anySafe || anyPlain);
  $('#secHint').textContent = anySafe
    ? '두 기기 화면의 보안 코드가 같으면 중간에서 가로챈 사람이 없다는 뜻이에요. 파일은 서버를 거쳐도 서버가 내용을 볼 수 없어요.'
    : 'HTTPS 주소로 열어야 종단간 암호화가 켜져요.';

  if (S.targets) for (const id of [...S.targets]) if (!S.peers.has(id)) S.targets.delete(id);
  if (S.targets && !S.targets.size) S.targets = null;
  $('#targets').hidden = peers.length < 2;
  if (peers.length >= 2) {
    $('#targets').innerHTML = `<span class="lbl">받을 기기</span>
      <button type="button" class="tchip" data-t="all" aria-pressed="${!S.targets}">전체</button>` +
      peers.map(p => `<button type="button" class="tchip" data-t="${p.id}" aria-pressed="${!!(S.targets && S.targets.has(p.id))}">${esc(p.name)}</button>`).join('');
  }
  const none = peers.length === 0;
  $('#drop').classList.toggle('disabled', none);
  $('#folderBtn').disabled = none;
  $('#dropTitle').textContent = none ? '연결된 기기가 없어요' : IS_MOBILE ? '보낼 파일 고르기' : '파일이나 폴더를 끌어다 놓거나 눌러서 고르기';
  $('#dropSub').textContent = none ? 'QR이나 코드로 다른 기기를 먼저 연결하세요' : `${peers.length === 1 ? peers[0].name + '(으)로' : '고른 기기로'} 원본 그대로 보냅니다`;
  renderPair();
}
$('#targets').addEventListener('click', e => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  if (b.dataset.t === 'all') S.targets = null;
  else {
    if (!S.targets) S.targets = new Set();
    S.targets.has(b.dataset.t) ? S.targets.delete(b.dataset.t) : S.targets.add(b.dataset.t);
    if (!S.targets.size || S.targets.size === S.peers.size) S.targets = null;
  }
  renderPeers();
});

$('#leaveBtn').onclick = () => {
  sendServer({ type: 'leave' });
  const list = [...S.peers.values()];
  S.peers.clear();
  for (const p of list) closePeer(p);
  S.parked = [];
  S.room = null; S.want = null;
  store.del('omgyeo.last');
  show('home');
};

// ---------- 화면: 주고받은 목록 ----------
function addFeed(item) {
  S.feed.unshift(item);
  const li = document.createElement('li');
  item.el = li;
  $('#feed').prepend(li);
  buildItem(item);
  $('#feedEmpty').hidden = true;
  scheduleFeed();
}
function buildItem(it) {
  const li = it.el;
  li.className = `fi ${it.dir} ${it.kind}`;
  const arrow = it.dir === 'in' ? `<span class="dir in">← ${esc(it.peerName)}</span>` : `<span class="dir out">→ ${esc(it.peerName)}</span>`;
  if (it.kind === 'text') {
    li.innerHTML = `<div class="th">글</div>
      <div class="body"><div class="txt"></div><div class="meta">${arrow}</div></div>
      <div class="act">${it.dir === 'in' ? '<button type="button" class="solid" data-a="copy">복사</button>' : '<span class="st done">보냄</span>'}</div>`;
    li.querySelector('.txt').textContent = it.text;
    if (it.dir === 'in' && /^https?:\/\/\S+$/.test(it.text.trim())) li.querySelector('.act').insertAdjacentHTML('afterbegin', '<button type="button" data-a="open">열기</button>');
    return;
  }
  li.innerHTML = `<div class="th"></div>
    <div class="body"><div class="nm"></div><div class="meta">${arrow}<span class="sz"></span></div><div class="bar"><i></i></div></div>
    <div class="act"></div>`;
  li.querySelector('.nm').textContent = it.kind === 'bundle' ? `${it.name}/` : it.name;
  it.refs = { th: li.querySelector('.th'), sz: li.querySelector('.sz'), bar: li.querySelector('.bar'), fill: li.querySelector('.bar i'), act: li.querySelector('.act') };
  it.shown = {};
}
// 폴더는 안의 파일들 상태를 모아서 하나로 보여 줌
function bundleState(b) {
  const list = b.dir === 'out' ? b.jobs : b.files;
  b.done = list.reduce((s, x) => s + (x.state === 'done' ? x.size : x.done), 0);
  const has = st => list.some(x => x.state === st);
  const doneCount = list.filter(x => x.state === 'done').length;
  b.doneCount = doneCount;
  if (b.dir === 'out') {
    if (list.every(x => x.state === 'cancelled')) b.state = 'cancelled';
    else if (doneCount === list.length) b.state = 'done';
    else if (has('sending')) b.state = 'sending';
    else if (has('paused')) b.state = 'paused';
    else if (has('wait')) b.state = 'wait';
    else if (has('queued')) b.state = 'queued';
    else b.state = 'failed';
  } else {
    if (has('cancelled') && !has('receiving')) b.state = 'cancelled';
    else if (doneCount === b.count) b.state = 'done';
    else if (has('paused') && !has('receiving')) b.state = 'paused';
    else b.state = 'receiving';
  }
  if ((b.state === 'sending' || b.state === 'receiving') && !b.start) { b.start = performance.now(); b.startDone = b.done; }
}
function updateItem(it) {
  if (!it.refs) return;
  if (it.kind === 'bundle') bundleState(it);
  const r = it.refs;
  if (it.kind === 'bundle') { if (!it.shown.thumb) { r.th.innerHTML = ICONS.folder; it.shown.thumb = 1; } }
  else if (it.thumb && it.shown.thumb !== it.thumb) { r.th.innerHTML = `<img alt="" src="${it.thumb}">`; it.shown.thumb = it.thumb; }
  else if (!it.thumb && !it.shown.thumb) { r.th.textContent = extOf(it.name); it.shown.thumb = '-'; }

  const pct = it.size ? Math.min(100, (it.done / it.size) * 100) : (it.state === 'done' ? 100 : 0);
  r.fill.style.width = `${pct}%`;
  let sz = it.kind === 'bundle' ? `파일 ${it.count}개 · ${fmtSize(it.size)}` : fmtSize(it.size);
  if ((it.state === 'sending' || it.state === 'receiving') && it.start) {
    const secs = (performance.now() - it.start) / 1000;
    const speed = (it.done - (it.startDone || 0)) / Math.max(secs, 0.001);
    sz = `${fmtSize(it.done)} / ${fmtSize(it.size)}`;
    if (secs > 0.5) sz += ` · ${fmtSize(speed)}/s`;
    if (it.kind === 'bundle') sz = `${it.doneCount}/${it.count}개 · ${sz}`;
  } else if (it.state === 'paused' && it.size) sz = `${Math.floor(pct)}%에서 멈춤 · ${fmtSize(it.size)}`;
  if (it.resumed && it.state !== 'done') sz += it.dir === 'out' ? ' · 이어서 보내는 중' : ' · 이어받는 중';
  if (it.shown.sz !== sz) { r.sz.textContent = `· ${sz}`; it.shown.sz = sz; }
  r.bar.hidden = !['sending', 'receiving', 'queued', 'wait', 'paused'].includes(it.state);
  r.bar.classList.toggle('paused', it.state === 'paused');

  const key = `${it.state}:${it.saved ? 1 : 0}`;
  if (it.shown.act === key) return;
  it.shown.act = key;
  const L = {
    queued: '<span class="st">대기 중</span><button type="button" data-a="cancel">취소</button>',
    sending: '<button type="button" data-a="cancel">취소</button>',
    wait: '<span class="st">확인 중</span>',
    receiving: '<span class="st">받는 중</span>',
    paused: `<span class="st warn">끊김 · 다시 연결되면 이어서</span><button type="button" data-a="cancel">취소</button>`,
    failed: '<span class="st fail">실패</span>',
    cancelled: '<span class="st fail">취소됨</span>',
  };
  if (it.state === 'done') {
    if (it.dir === 'out') r.act.innerHTML = '<span class="st done">전달 완료</span>';
    else if (it.kind === 'bundle') {
      const zipOk = it.size < ZIP_LIMIT && it.count < 65535;
      r.act.innerHTML = (zipOk ? `<button type="button" class="${it.saved ? '' : 'solid'}" data-a="zip">${it.saved ? 'zip 다시 저장' : 'zip으로 저장'}</button>` : '') +
        `<button type="button" class="${zipOk ? '' : 'solid'}" data-a="each">파일 각각 저장</button>`;
    } else {
      const viewable = /^(image|video|audio|text)\/|pdf$/.test(it.mime);
      r.act.innerHTML = (viewable && !IS_MOBILE ? '<button type="button" data-a="view">열기</button>' : '') +
        `<button type="button" class="${it.saved ? '' : 'solid'}" data-a="save">${it.saved ? '다시 저장' : '저장'}</button>`;
    }
  } else r.act.innerHTML = L[it.state] || '';
}
let feedQueued = false;
function scheduleFeed() {
  if (feedQueued) return;
  feedQueued = true;
  // 백그라운드 탭에서는 requestAnimationFrame이 멈추므로 타이머로 대신 갱신
  const next = document.hidden ? cb => setTimeout(cb, 250) : requestAnimationFrame;
  next(() => {
    feedQueued = false;
    for (const it of S.feed) updateItem(it);
    const unsaved = S.feed.filter(it => it.dir === 'in' && it.kind === 'file' && it.state === 'done' && !it.saved);
    $('#saveAllBtn').hidden = unsaved.length < 2;
    $('#saveAllBtn').textContent = `받은 파일 ${unsaved.length}개 모두 저장`;
  });
}
function cancelItem(it) {
  const jobs = it.kind === 'bundle' ? (it.dir === 'out' ? it.jobs : it.files) : [it];
  for (const j of jobs) {
    if (['done', 'failed'].includes(j.state)) continue;
    j.state = 'cancelled';
    if (j.dir === 'in') {
      j.parts = null; S.partials.delete(j.uid);
      const p = S.peers.get(j.peerId);
      if (p) sendCtrl(p, { t: 'cancel', uid: j.uid }).catch(() => {});
    }
  }
  S.parked = S.parked.filter(j => j.state !== 'cancelled');
  scheduleFeed();
}
$('#feed').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const it = S.feed.find(x => x.el === b.closest('li'));
  if (!it) return;
  const a = b.dataset.a;
  if (a === 'cancel') cancelItem(it);
  else if (a === 'save') { if (await saveBlobs([it])) { it.saved = true; scheduleFeed(); } }
  else if (a === 'zip') saveBundleZip(it);
  else if (a === 'each') { if (await saveBlobs(it.files.filter(f => f.state === 'done').map(f => ({ blob: f.blob, name: f.name, mime: f.mime, url: f.url })))) { it.saved = true; scheduleFeed(); } }
  else if (a === 'view') window.open(it.url, '_blank', 'noopener');
  else if (a === 'copy') toast((await copyText(it.text)) ? '복사했어요' : '복사하지 못했어요. 글을 길게 눌러 복사하세요.');
  else if (a === 'open') window.open(it.text.trim(), '_blank', 'noopener');
});
$('#saveAllBtn').onclick = async () => {
  const list = S.feed.filter(it => it.dir === 'in' && it.kind === 'file' && it.state === 'done' && !it.saved).reverse();
  if (await saveBlobs(list)) { for (const it of list) it.saved = true; scheduleFeed(); }
};

// ---------- 입력: 파일·폴더 고르기, 끌어다 놓기, 붙여넣기 ----------
const toEntries = files => [...files].map(f => ({ file: f, path: safePath(f.webkitRelativePath || f.name) || cleanName(f.name) }));
$('#fileInput').addEventListener('change', e => { sendEntries(toEntries(e.target.files)); e.target.value = ''; });
$('#folderInput').addEventListener('change', e => { sendEntries(toEntries(e.target.files)); e.target.value = ''; });
$('#folderBtn').onclick = () => { if (!S.peers.size) return toast('먼저 다른 기기를 연결하세요.'); $('#folderInput').click(); };
if (!('webkitdirectory' in document.createElement('input')) || IS_MOBILE) $('#folderBtn').hidden = true;
$('#drop').addEventListener('click', e => { if (!S.peers.size) { e.preventDefault(); toast('먼저 다른 기기를 연결하세요.'); } });

// 폴더를 끌어다 놓으면 안쪽 파일까지 경로와 함께 모음
async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const f = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ file: f, path: safePath(prefix + f.name) });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const child of batch) await walkEntry(child, `${prefix}${entry.name}/`, out);
    }
  }
}
async function entriesFromDrop(dt) {
  const roots = [...dt.items].filter(i => i.kind === 'file').map(i => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null));
  if (!roots.some(r => r && r.isDirectory)) return toEntries(dt.files);
  const out = [];
  for (const r of roots) if (r) await walkEntry(r, '', out);
  return out;
}
let dragDepth = 0;
addEventListener('dragenter', e => { if (!S.room || !e.dataTransfer.types.includes('Files')) return; dragDepth++; $('#dropVeil').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropVeil').hidden = true; } });
addEventListener('dragover', e => { if (S.room) e.preventDefault(); });
addEventListener('drop', e => {
  if (!S.room) return;
  e.preventDefault(); dragDepth = 0; $('#dropVeil').hidden = true;
  const dt = e.dataTransfer;
  const pending = entriesFromDrop(dt);   // webkitGetAsEntry는 이벤트 안에서 바로 불러야 해서 먼저 호출
  pending.then(sendEntries).catch(() => toast('폴더를 읽지 못했어요.'));
});
addEventListener('paste', e => {
  if (!S.room || !e.clipboardData || !e.clipboardData.files.length) return;
  e.preventDefault();
  sendEntries(toEntries(e.clipboardData.files));
});

const ta = $('#textInput');
ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = `${Math.min(ta.scrollHeight, 140)}px`; });
ta.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !IS_MOBILE && !e.isComposing) { e.preventDefault(); $('#textForm').requestSubmit(); } });
$('#textForm').onsubmit = e => {
  e.preventDefault();
  const text = ta.value.trim();
  if (!text) return;
  sendText(text);
  ta.value = ''; ta.style.height = 'auto';
};

// ---------- 이름 바꾸기 ----------
$('#meBtn').onclick = () => { $('#nameInput').value = myName; $('#nameDlg').showModal(); $('#nameInput').select(); };
$('#nameForm').addEventListener('submit', e => {
  if (e.submitter && e.submitter.value !== 'ok') return;
  const v = $('#nameInput').value.trim();
  if (!v) return;
  myName = v.slice(0, 30);
  store.set('omgyeo.name', myName);
  $('#meName').textContent = myName;
  sendServer({ type: 'rename', name: myName });
});

// ---------- 전송 중 화면 꺼짐 방지, 나가기 경고 ----------
let wakeLock = null;
function busy() { return S.feed.some(it => ['sending', 'receiving', 'queued', 'wait', 'paused'].includes(it.state)); }
async function keepAwake() {
  if (busy()) {
    if (!wakeLock && navigator.wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } catch {} }
  } else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
addEventListener('beforeunload', e => { if (busy()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- 시작 ----------
(async function start() {
  // 앱 화면을 캐시해 두어 서버가 잠들어 있어도 화면은 바로 뜨게 함
  if ('serviceWorker' in navigator && globalThis.isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
  const r = new URLSearchParams(location.search).get('r');
  const last = store.get('omgyeo.last', null);
  if (r && /^[a-z0-9]{10}$/.test(r)) S.want = { room: r };
  else if (last) S.want = { room: last };      // 지난번 연결로 자동 재접속
  show('home');
  setNet(false);
  await initCrypto();
  connect();
  loadInfo();
})();

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
// 다음 화면 갱신 때 실행. 창이 가려지거나 최소화되면 requestAnimationFrame이 멈추므로 타이머로도 보장
function nextFrame(cb) {
  let done = false;
  const run = () => { if (!done) { done = true; cb(); } };
  requestAnimationFrame(run);
  setTimeout(run, 120);
}
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
// 이 브라우저를 계속 같은 PC로 알아보는 표식 (폴더 동기화 짝 기억용)
const PERSIST_ID = store.get('omgyeo.pid', null) || (() => { const v = randStr(16); store.set('omgyeo.pid', v); return v; })();

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
    sendServer({ type: 'hello', name: myName, kind: DEV.kind, pub: myPub, dev: SESSION_DEV, caps: { fs: FS_OK, pid: PERSIST_ID } });
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
      showRoom(m.room);
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
  p.caps = info.caps || {};
  p.keyP = deriveKey(p);
  setTimeout(() => { if (alive(p) && typeof Sync !== 'undefined') Sync.onPeerJoined(p); }, 0);
  setTimeout(() => sendTombs(p), 500);

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
  if (typeof Sync !== 'undefined') Sync.onPeerLeft(p);
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
    let h = how || via(p);
    const frame = await frameCtrl(p, obj);
    await drain(p, h);
    // 통로를 지정하지 않은 메시지(확인 응답 등)는 직접 연결이 막 닫혔으면 서버 경유로 보내서 유실되지 않게
    if (!canSend(p, h) && !how && h === 'dc') h = 'relay';
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
  if (typeof m.t === 'string' && m.t.startsWith('sync-')) return typeof Sync !== 'undefined' ? Sync.onCtrl(p, m) : undefined;
  switch (m.t) {
    case 'file': return onFileOffer(p, m);
    case 'resume': return settle(p, `resume:${m.uid}`, m.from);
    case 'ack': return settle(p, `ack:${m.uid}`, true);
    case 'cancel': {
      const inc = S.partials.get(m.uid);
      if (inc && inc.state !== 'done') { inc.state = 'cancelled'; inc.parts = null; S.partials.delete(m.uid); scheduleFeed(); }
      return;
    }
    case 'msg-del':   // 상대가 지운 메시지 (지금 지웠으면 live: 이 기기의 지금 시각까지 지움)
      return applyDelete(S.room, (m.mids || []).map(String).slice(0, 5000), m.clear ? (m.live ? Date.now() : Number(m.clear)) : 0);
    case 'text':
      { const it = { kind: 'text', dir: 'in', mid: m.mid ? String(m.mid).slice(0, 40) : null, text: String(m.text), peerName: p.name, time: Date.now() }; addFeed(it); persistItem(it); }
      toast(`${p.name}에서 글이 왔어요`);
      announce(`${p.name}에서 글이 왔어요`, String(m.text).slice(0, 120));
      return;
  }
}

// ---------- 보내기 ----------
function targetPeers() {
  const all = [...S.peers.values()];
  return S.targets ? all.filter(p => S.targets.has(p.id)) : all;
}
function makeJob(p, file, path, extra) {
  const uid = randStr(12);
  return { kind: 'file', dir: 'out', uid, mid: extra && extra.bid ? null : uid, dev: p.dev, peer: p.id, peerName: p.name, file,
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
      const b = { kind: 'bundle', dir: 'out', mid: `b${bid}`, name: cleanName(top), count: list.length, total, size: total, jobs: [], peerName: p.name, time: Date.now(), state: 'queued', done: 0 };
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
    if (from < 0) { p.waiters.delete(ackKey); job.done = job.size; job.state = 'done'; onOutDone(job); return scheduleFeed(); }
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
    onOutDone(job);
  } catch (err) {
    if (job.state !== 'cancelled' && job.state !== 'done') job.state = 'paused';
    p.waiters.delete(ackKey); p.waiters.delete(resumeKey);
  }
  scheduleFeed();
}
function sendText(text) {
  const targets = targetPeers();
  if (!targets.length) return toast('먼저 받을 기기를 연결하세요.');
  const mid = randStr(12);
  for (const p of targets) sendCtrl(p, { t: 'text', text, mid }).catch(() => toast(`${p.name}에 보내지 못했어요`));
  const it = { kind: 'text', dir: 'out', mid, text, peerName: targets.map(p => p.name).join(', '), time: Date.now() };
  addFeed(it);
  persistItem(it);
}

// ---------- 받기 ----------
// 받는 폴더를 지정해 두었으면(PC 크롬·엣지) 메모리에 모으지 않고 디스크에 바로 씀
async function openDiskWriter(inc) {
  if (!S.dl || !S.dl.ok) return false;
  try {
    let fh;
    if (inc.bundle) {
      const b = inc.bundle;
      if (!b.diskDir) {   // 같은 이름 폴더가 있으면 "이름 (1)"
        let name = b.name;
        for (let i = 1; i < 1000; i++) {
          try { await S.dl.handle.getDirectoryHandle(name); name = `${b.name} (${i})`; } catch { break; }
        }
        b.diskDir = await S.dl.handle.getDirectoryHandle(name, { create: true });
        b.diskName = name;
      }
      const rel = (inc.path || inc.name).split('/').slice(1).join('/') || inc.name;
      fh = await fileHandleAt(b.diskDir, rel, true);
    } else fh = await uniqueFileHandle(S.dl.handle, inc.name);
    inc.fh = fh;
    inc.writer = await fh.createWritable();
    inc.onDisk = true;
    inc.wantCrc = false;
    inc.parts = null;
    return true;
  } catch (err) {
    console.warn('disk', err);
    toast('받는 폴더에 쓰지 못해서 브라우저 메모리로 받아요.');
    return false;
  }
}
async function onFileOffer(p, m) {
  let inc = S.partials.get(m.uid);
  if (inc && inc.state === 'done') { sendCtrl(p, { t: 'resume', uid: m.uid, from: -1 }).catch(() => {}); return; }
  if (inc) for (const [k, v] of S.fidMap) if (v === inc) S.fidMap.delete(k);   // 끊기기 전 조각은 무시
  if (inc && (inc.parts || inc.writer) && inc.size === m.size && inc.state !== 'cancelled') {
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
        b = { kind: 'bundle', dir: 'in', key, mid: `b${String(m.bid).slice(0, 20)}`, name: cleanName(m.bname), count: Number(m.bcount) || 1, total: Number(m.btotal) || 0, size: Number(m.btotal) || 0, files: [], peerName: p.name, time: Date.now(), state: 'receiving', done: 0 };
        S.bundlesIn.set(key, b);
        addFeed(b);
      }
      inc.bundle = b;
      b.files.push(inc);
    } else addFeed(inc);
    await openDiskWriter(inc);
  }
  S.fidMap.set(`${p.id}:${m.fid}`, inc);
  sendCtrl(p, { t: 'resume', uid: m.uid, from: inc.done }).catch(() => {});
  if (inc.size === 0) await finishIncoming(p, inc);
  keepAwake(); scheduleFeed();
}
async function onChunk(p, fid, data) {
  const key = `${p.id}:${fid}`;
  if (typeof Sync !== 'undefined' && Sync.fidMap.has(key)) return Sync.onChunk(p, fid, data);
  const inc = S.fidMap.get(key);
  if (!inc || inc.state !== 'receiving') return;
  if (inc.writer) {
    try { await inc.writer.write(data); } catch (err) {
      console.warn('disk write', err);
      inc.state = 'failed'; inc.writer.abort().catch(() => {}); inc.writer = null;
      S.partials.delete(inc.uid);
      sendCtrl(p, { t: 'cancel', uid: inc.uid }).catch(() => {});
      toast(`${inc.name}을(를) 디스크에 쓰지 못했어요. 남은 공간을 확인하세요.`);
      return scheduleFeed();
    }
  } else if (inc.parts) {
    inc.parts.push(data);
    inc.pendingBytes += data.length;
    if (inc.pendingBytes >= MERGE_AT) { inc.parts = [new Blob(inc.parts)]; inc.pendingBytes = 0; }
  } else return;
  inc.done += data.length;
  if (inc.wantCrc) inc.crc = crc32(inc.crc, data);
  if (inc.done >= inc.size) return finishIncoming(p, inc);
  scheduleFeed();
}
async function finishIncoming(p, inc) {
  if (inc.writer) {
    try {
      await inc.writer.close();
      inc.blob = await inc.fh.getFile();   // 디스크에 있는 파일을 가리킴 (메모리에 올리지 않음)
      inc.saved = true;
    } catch (err) {
      console.warn('disk close', err);
      inc.state = 'failed'; inc.writer = null; S.partials.delete(inc.uid);
      toast(`${inc.name}을(를) 저장하지 못했어요.`);
      return scheduleFeed();
    }
    inc.writer = null;
  } else {
    inc.blob = new Blob(inc.parts, { type: inc.mime });
    inc.parts = null;
  }
  inc.state = 'done';
  inc.url = URL.createObjectURL(inc.blob);
  if (!inc.bundle && inc.mime.startsWith('image/')) inc.thumb = inc.url;
  for (const [k, v] of S.fidMap) if (v === inc) S.fidMap.delete(k);
  sendCtrl(p, { t: 'ack', uid: inc.uid }).catch(() => {});
  if (inc.bundle) {
    const b = inc.bundle;
    if (b.files.length === b.count && b.files.every(f => f.state === 'done')) {
      bundleState(b);
      persistItem(b);
      toast(`${b.name} 폴더 받음 (파일 ${b.count}개)`);
      announce(`${p.name}에서 폴더를 보냈어요`, `${b.name} · 파일 ${b.count}개`);
    }
  } else {
    persistItem(inc);
    toast(inc.onDisk ? `${inc.name} 받아서 저장함` : `${inc.name} 받음`);
    announce(`${p.name}에서 파일을 보냈어요`, `${inc.name} · ${fmtSize(inc.size)}`);
  }
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
    // UTF-8 이름 표시를 무시하는 오래된 압축 프로그램용 Unicode Path 확장 필드(0x7075)
    const extra = new DataView(new ArrayBuffer(9 + name.length));
    extra.setUint16(0, 0x7075, true); extra.setUint16(2, 5 + name.length, true);
    extra.setUint8(4, 1); extra.setUint32(5, crc32(0, name), true);
    new Uint8Array(extra.buffer).set(name, 9);
    const ex = new Uint8Array(extra.buffer);
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); // UTF-8 이름
    lh.setUint16(8, 0, true); lh.setUint16(10, dosTime, true); lh.setUint16(12, dosDate, true);
    lh.setUint32(14, e.crc, true); lh.setUint32(18, e.size, true); lh.setUint32(22, e.size, true);
    lh.setUint16(26, name.length, true); lh.setUint16(28, ex.length, true);
    parts.push(new Uint8Array(lh.buffer), name, ex, e.blob);
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, 0, true); ch.setUint16(12, dosTime, true); ch.setUint16(14, dosDate, true);
    ch.setUint32(16, e.crc, true); ch.setUint32(20, e.size, true); ch.setUint32(24, e.size, true);
    ch.setUint16(28, name.length, true); ch.setUint16(30, ex.length, true); ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name, ex);
    offset += 30 + name.length + ex.length + e.size;
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
  document.body.classList.toggle('in-room', which === 'room');
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
    <li><div class="rn"><b>${esc(r.names.join(', '))}</b><small>${ago(r.ts)}<span data-count="${esc(r.room)}"></span></small></div>
    <button type="button" data-rejoin="${esc(r.room)}">다시 연결</button>
    <button type="button" class="x" data-forget="${esc(r.room)}" aria-label="연결과 기록 지우기" title="연결과 기록 지우기">✕</button></li>`).join('');
  if (navigator.storage && navigator.storage.estimate) navigator.storage.estimate().then(e => {
    $('#storageInfo').textContent = `이 브라우저에 저장된 기록·파일 ${fmtSize(e.usage || 0)}${e.quota ? ` · 사용 가능 ${fmtSize(e.quota)}` : ''}`;
  }).catch(() => {});
  for (const r of list) idb.msgList(r.room).then(recs => recs.filter(x => !x.owner || x.owner === PERSIST_ID).length).then(n => {
    const el = document.querySelector(`[data-count="${r.room}"]`);
    if (el && n) el.textContent = ` · 기록 ${n}개`;
  });
}
$('#recentList').addEventListener('click', e => {
  const r = e.target.closest('[data-rejoin]');
  if (r) { S.want = { room: r.dataset.rejoin }; sendServer({ type: 'join', room: r.dataset.rejoin }); return; }
  const f = e.target.closest('[data-forget]');
  if (f) {
    idb.msgDelRoom(f.dataset.forget);
    store.set('omgyeo.recent', store.get('omgyeo.recent', []).filter(x => x.room !== f.dataset.forget));
    renderRecent();
    toast('연결과 기록을 지웠어요');
  }
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
  $('#emptyTitle').textContent = none ? '먼저 다른 기기를 연결하세요 · QR이나 6자리 코드로 연결해요'
    : IS_MOBILE ? '＋를 눌러 파일을 보내거나 아래에 글을 입력하세요' : '파일이나 폴더를 여기로 끌어다 놓거나 ＋를 눌러 보내세요';
  const narrow = matchMedia('(max-width: 520px)').matches;
  $('#textInput').placeholder = none ? (narrow ? '기기를 먼저 연결하세요' : '기기를 연결하면 글을 보낼 수 있어요')
    : narrow ? '메시지 보내기' : `${peers.length === 1 ? peers[0].name : '연결된 기기'}에 글, 링크, 계좌번호 보내기`;
  // 폰: 연결 정보는 위쪽 버튼으로 펼침. 기기가 없으면 펼치고, 처음 연결되면 접어서 대화창이 화면을 채우게
  $('#sideSummary').textContent = none ? '연결 정보 · QR로 기기 연결하기' : `${peers.map(p => p.name).join(', ')} 연결됨`;
  $('#sideToggle').classList.toggle('on', !none);
  if (none && !S.sideTouched) setSide(true);
  else if (!none && S.lastPeerCount === 0 && !S.sideTouched) setSide(false);
  S.lastPeerCount = peers.length;
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
  showRoom(null);
  store.del('omgyeo.last');
  show('home');
};

// ---------- 화면: 대화창 (채팅 형식) ----------
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const hhmm = t => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const dayLabel = t => { const d = new Date(t); return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEK[d.getDay()]}요일`; };
const dayKey = t => new Date(t).toDateString();
const feedBox = () => $('#feed');
let stick = true;   // 맨 아래를 보고 있으면 새 메시지가 올 때 따라 내려감
function nearBottom() { const f = feedBox(); return f.scrollHeight - f.scrollTop - f.clientHeight < 80; }
function scrollBottom() { const f = feedBox(); f.scrollTop = f.scrollHeight; $('#newMsg').hidden = true; stick = true; }
feedBox().addEventListener('scroll', () => { stick = nearBottom(); if (stick) $('#newMsg').hidden = true; });
$('#newMsg').onclick = scrollBottom;

function addFeed(item, restoring) {
  item.time = item.time || Date.now();
  if (!item.room) item.room = S.room;
  const wasBottom = stick || nearBottom();
  S.feed.push(item);
  if (S.lastDay !== dayKey(item.time)) {
    S.lastDay = dayKey(item.time);
    const sep = document.createElement('li');
    sep.className = 'day';
    sep.textContent = dayLabel(item.time);
    feedBox().appendChild(sep);
  }
  const li = document.createElement('li');
  item.el = li;
  feedBox().appendChild(li);
  buildItem(item);
  $('#feedEmpty').hidden = true;
  scheduleFeed();
  if (restoring) return;
  if (wasBottom || item.dir === 'out') nextFrame(scrollBottom);
  else $('#newMsg').hidden = false;
}
function clearFeed() {
  for (const it of S.feed) { if (it.restored && it.url) URL.revokeObjectURL(it.url); }
  S.feed = [];
  S.lastDay = null;
  feedBox().innerHTML = '';
  $('#feedEmpty').hidden = false;
  $('#newMsg').hidden = true;
}
function buildItem(it) {
  const li = it.el;
  li.className = `msg ${it.dir} ${it.kind}`;
  const who = it.dir === 'in' ? esc(it.peerName) : `→ ${esc(it.peerName)}`;
  if (it.kind === 'text') {
    const isUrl = /^https?:\/\/\S+$/.test(it.text.trim());
    li.innerHTML = `<div class="who">${who}</div>
      <div class="row"><div class="bubble"><div class="txt"></div>
        <div class="act">${isUrl ? '<button type="button" data-a="open">열기</button>' : ''}<button type="button" data-a="copy">복사</button><button type="button" class="del-btn" data-a="del" title="모두에게서 삭제">삭제</button></div></div>
      <span class="time">${hhmm(it.time)}</span></div>`;
    li.querySelector('.txt').textContent = it.text;
    return;
  }
  li.innerHTML = `<div class="who">${who}</div>
    <div class="row"><div class="bubble">
      <div class="fcard"><div class="th"></div>
        <div class="body"><div class="nm"></div><div class="meta"><span class="sz"></span></div><div class="bar"><i></i></div></div></div>
      <div class="act"></div></div>
    <span class="time">${hhmm(it.time)}</span></div>`;
  li.querySelector('.nm').textContent = it.kind === 'bundle' ? `${it.name}/` : it.name;
  it.refs = { card: li.querySelector('.fcard'), th: li.querySelector('.th'), sz: li.querySelector('.sz'), bar: li.querySelector('.bar'), fill: li.querySelector('.bar i'), act: li.querySelector('.act') };
  it.shown = {};
}

// ---------- 연결(방)별 기록: 이 브라우저의 IndexedDB에만 저장 ----------
const SAVE_MAX = 200 * 1024 * 1024;   // 파일 내용은 항목당 200MB까지만 보관 (넘으면 기록만)
async function persistItem(it) {
  if (!it || it.persisted || !it.room) return;
  it.persisted = true;
  const mid = it.mid || (it.kind === 'file' ? it.uid : null) || randStr(12);
  it.mid = mid;
  const rec = { id: `${PERSIST_ID}:${mid}`, mid, room: it.room, owner: PERSIST_ID, time: it.time, kind: it.kind, dir: it.dir, peerName: it.peerName };
  if (it.kind === 'text') rec.text = it.text;
  else if (it.kind === 'file') {
    Object.assign(rec, { name: it.name, size: it.size, mime: it.mime, onDisk: !!it.onDisk });
    const blob = it.dir === 'out' ? it.file : it.blob;
    if (it.fh) rec.fh = it.fh;
    else if (blob && it.size <= SAVE_MAX) rec.blob = blob;
    else rec.noData = true;
  } else if (it.kind === 'bundle') {
    let total = 0;
    const list = (it.dir === 'out' ? it.jobs : it.files).filter(f => f.state === 'done');
    Object.assign(rec, { name: it.name, count: list.length, size: it.size, diskName: it.diskName || null });
    rec.files = list.map(f => {
      const o = { path: f.path || f.name, name: f.name, size: f.size, mime: f.mime, crc: f.crc || 0 };
      const blob = f.dir === 'out' ? f.file : f.blob;
      if (f.fh) o.fh = f.fh;
      else if (blob && total + f.size <= SAVE_MAX) { o.blob = blob; total += f.size; }
      return o;
    });
  }
  await idb.msgPut(rec);
  persistStorage();
}
// 보낸 파일은 상대가 다 받았다고 확인하면 기록
function onOutDone(job) {
  if (job.bundle) {
    const list = job.bundle.jobs;
    if (list.every(j => ['done', 'failed', 'cancelled'].includes(j.state)) && list.some(j => j.state === 'done')) persistItem(job.bundle);
  } else persistItem(job);
}
function restoreItem(r) {
  const base = { persisted: true, restored: true, mid: r.mid || null, room: r.room, time: r.time, dir: r.dir, peerName: r.peerName, kind: r.kind };
  if (r.kind === 'text') return { ...base, text: r.text };
  if (r.kind === 'file') {
    const it = { ...base, name: r.name, size: r.size, mime: r.mime || '', done: r.size, state: 'done', onDisk: r.onDisk, fh: r.fh };
    if (r.blob) {
      if (r.dir === 'out') it.file = r.blob;
      else { it.blob = r.blob; it.url = URL.createObjectURL(r.blob); }
      if (it.mime.startsWith('image/')) it.thumb = it.url || URL.createObjectURL(r.blob);
    } else if (r.fh) {
      it.saved = true;
      r.fh.getFile().then(f => {   // 바로 저장 폴더에 있는 파일
        it.blob = f; it.url = URL.createObjectURL(f);
        if (it.mime.startsWith('image/')) it.thumb = it.url;
        it.shown = {}; scheduleFeed();
      }).catch(() => { it.gone = 'disk'; it.shown = {}; scheduleFeed(); });
    } else it.gone = 'big';
    return it;
  }
  const files = (r.files || []).map(f => ({ ...f, dir: r.dir, state: 'done', done: f.size, onDisk: !!f.fh }));
  const it = { ...base, name: r.name, count: files.length, size: r.size, total: r.size, done: r.size, state: 'done', diskName: r.diskName, files, jobs: files };
  if (files.some(f => !f.blob && !f.fh)) it.partial = true;
  return it;
}
// 기록이 많아도 대화창이 무거워지지 않게 최근 100개만 먼저 그리고, 위에서 더 불러옴
const HIST_PAGE = 100;
async function loadRoomHistory(room) {
  const recs = (await idb.msgList(room)).filter(r => !r.owner || r.owner === PERSIST_ID);   // 같은 브라우저의 다른 탭 기록은 제외
  if (S.shownRoom !== room) return;
  recs.sort((a, b) => a.time - b.time);
  S.hist = { room, recs, shown: Math.min(HIST_PAGE, recs.length) };
  renderHistory(true);
}
function renderHistory(toBottom) {
  const h = S.hist;
  if (!h) return;
  const f = feedBox();
  const fromBottom = f.scrollHeight - f.scrollTop;
  const live = S.feed.filter(it => !it.restored);   // 지금 주고받는 중인 항목은 유지
  clearFeed();
  const older = h.recs.length - h.shown;
  if (older > 0) {
    const li = document.createElement('li');
    li.className = 'more';
    li.innerHTML = `<button type="button" data-more>이전 기록 ${older.toLocaleString()}개 더 보기</button>`;
    f.appendChild(li);
  }
  for (const r of h.recs.slice(h.recs.length - h.shown)) addFeed(restoreItem(r), true);
  for (const it of live) addFeed(it, true);
  if (toBottom) nextFrame(scrollBottom);
  else nextFrame(() => { f.scrollTop = f.scrollHeight - fromBottom; });
}
feedBox().addEventListener('click', e => {
  if (!e.target.closest('[data-more]') || !S.hist) return;
  S.hist.shown = Math.min(S.hist.recs.length, S.hist.shown + HIST_PAGE);
  renderHistory(false);
});
function showRoom(room) {
  if (S.shownRoom === room) return;
  clearFeed();
  S.hist = null;
  S.shownRoom = room;
  if (room) loadRoomHistory(room);
}

// ---------- 지우기: 상대 기기에서도 지워지도록 ----------
// 메시지마다 양쪽이 같은 id(mid)를 가짐. 지운 기록은 "삭제 표시"로 30일 보관했다가
// 그 방에서 다른 기기와 연결될 때마다 전달하므로, 지금 연결돼 있지 않은 기기에서도 나중에 지워짐.
const TOMB_DAYS = 30;
const midOf = it => it.mid || null;
const finished = it => it.kind === 'text' || it.restored || ['done', 'failed', 'cancelled'].includes(it.state);
async function getTombs(room) { return (await idb.get('kv', `tomb:${room}`)) || { mids: [], clear: 0 }; }
async function addTombs(room, mids, clear) {
  const t = await getTombs(room);
  const now = Date.now();
  for (const m of mids || []) t.mids.push([m, now]);
  if (clear) t.clear = Math.max(t.clear || 0, clear);
  t.mids = t.mids.filter(([, ts]) => now - ts < TOMB_DAYS * 864e5).slice(-3000);
  await idb.set('kv', `tomb:${room}`, t);
}
async function sendTombs(p) {
  if (!S.room || !alive(p)) return;
  const t = await getTombs(S.room);
  if (!t.mids.length && !t.clear) return;
  sendCtrl(p, { t: 'msg-del', mids: t.mids.map(x => x[0]), clear: t.clear }).catch(() => {});
}
function removeFeedItem(it) {
  if (it.url) URL.revokeObjectURL(it.url);
  if (it.el) it.el.remove();
  S.feed = S.feed.filter(x => x !== it);
  // 비게 된 날짜 구분선 정리
  const kids = [...feedBox().children];
  kids.forEach((li, i) => { if (li.classList.contains('day') && (!kids[i + 1] || kids[i + 1].classList.contains('day'))) li.remove(); });
  S.lastDay = S.feed.length ? dayKey(S.feed[S.feed.length - 1].time) : null;
  if (!S.feed.length) $('#feedEmpty').hidden = false;
}
// 이 기기에서 지우기 (mids에 든 메시지, 또는 clear 시각 이전의 전부)
async function applyDelete(room, mids, clear) {
  const set = new Set(mids || []);
  const hit = r => (r.mid && set.has(r.mid)) || (clear && r.time <= clear);
  let n = 0;
  for (const r of await idb.msgList(room)) {
    if (r.owner && r.owner !== PERSIST_ID) continue;
    if (hit(r)) { await idb.msgDel(r.id); n++; }
  }
  if (S.hist && S.hist.room === room) {
    S.hist.recs = S.hist.recs.filter(r => !hit(r));
    S.hist.shown = Math.min(S.hist.shown, S.hist.recs.length);
  }
  if (room === S.room) for (const it of S.feed.filter(x => finished(x) && ((midOf(x) && set.has(midOf(x))) || (clear && x.time <= clear)))) removeFeedItem(it);
  if (room === S.room && S.hist && S.hist.recs.length > S.hist.shown) renderHistory(false);
  return n;
}
async function deleteForAll(mids, clear) {
  const room = S.room;
  if (!room) return;
  await applyDelete(room, mids, clear);
  await addTombs(room, mids, clear);
  const peers = [...S.peers.values()];
  for (const p of peers) sendCtrl(p, { t: 'msg-del', mids: mids || [], clear: clear || 0, live: true }).catch(() => {});
  return peers.length;
}
$('#clearHistBtn').onclick = async () => {
  const b = $('#clearHistBtn');
  if (b.dataset.armed !== '1') {
    b.dataset.armed = '1'; b.textContent = '연결된 기기에서도 지워져요 · 한 번 더 누르기';
    setTimeout(() => { b.dataset.armed = ''; b.textContent = '기록 지우기'; }, 3500);
    return;
  }
  b.dataset.armed = ''; b.textContent = '기록 지우기';
  const n = await deleteForAll([], Date.now());
  toast(n ? '이 연결의 기록을 지웠어요. 연결된 기기에서도 지워졌어요.' : '이 연결의 기록을 지웠어요. 다른 기기는 다음에 연결될 때 지워져요.', 3500);
};
async function deleteOne(it) {
  const mid = midOf(it);
  if (!mid) {   // 이 기능 전에 저장된 기록은 id가 없어 이 기기에서만 지움
    if (it.restored) for (const r of await idb.msgList(S.room)) if (r.time === it.time && r.kind === it.kind && r.owner === PERSIST_ID && !r.mid) await idb.msgDel(r.id);
    removeFeedItem(it);
    return toast('이 기기에서 지웠어요 (예전 기록이라 상대 기기에는 반영되지 않아요)');
  }
  const n = await deleteForAll([mid], 0);
  toast(n ? '지웠어요. 연결된 기기에서도 지워졌어요.' : '지웠어요. 상대 기기는 다음에 연결될 때 지워져요.');
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
  else if (it.thumb && it.shown.thumb !== it.thumb) {
    r.th.innerHTML = `<img alt="" src="${it.thumb}">`; it.shown.thumb = it.thumb;
    r.card.classList.add('has-img');
    r.th.querySelector('img').onload = () => { if (stick) scrollBottom(); };
  }
  else if (!it.thumb && !it.shown.thumb) { r.th.textContent = extOf(it.name); it.shown.thumb = '-'; }

  r.th.classList.toggle('zoom', isMedia(it));
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
  if (it.shown.sz !== sz) { r.sz.textContent = sz; it.shown.sz = sz; }
  r.bar.hidden = !['sending', 'receiving', 'queued', 'wait', 'paused'].includes(it.state);
  r.bar.classList.toggle('paused', it.state === 'paused');

  const key = `${it.state}:${it.saved ? 1 : 0}:${it.gone || ''}:${it.blob ? 1 : 0}`;
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
  const delBtn = finished(it) ? '<button type="button" class="del-btn" data-a="del" title="모두에게서 삭제">삭제</button>' : '';
  if (it.state === 'done' && it.gone) {
    r.act.innerHTML = it.gone === 'big' ? '<span class="st">기록만 남음 · 파일이 커서 내용은 보관하지 않았어요</span>'
      : '<span class="st">저장 폴더에서 파일을 찾지 못했어요</span>';
  } else if (it.state === 'done') {
    if (it.dir === 'out') r.act.innerHTML = '<span class="st done">전달 완료</span>';
    else if (it.kind === 'bundle' && it.files.every(f => f.onDisk)) {
      r.act.innerHTML = `<span class="st done">'${esc(it.diskName || it.name)}' 폴더에 저장됨</span>`;
    } else if (it.kind === 'bundle' && it.partial) {
      r.act.innerHTML = '<span class="st">기록만 남음 · 폴더가 커서 일부 내용은 보관하지 않았어요</span>';
    } else if (it.kind === 'bundle') {
      const zipOk = it.size < ZIP_LIMIT && it.count < 65535;
      r.act.innerHTML = (zipOk ? `<button type="button" class="${it.saved ? '' : 'solid'}" data-a="zip">${it.saved ? 'zip 다시 저장' : 'zip으로 저장'}</button>` : '') +
        `<button type="button" class="${zipOk ? '' : 'solid'}" data-a="each">파일 각각 저장</button>`;
    } else {
      const viewable = /^(image|video|audio|text)\/|pdf$/.test(it.mime);
      if (!it.blob) { r.act.innerHTML = `<span class="st">불러오는 중…</span>${delBtn}`; return; }
      r.act.innerHTML = (viewable && !IS_MOBILE ? '<button type="button" data-a="view">열기</button>' : '') +
        `<button type="button" class="${it.saved ? '' : 'solid'}" data-a="save">${it.saved ? '다시 저장' : '저장'}</button>`;
    }
  } else r.act.innerHTML = L[it.state] || '';
  if (delBtn) r.act.insertAdjacentHTML('beforeend', delBtn);
}
let feedQueued = false;
function scheduleFeed() {
  if (feedQueued) return;
  feedQueued = true;
  nextFrame(() => {
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
      if (j.writer) { j.writer.abort().catch(() => {}); j.writer = null; }
      const p = S.peers.get(j.peerId);
      if (p) sendCtrl(p, { t: 'cancel', uid: j.uid }).catch(() => {});
    }
  }
  S.parked = S.parked.filter(j => j.state !== 'cancelled');
  scheduleFeed();
}
$('#feed').addEventListener('click', async e => {
  const th = e.target.closest('.th.zoom');
  if (th) { const it = S.feed.find(x => x.el === th.closest('li')); if (it) return openViewer(it); }
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
  else if (a === 'del') {
    if (b.dataset.armed !== '1') {   // 실수 방지: 두 번 눌러야 지움
      b.dataset.armed = '1'; b.textContent = '모두에게서 삭제?'; b.classList.add('armed');
      setTimeout(() => { if (b.isConnected) { b.dataset.armed = ''; b.textContent = '삭제'; b.classList.remove('armed'); } }, 3000);
      return;
    }
    deleteOne(it);
  }
});
$('#saveAllBtn').onclick = async () => {
  const list = S.feed.filter(it => it.dir === 'in' && it.kind === 'file' && it.state === 'done' && !it.saved && it.blob);
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

// ---------- 받으면 알림 (다른 창을 보고 있을 때) ----------
const NOTIFY = { on: store.get('omgyeo.notify', false), unseen: 0 };
async function announce(title, body) {
  if (!document.hidden) return;
  NOTIFY.unseen++;
  document.title = `(${NOTIFY.unseen}) 옮겨`;
  if (!NOTIFY.on || !('Notification' in window) || Notification.permission !== 'granted') return;
  try {
    // 안드로이드 크롬은 페이지에서 바로 알림을 못 띄워서 서비스 워커를 통해 띄움
    const reg = navigator.serviceWorker && await navigator.serviceWorker.getRegistration();
    if (reg) await reg.showNotification(title, { body, tag: 'omgyeo', renotify: true });
    else new Notification(title, { body, tag: 'omgyeo' });
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { NOTIFY.unseen = 0; document.title = '옮겨'; }
});
function renderBell() {
  const on = NOTIFY.on && 'Notification' in window && Notification.permission === 'granted';
  $('#bellBtn').setAttribute('aria-pressed', String(on));
  $('#bellBtn').title = on ? '알림 켜짐 · 누르면 끔' : '받으면 알림 받기';
}
$('#bellBtn').onclick = async () => {
  if (!globalThis.isSecureContext) return toast('알림은 https 주소에서만 켤 수 있어요. 배포 주소나 localhost로 열어 주세요.', 4000);
  if (!('Notification' in window)) return toast('이 브라우저는 알림을 지원하지 않아요. 아이폰은 홈 화면에 추가한 뒤에만 돼요.');
  if (NOTIFY.on) { NOTIFY.on = false; store.set('omgyeo.notify', false); renderBell(); return toast('알림을 껐어요'); }
  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return toast('브라우저에서 알림이 막혀 있어요. 주소창 왼쪽 아이콘을 눌러 알림을 허용하세요.', 4000);
  NOTIFY.on = true; store.set('omgyeo.notify', true); renderBell();
  toast('다른 창을 보고 있을 때 받으면 알려 드려요');
};

// ---------- 사진·영상 크게 보기 ----------
const V = { list: [], i: 0, x: null };
const isMedia = it => it.kind === 'file' && /^(image|video)\//.test(it.mime || '') && (it.dir === 'out' ? !!it.file : it.state === 'done' && !!it.url);
function mediaUrl(it) {
  if (it.dir === 'in') return it.url;
  if (!it.viewUrl) it.viewUrl = it.thumb || URL.createObjectURL(it.file);
  return it.viewUrl;
}
function openViewer(it) {
  V.list = S.feed.filter(isMedia);   // 오래된 것부터
  V.i = Math.max(0, V.list.indexOf(it));
  $('#viewer').hidden = false;
  document.body.classList.add('noscroll');
  drawViewer();
}
function closeViewer() {
  $('#viewer').hidden = true;
  document.body.classList.remove('noscroll');
  $('#vStage').innerHTML = '';
}
function drawViewer() {
  const it = V.list[V.i];
  if (!it) return closeViewer();
  const url = mediaUrl(it);
  $('#vStage').innerHTML = it.mime.startsWith('video/') ? `<video src="${url}" controls playsinline></video>` : `<img src="${url}" alt="">`;
  $('#vName').textContent = it.name;
  $('#vMeta').textContent = `${V.i + 1} / ${V.list.length} · ${it.dir === 'in' ? '←' : '→'} ${it.peerName} · ${fmtSize(it.size)}`;
  $('#vSave').hidden = it.dir !== 'in';
  $('#vPrev').disabled = V.i === 0;
  $('#vNext').disabled = V.i === V.list.length - 1;
}
function stepViewer(d) { const n = V.i + d; if (n >= 0 && n < V.list.length) { V.i = n; drawViewer(); } }
$('#vPrev').onclick = () => stepViewer(-1);
$('#vNext').onclick = () => stepViewer(1);
$('#vClose').onclick = closeViewer;
$('#vSave').onclick = async () => { const it = V.list[V.i]; if (it && await saveBlobs([it])) { it.saved = true; scheduleFeed(); } };
$('#viewer').addEventListener('click', e => { if (e.target.id === 'viewer') closeViewer(); });
addEventListener('keydown', e => {
  if ($('#viewer').hidden) return;
  if (e.key === 'Escape') closeViewer();
  else if (e.key === 'ArrowLeft') stepViewer(-1);
  else if (e.key === 'ArrowRight') stepViewer(1);
});
$('#vStage').addEventListener('pointerdown', e => { V.x = e.clientX; });
$('#vStage').addEventListener('pointerup', e => {
  if (V.x == null) return;
  const dx = e.clientX - V.x; V.x = null;
  if (Math.abs(dx) > 50) stepViewer(dx < 0 ? 1 : -1);
});

// ---------- 받은 파일 저장 위치 (PC 크롬·엣지) ----------
async function loadDl() {
  if (!FS_OK) return;
  const saved = await idb.get('kv', 'dl');
  if (saved && saved.handle) S.dl = { handle: saved.handle, ok: await fsPermission(saved.handle, 'readwrite', false) };
  renderDl();
}
function renderDl() {
  const row = $('#dlRow');
  if (!FS_OK) { row.hidden = true; return; }
  row.hidden = false;
  if (!S.dl) {
    $('#dlText').innerHTML = '받은 파일은 <b>저장</b>을 눌러 다운로드 폴더에 저장해요.';
    $('#dlBtns').innerHTML = '<button type="button" data-dl="pick">바로 저장할 폴더 지정</button>';
  } else if (!S.dl.ok) {
    $('#dlText').innerHTML = `받은 파일을 <b>'${esc(S.dl.handle.name)}'</b> 폴더에 바로 저장하려면 허용이 필요해요.`;
    $('#dlBtns').innerHTML = '<button type="button" class="solid" data-dl="allow">폴더 접근 허용</button><button type="button" data-dl="off">해제</button>';
  } else {
    $('#dlText').innerHTML = `받은 파일을 <b>'${esc(S.dl.handle.name)}'</b> 폴더에 바로 저장해요. 큰 파일도 메모리를 쓰지 않아요.`;
    $('#dlBtns').innerHTML = '<button type="button" data-dl="pick">바꾸기</button><button type="button" data-dl="off">해제</button>';
  }
}
$('#dlBtns').addEventListener('click', async e => {
  const b = e.target.closest('[data-dl]');
  if (!b) return;
  if (b.dataset.dl === 'pick') {
    let handle;
    try { handle = await showDirectoryPicker({ id: 'omgyeo-dl', mode: 'readwrite', startIn: 'downloads' }); } catch { return; }
    S.dl = { handle, ok: true };
    await idb.set('kv', 'dl', { handle });
    persistStorage();
    toast(`이제 받은 파일을 '${handle.name}' 폴더에 바로 저장해요`);
  } else if (b.dataset.dl === 'allow') {
    S.dl.ok = await fsPermission(S.dl.handle, 'readwrite', true);
    if (!S.dl.ok) toast('허용해야 폴더에 바로 저장할 수 있어요.');
  } else if (b.dataset.dl === 'off') {
    S.dl = null;
    await idb.del('kv', 'dl');
    toast('받은 파일은 다시 저장 버튼으로 저장해요');
  }
  renderDl();
});

// ---------- 탭(대화 | 폴더 동기화), 폰의 연결 정보 펼치기 ----------
function selectTab(name) {
  for (const t of document.querySelectorAll('.tabs [role=tab]')) t.setAttribute('aria-selected', String(t.dataset.tab === name));
  $('#paneChat').hidden = name !== 'chat';
  $('#paneSync').hidden = name !== 'sync';
  $('#chatTools').hidden = name !== 'chat';
  if (name === 'chat' && stick) nextFrame(scrollBottom);
}
document.querySelector('.tabs').addEventListener('click', e => { const t = e.target.closest('[role=tab]'); if (t) selectTab(t.dataset.tab); });
function setSide(open) {
  document.body.classList.toggle('side-open', open);
  $('#sideToggle').setAttribute('aria-expanded', String(open));
}
S.lastPeerCount = 0;
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (S.room) renderPeers(); }, 200); });
$('#sideToggle').onclick = () => { S.sideTouched = true; setSide(!document.body.classList.contains('side-open')); };

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
  if (!globalThis.isSecureContext) $('#secureNote').hidden = false;
  await initCrypto();
  connect();
  loadInfo();
  loadDl();
  renderBell();
})();

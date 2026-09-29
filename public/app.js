'use strict';
/* 옮겨 클라이언트
 * - 기기끼리 WebRTC 데이터 채널로 직접 전송하고, 연결이 안 되면 서버 WebSocket으로 중계합니다.
 * - 파일 하나는 시작한 통로(직접/중계)로 끝까지 보내서 조각 순서가 섞이지 않게 합니다.
 */

const $ = (s, r = document) => r.querySelector(s);
const CHUNK_DC = 64 * 1024;          // 데이터 채널 조각 크기 (브라우저 간 호환 안전선)
const CHUNK_WS = 256 * 1024;         // 서버 중계 조각 크기
const READ_BLOCK = 1024 * 1024;      // 디스크에서 한 번에 읽는 크기
const HIGH_WATER = 4 * 1024 * 1024;  // 이만큼 쌓이면 잠시 멈춤
const LOW_WATER = 512 * 1024;
const MERGE_AT = 32 * 1024 * 1024;   // 받은 조각을 이만큼마다 Blob으로 묶어 메모리 절약
const P2P_WAIT = 6000;               // 직접 연결을 기다리는 시간
const ICE = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];

// ---------- 저장소 ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};

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
let myName = store.get('omgyeo.name', DEV.label);

// ---------- 상태 ----------
const S = {
  ws: null, id: null, room: null, code: null, want: null,
  peers: new Map(),          // id -> peer
  feed: [],                  // 화면 목록 (최신이 앞)
  incoming: new Map(),       // `${from}:${fid}` -> 받는 중인 파일
  targets: null,             // null = 전체, Set = 고른 기기만
  fidSeq: 1, lan: null, pub: null,
};

// ---------- 유틸 ----------
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
function extOf(name) { const m = /\.([a-z0-9]{1,5})$/i.exec(name || ''); return m ? m[1] : 'file'; }
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
const ICONS = {
  pc: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/></svg>',
  phone: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="7" y="2" width="10" height="20" rx="2.5"/><path d="M11 18h2"/></svg>',
  tablet: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="4" y="3" width="16" height="18" rx="2.5"/><path d="M11 18h2"/></svg>',
};

// ---------- 서버 연결 ----------
function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  S.ws = ws;
  ws.onopen = () => {
    setNet(true);
    sendServer({ type: 'hello', name: myName, kind: DEV.kind });
    if (S.want === 'create') sendServer({ type: 'create' });
    else if (S.want) sendServer({ type: 'join', ...S.want });
  };
  ws.onmessage = e => {
    if (typeof e.data === 'string') onServer(JSON.parse(e.data));
    else onRelayBinary(e.data);
  };
  ws.onclose = () => {
    setNet(false);
    for (const p of S.peers.values()) closePeer(p);
    S.peers.clear();
    renderPeers();
    setTimeout(connect, 1500);
  };
}
function sendServer(obj) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(obj)); }
function setNet(on) { $('#net').classList.toggle('on', on); $('#net').title = on ? '서버에 연결됨' : '서버에 다시 연결하는 중'; }

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
      toast(`${m.peer.name} 연결됨`);
      remember(); renderPeers();
      break;
    case 'peer-left': {
      const p = S.peers.get(m.id);
      if (p) { toast(`${p.name} 연결 끊김`); closePeer(p); S.peers.delete(m.id); }
      renderPeers();
      break;
    }
    case 'peer-renamed': {
      const p = S.peers.get(m.id);
      if (p) { p.name = m.name; remember(); renderPeers(); }
      break;
    }
    case 'signal': onSignal(m.from, m.data); break;
    case 'relay': onData(m.from, m.data); break;
    case 'error':
      toast(m.message, 3500);
      if (m.code === 'nocode') { S.want = null; $('#codeInput').select(); }
      break;
  }
}

// ---------- 기기 간 연결 ----------
function addPeer(info, initiator) {
  if (S.peers.has(info.id)) return;
  const p = { id: info.id, name: info.name, kind: info.kind, pc: null, dc: null, mode: 'connecting', queue: [], busy: false, pending: [] };
  S.peers.set(p.id, p);
  if (typeof RTCPeerConnection === 'undefined') { p.mode = 'relay'; return; }
  const pc = p.pc = new RTCPeerConnection({ iceServers: ICE });
  pc.onicecandidate = e => { if (e.candidate) sendServer({ type: 'signal', to: p.id, data: { candidate: e.candidate } }); };
  pc.ondatachannel = e => { p.dc = e.channel; setupChannel(p); };
  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState) && S.peers.get(p.id) === p) { p.mode = 'relay'; renderPeers(); }
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
  dc.onclose = () => { if (S.peers.get(p.id) === p && p.mode === 'p2p') { p.mode = 'relay'; renderPeers(); } };
  dc.onmessage = e => {
    if (typeof e.data === 'string') onData(p.id, JSON.parse(e.data));
    else onChunk(p.id, e.data, 0);
  };
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
  try { p.dc && p.dc.close(); } catch {}
  try { p.pc && p.pc.close(); } catch {}
  for (const job of p.queue) if (job.state !== 'done') job.state = 'failed';
  for (const inc of S.incoming.values()) if (inc.from === p.id) { inc.state = 'failed'; inc.parts = null; S.incoming.delete(inc.key); }
  scheduleFeed();
}

// ---------- 보내기 통로 ----------
const via = p => (p.dc && p.dc.readyState === 'open' ? 'dc' : 'relay');
function sendCtrl(p, how, obj) {
  if (how === 'dc') p.dc.send(JSON.stringify(obj));
  else sendServer({ type: 'relay', to: p.id, data: obj });
}
function sendChunk(p, how, fid, buf) {
  if (how === 'dc') {
    const out = new Uint8Array(4 + buf.byteLength);
    new DataView(out.buffer).setUint32(0, fid);
    out.set(new Uint8Array(buf), 4);
    p.dc.send(out.buffer);
  } else {
    const out = new Uint8Array(12 + buf.byteLength);
    for (let i = 0; i < 8; i++) out[i] = p.id.charCodeAt(i);
    new DataView(out.buffer).setUint32(8, fid);
    out.set(new Uint8Array(buf), 12);
    S.ws.send(out.buffer);
  }
}
function drain(p, how) {
  return new Promise(resolve => {
    if (how === 'dc') {
      if (p.dc.bufferedAmount < HIGH_WATER) return resolve();
      p.dc.addEventListener('bufferedamountlow', () => resolve(), { once: true });
    } else {
      const tick = () => (!S.ws || S.ws.bufferedAmount < HIGH_WATER ? resolve() : setTimeout(tick, 15));
      tick();
    }
  });
}

// ---------- 파일 보내기 ----------
function targetPeers() {
  const all = [...S.peers.values()];
  if (!S.targets) return all;
  return all.filter(p => S.targets.has(p.id));
}
function sendFiles(list) {
  const files = [...list];
  if (!files.length) return;
  const targets = targetPeers();
  if (!targets.length) return toast('먼저 받을 기기를 연결하세요.');
  for (const file of files) {
    for (const p of targets) {
      const job = { kind: 'file', dir: 'out', fid: S.fidSeq++, file, peer: p.id, peerName: p.name, name: file.name || '이름 없는 파일', size: file.size, mime: file.type, done: 0, state: 'queued', time: Date.now() };
      if (file.type.startsWith('image/')) job.thumb = URL.createObjectURL(file);
      addFeed(job);
      p.queue.push(job);
      pump(p);
    }
  }
  keepAwake();
}
async function pump(p) {
  if (p.busy) return;
  p.busy = true;
  try {
    while (p.queue.length) {
      const job = p.queue[0];
      if (job.state === 'queued') await sendJob(p, job);
      p.queue.shift();
    }
  } finally { p.busy = false; keepAwake(); }
}
async function sendJob(p, job) {
  while (p.mode === 'connecting' && S.peers.get(p.id) === p) await sleep(100);
  if (S.peers.get(p.id) !== p) { job.state = 'failed'; return scheduleFeed(); }
  const how = via(p);
  const chunk = how === 'dc' ? CHUNK_DC : CHUNK_WS;
  job.how = how; job.state = 'sending'; job.start = performance.now(); scheduleFeed();
  try {
    sendCtrl(p, how, { t: 'file', fid: job.fid, name: job.name, size: job.size, mime: job.mime });
    let off = 0;
    while (off < job.size) {
      if (job.state === 'cancelled') { sendCtrl(p, how, { t: 'cancel', fid: job.fid }); return scheduleFeed(); }
      const block = await job.file.slice(off, off + READ_BLOCK).arrayBuffer();
      for (let i = 0; i < block.byteLength; i += chunk) {
        await drain(p, how);
        if (how === 'dc' && p.dc.readyState !== 'open') throw new Error('channel closed');
        if (how === 'relay' && (!S.ws || S.ws.readyState !== 1)) throw new Error('server closed');
        sendChunk(p, how, job.fid, block.slice(i, i + chunk));
      }
      off += block.byteLength;
      job.done = off;
      scheduleFeed();
    }
    if (job.state !== 'done') job.state = 'wait';
  } catch (err) {
    console.warn('send', err);
    job.state = 'failed';
  }
  scheduleFeed();
}

function sendText(text) {
  const targets = targetPeers();
  if (!targets.length) return toast('먼저 받을 기기를 연결하세요.');
  for (const p of targets) sendCtrl(p, via(p), { t: 'text', text });
  addFeed({ kind: 'text', dir: 'out', text, peerName: targets.map(p => p.name).join(', '), time: Date.now() });
}

// ---------- 받기 ----------
function onData(from, m) {
  const p = S.peers.get(from);
  const name = p ? p.name : '알 수 없는 기기';
  if (m.t === 'file') {
    const key = `${from}:${m.fid}`;
    const inc = { kind: 'file', dir: 'in', key, fid: m.fid, from, peerName: name, name: String(m.name).slice(0, 200), size: m.size, mime: m.mime || 'application/octet-stream', done: 0, parts: [], pendingBytes: 0, state: 'receiving', time: Date.now(), start: performance.now() };
    S.incoming.set(key, inc);
    addFeed(inc);
    if (m.size === 0) finishIncoming(inc);
    keepAwake();
  } else if (m.t === 'cancel') {
    const inc = S.incoming.get(`${from}:${m.fid}`);
    if (inc) { inc.state = 'cancelled'; inc.parts = null; S.incoming.delete(inc.key); scheduleFeed(); }
  } else if (m.t === 'ack') {
    const job = S.feed.find(j => j.dir === 'out' && j.kind === 'file' && j.peer === from && j.fid === m.fid);
    if (job) { job.state = 'done'; scheduleFeed(); }
  } else if (m.t === 'text') {
    addFeed({ kind: 'text', dir: 'in', text: String(m.text), peerName: name, time: Date.now() });
    toast(`${name}에서 글이 왔어요`);
  }
}
function onChunk(from, buf, offset) {
  const fid = new DataView(buf, offset, 4).getUint32(0);
  const inc = S.incoming.get(`${from}:${fid}`);
  if (!inc || !inc.parts) return;
  const data = buf.slice(offset + 4);
  inc.parts.push(data);
  inc.done += data.byteLength;
  inc.pendingBytes += data.byteLength;
  if (inc.pendingBytes >= MERGE_AT) { inc.parts = [new Blob(inc.parts)]; inc.pendingBytes = 0; }
  if (inc.done >= inc.size) finishIncoming(inc);
  else scheduleFeed();
}
function onRelayBinary(buf) {
  const from = String.fromCharCode(...new Uint8Array(buf, 0, 8));
  onChunk(from, buf, 8);
}
function finishIncoming(inc) {
  inc.blob = new Blob(inc.parts, { type: inc.mime });
  inc.parts = null;
  inc.state = 'done';
  inc.url = URL.createObjectURL(inc.blob);
  if (inc.mime.startsWith('image/')) inc.thumb = inc.url;
  S.incoming.delete(inc.key);
  const p = S.peers.get(inc.from);
  if (p) sendCtrl(p, via(p), { t: 'ack', fid: inc.fid });
  toast(`${inc.name} 받음`);
  scheduleFeed();
  keepAwake();
}

// ---------- 저장 ----------
async function saveItems(items) {
  if (!items.length) return;
  const files = items.map(it => new File([it.blob], it.name, { type: it.mime }));
  if (IS_MOBILE && navigator.canShare && navigator.canShare({ files })) {
    try { await navigator.share({ files }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  for (const it of items) {
    const a = document.createElement('a');
    a.href = it.url; a.download = it.name;
    document.body.appendChild(a); a.click(); a.remove();
    if (items.length > 1) await sleep(350);
  }
  for (const it of items) it.saved = true;
  scheduleFeed();
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

function renderPeers() {
  const peers = [...S.peers.values()];
  $('#peerCount').textContent = peers.length;
  $('#emptyPeers').hidden = peers.length > 0;
  $('#peerList').innerHTML = peers.map(p => {
    const b = p.mode === 'p2p' ? ['p2p', '직접 연결'] : p.mode === 'relay' ? ['relay', '서버 경유'] : ['', '연결하는 중'];
    return `<li class="peer"><span class="ic">${ICONS[p.kind] || ICONS.pc}</span>
      <div class="pn"><b>${esc(p.name)}</b><span class="badge ${b[0]}"><i></i>${b[1]}</span></div></li>`;
  }).join('');
  // 받을 기기 고르기 (2대 이상일 때만)
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
  $('#dropTitle').textContent = none ? '연결된 기기가 없어요' : IS_MOBILE ? '보낼 파일 고르기' : '파일을 끌어다 놓거나 눌러서 고르기';
  $('#dropSub').textContent = none ? '왼쪽 QR이나 코드로 다른 기기를 먼저 연결하세요' : `${peers.length === 1 ? peers[0].name + '(으)로' : '고른 기기로'} 원본 그대로 보냅니다`;
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
  for (const p of S.peers.values()) closePeer(p);
  S.peers.clear(); S.room = null; S.want = null;
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
    const isUrl = /^https?:\/\/\S+$/.test(it.text.trim());
    if (it.dir === 'in' && isUrl) li.querySelector('.act').insertAdjacentHTML('afterbegin', `<button type="button" data-a="open">열기</button>`);
    return;
  }
  li.innerHTML = `<div class="th"></div>
    <div class="body"><div class="nm"></div><div class="meta">${arrow}<span class="sz"></span></div><div class="bar"><i></i></div></div>
    <div class="act"></div>`;
  li.querySelector('.nm').textContent = it.name;
  it.refs = { th: li.querySelector('.th'), sz: li.querySelector('.sz'), bar: li.querySelector('.bar'), fill: li.querySelector('.bar i'), act: li.querySelector('.act') };
  it.shown = {};
}
function updateItem(it) {
  if (it.kind !== 'file' || !it.refs) return;
  const r = it.refs;
  if (it.thumb && it.shown.thumb !== it.thumb) { r.th.innerHTML = `<img alt="" src="${it.thumb}">`; it.shown.thumb = it.thumb; }
  else if (!it.thumb && !it.shown.thumb) { r.th.textContent = extOf(it.name); it.shown.thumb = '-'; }
  const pct = it.size ? Math.min(100, (it.done / it.size) * 100) : 100;
  r.fill.style.width = `${pct}%`;
  let sz = fmtSize(it.size);
  if ((it.state === 'sending' || it.state === 'receiving') && it.start) {
    const secs = (performance.now() - it.start) / 1000;
    if (secs > 0.5) sz = `${fmtSize(it.done)} / ${fmtSize(it.size)} · ${fmtSize(it.done / secs)}/s`;
  } else if (it.how === 'relay' && it.state === 'done') sz += ' · 서버 경유';
  if (it.shown.sz !== sz) { r.sz.textContent = `· ${sz}`; it.shown.sz = sz; }
  const active = it.state === 'sending' || it.state === 'receiving' || it.state === 'queued' || it.state === 'wait';
  r.bar.hidden = !active;
  const key = `${it.state}:${it.saved ? 1 : 0}`;
  if (it.shown.act === key) return;
  it.shown.act = key;
  const L = {
    queued: '<span class="st">대기 중</span><button type="button" data-a="cancel">취소</button>',
    sending: '<button type="button" data-a="cancel">취소</button>',
    wait: '<span class="st">확인 중</span>',
    receiving: '<span class="st">받는 중</span>',
    failed: '<span class="st fail">실패</span>',
    cancelled: '<span class="st fail">취소됨</span>',
  };
  if (it.state === 'done') {
    if (it.dir === 'out') r.act.innerHTML = '<span class="st done">전달 완료</span>';
    else {
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
$('#feed').addEventListener('click', async e => {
  const b = e.target.closest('[data-a]');
  if (!b) return;
  const it = S.feed.find(x => x.el === b.closest('li'));
  if (!it) return;
  if (b.dataset.a === 'cancel') { it.state = 'cancelled'; scheduleFeed(); }
  else if (b.dataset.a === 'save') saveItems([it]);
  else if (b.dataset.a === 'view') window.open(it.url, '_blank', 'noopener');
  else if (b.dataset.a === 'copy') toast((await copyText(it.text)) ? '복사했어요' : '복사하지 못했어요. 글을 길게 눌러 복사하세요.');
  else if (b.dataset.a === 'open') window.open(it.text.trim(), '_blank', 'noopener');
});
$('#saveAllBtn').onclick = () => saveItems(S.feed.filter(it => it.dir === 'in' && it.kind === 'file' && it.state === 'done' && !it.saved).reverse());

// ---------- 입력: 파일 고르기, 끌어다 놓기, 붙여넣기 ----------
$('#fileInput').addEventListener('change', e => { sendFiles(e.target.files); e.target.value = ''; });
$('#drop').addEventListener('click', e => { if (!S.peers.size) { e.preventDefault(); toast('먼저 다른 기기를 연결하세요.'); } });
let dragDepth = 0;
addEventListener('dragenter', e => { if (!S.room || !e.dataTransfer.types.includes('Files')) return; dragDepth++; $('#dropVeil').hidden = false; });
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropVeil').hidden = true; } });
addEventListener('dragover', e => { if (S.room) e.preventDefault(); });
addEventListener('drop', e => {
  if (!S.room) return;
  e.preventDefault(); dragDepth = 0; $('#dropVeil').hidden = true;
  sendFiles(e.dataTransfer.files);
});
addEventListener('paste', e => {
  if (!S.room || !e.clipboardData || !e.clipboardData.files.length) return;
  e.preventDefault();
  sendFiles(e.clipboardData.files);
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
function busy() { return S.feed.some(it => it.state === 'sending' || it.state === 'receiving' || it.state === 'queued'); }
async function keepAwake() {
  if (busy()) {
    if (!wakeLock && navigator.wakeLock) { try { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.onrelease = () => { wakeLock = null; }; } catch {} }
  } else if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
}
addEventListener('beforeunload', e => { if (busy()) { e.preventDefault(); e.returnValue = ''; } });

// ---------- 시작 ----------
(async function start() {
  await loadInfo();
  const r = new URLSearchParams(location.search).get('r');
  const last = store.get('omgyeo.last', null);
  if (r && /^[a-z0-9]{10}$/.test(r)) S.want = { room: r };
  else if (last) S.want = { room: last };      // 지난번 연결로 자동 재접속
  show('home');
  connect();
})();

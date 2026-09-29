'use strict';
/* PC 간 폴더 동기화 (한 방향: 공유하는 PC → 받는 PC)
 * 1) 공유하는 쪽이 폴더를 고르고, 연결된 PC 중 하나를 직접 골라 공유를 요청합니다.
 * 2) 받는 쪽이 받을 위치를 고르면(또는 전에 고른 위치가 있고 권한이 있으면) 자기 폴더 목록과 해시를 보냅니다.
 * 3) 공유하는 쪽은 몇 초마다 폴더를 훑어 해시를 비교하고, 다른 파일이 있으면 "공유하기"를 켭니다.
 * 4) 공유하기를 누르면 바뀐 파일만 기다림 없이 연달아 보내고, 받는 쪽은 디스크에 바로 씁니다.
 * 두 PC의 짝은 기기 고유 id(pid)로 기억해서 다음 연결 때 다시 고르지 않아도 됩니다.
 */
const SYNC_WINDOW = 24 * 1024 * 1024;   // 받는 쪽 확인이 안 된 전송량 한도 (메모리 폭주 방지)
const SYNC_INDEX_PART = 1500;           // 목록을 나눠 보내는 단위
const SYNC_RESCAN_RECV = 8000;          // 받는 쪽 폴더 재확인 주기
const SYNC_EXTRA_IGNORE = '*.crswap';   // 크롬이 쓰는 중에 만드는 임시 파일

const Sync = {
  share: null, shareOk: false, local: null, rules: [], ruleText: '',
  scanning: false, scanMsg: '', lastScanMs: 0, scanTimer: null,
  sessions: new Map(),   // 받는 PC의 pid -> 보내는 세션
  inbound: new Map(),    // 공유 id -> 받는 세션
  fidMap: new Map(),     // `${peerId}:${fid}` -> 받는 중인 파일
  peeks: new Map(),      // 미리보기 요청 id -> 응답 처리
  openList: new Set(),   // 변경 목록을 펼친 세션
};

// ---------- 시작 ----------
Sync.init = async () => {
  if (!FS_OK) return;
  $('#syncBox').hidden = false;
  const saved = await idb.get('kv', 'share');
  if (saved && saved.handle) {
    Sync.share = saved;
    Sync.shareOk = await fsPermission(saved.handle, 'read', false);
    await buildRules();
  }
  syncRender();
};

async function saveShare() {
  const sh = Sync.share;
  await idb.set('kv', 'share', { id: sh.id, handle: sh.handle, name: sh.name, ignore: sh.ignore, gitignore: sh.gitignore, auto: sh.auto, mirror: sh.mirror, targets: sh.targets });
}
async function buildRules() {
  const sh = Sync.share;
  let text = `${DEFAULT_IGNORE}\n${SYNC_EXTRA_IGNORE}\n${sh.ignore || ''}`;
  if (sh.gitignore && Sync.shareOk) {
    try { text += `\n${await (await (await sh.handle.getFileHandle('.gitignore')).getFile()).text()}`; } catch {}
  }
  Sync.ruleText = text;
  Sync.rules = compileIgnore(text);
}

// ---------- 공유하는 쪽: 폴더 ----------
async function pickShare() {
  let handle;
  try { handle = await showDirectoryPicker({ id: 'omgyeo-share', mode: 'read' }); } catch { return; }
  const old = Sync.share;
  const same = old && old.handle && await old.handle.isSameEntry(handle).catch(() => false);
  if (old && !same) stopAll();
  Sync.share = {
    id: same ? old.id : randStr(12), handle, name: handle.name,
    ignore: old ? old.ignore : '', gitignore: old ? old.gitignore : true,
    auto: same ? old.auto : false, mirror: same ? old.mirror : false, targets: same ? old.targets : [],
  };
  Sync.shareOk = true;
  Sync.local = null;
  await saveShare();
  persistStorage();
  await buildRules();
  syncRender();
  scanShare();
  for (const p of S.peers.values()) if (isTarget(p)) offer(p);
}
async function grantShare() {
  if (!Sync.share) return;
  Sync.shareOk = await fsPermission(Sync.share.handle, 'read', true);
  if (!Sync.shareOk) return toast('폴더 접근을 허용해야 공유할 수 있어요.');
  await buildRules();
  syncRender();
  scanShare();
  for (const p of S.peers.values()) if (isTarget(p)) offer(p);
}
function stopAll() {
  for (const sess of Sync.sessions.values()) {
    const p = S.peers.get(sess.peerId);
    if (p) sendCtrl(p, { t: 'sync-stop', sid: Sync.share.id }).catch(() => {});
  }
  Sync.sessions.clear();
}
async function unshare() {
  stopAll();
  Sync.share = null; Sync.local = null; Sync.shareOk = false;
  await idb.del('kv', 'share');
  syncRender();
}

// 몇 초마다 폴더를 훑어 바뀐 파일을 찾음 (해시는 캐시, 바뀐 것만 다시 계산)
async function scanShare() {
  if (Sync.scanning || !Sync.share || !Sync.shareOk) return;
  Sync.scanning = true;
  const t0 = performance.now();
  const first = !Sync.local;
  try {
    Sync.local = await scanFolder(Sync.share.handle, Sync.rules, `share:${Sync.share.id}`, (d, n) => {
      if (first) { Sync.scanMsg = `파일 확인 중 ${d.toLocaleString()} / ${n.toLocaleString()}`; syncRender(); }
    });
    Sync.scanMsg = '';
  } catch (err) {
    console.warn('scan', err);
    Sync.shareOk = await fsPermission(Sync.share.handle, 'read', false);
    Sync.scanMsg = Sync.shareOk ? '폴더를 읽지 못했어요. 폴더를 옮기거나 지웠다면 다시 골라 주세요.' : '';
  }
  Sync.lastScanMs = performance.now() - t0;
  Sync.scanning = false;
  for (const sess of Sync.sessions.values()) if (sess.remote) { diff(sess); autoPush(sess); }
  syncRender();
}
function scanLoop() {
  if (Sync.scanTimer) return;
  const tick = async () => {
    const active = [...Sync.sessions.values()].some(s => ['offer', 'waiting', 'ready'].includes(s.state));
    const pushing = [...Sync.sessions.values()].some(s => s.state === 'syncing');
    if (active && !pushing) await scanShare();
    Sync.scanTimer = setTimeout(tick, Math.max(3000, Sync.lastScanMs * 4));
  };
  Sync.scanTimer = setTimeout(tick, 0);
}

// ---------- 공유하는 쪽: 세션 ----------
const isTarget = p => Sync.share && Sync.shareOk && p.caps && p.caps.fs && Sync.share.targets.includes(p.caps.pid);
function offer(p) {
  const pid = p.caps.pid;
  let sess = Sync.sessions.get(pid);
  if (!sess) {
    sess = { pid, peerId: p.id, name: p.name, state: 'offer', remote: null, parts: [], diff: null, inflight: 0, pending: new Map(), wake: [], prog: null };
    Sync.sessions.set(pid, sess);
  }
  Object.assign(sess, { peerId: p.id, name: p.name, state: 'offer', remote: null, parts: [] });
  sendCtrl(p, { t: 'sync-offer', sid: Sync.share.id, name: Sync.share.name, rules: Sync.ruleText }).catch(() => {});
  scanLoop();
  syncRender();
}
async function startWith(peerId) {
  const p = S.peers.get(peerId);
  if (!p || !Sync.share) return;
  if (!Sync.share.targets.includes(p.caps.pid)) { Sync.share.targets.push(p.caps.pid); await saveShare(); }
  if (!Sync.local) scanShare();
  offer(p);
}
async function stopWith(pid) {
  const sess = Sync.sessions.get(pid);
  const p = sess && S.peers.get(sess.peerId);
  if (p) sendCtrl(p, { t: 'sync-stop', sid: Sync.share.id }).catch(() => {});
  Sync.sessions.delete(pid);
  Sync.share.targets = Sync.share.targets.filter(x => x !== pid);
  await saveShare();
  syncRender();
}
function diff(sess) {
  if (!Sync.local || !sess.remote) return;
  const send = [];
  const status = new Map();
  let bytes = 0;
  for (const [path, e] of Sync.local) {
    const r = sess.remote.get(path);
    if (!r || r[1] !== e.hash) { send.push(path); bytes += e.size; status.set(path, r ? 'M' : 'A'); }
  }
  const extra = [];
  for (const path of sess.remote.keys()) if (!Sync.local.has(path)) extra.push(path);
  send.sort();
  sess.diff = { send, bytes, extra, status };
}
const hasWork = sess => sess.diff && (sess.diff.send.length || (Sync.share.mirror && sess.diff.extra.length));
function autoPush(sess) { if (Sync.share.auto && sess.state === 'ready' && hasWork(sess)) push(sess); }

async function push(sess) {
  const p = S.peers.get(sess.peerId);
  if (!p || sess.state !== 'ready' || !hasWork(sess)) return;
  const sid = Sync.share.id;
  const list = [...sess.diff.send];
  const dels = Sync.share.mirror ? [...sess.diff.extra] : [];
  sess.state = 'syncing';
  sess.prog = { done: 0, total: list.length, bytes: 0, totalBytes: sess.diff.bytes, errors: 0, start: performance.now(), files: [], diffs: {}, status: new Map(sess.diff.status) };
  sess.inflight = 0; sess.pending.clear();
  syncRender();
  const aliveNow = () => S.peers.get(sess.peerId) === p;
  try {
    await p.keyP;
    if (dels.length) await sendCtrl(p, { t: 'sync-del', sid, paths: dels });
    for (const path of list) {
      const ent = Sync.local.get(path);
      if (!ent) { sess.prog.total--; continue; }
      let file;
      try { file = await ent.handle.getFile(); } catch { sess.prog.total--; continue; }
      let hash = ent.hash;
      if (file.size !== ent.size || file.lastModified !== ent.mtime) hash = await hashFile(file);   // 훑은 뒤 또 바뀐 파일
      while (sess.inflight > SYNC_WINDOW && aliveNow()) await new Promise(r => sess.wake.push(r));
      if (!aliveNow()) throw new Error('peer gone');
      const how = via(p);
      const chunk = how === 'dc' ? CHUNK_DC : CHUNK_WS;
      const fid = S.fidSeq++;
      await sendCtrl(p, { t: 'sync-file', sid, fid, path, size: file.size, hash }, how);
      const weight = Math.max(file.size, 1);
      sess.inflight += weight;
      sess.pending.set(path, weight);
      for (let off = 0; off < file.size; off += READ_BLOCK) {
        const block = new Uint8Array(await file.slice(off, off + READ_BLOCK).arrayBuffer());
        for (let i = 0; i < block.length; i += chunk) {
          const frame = await frameChunk(p, fid, block.subarray(i, i + chunk));
          await drain(p, how);
          if (!canSend(p, how)) throw new Error('closed');
          rawSend(p, how, frame);
        }
        sess.prog.bytes += block.length;
        syncRender();
      }
    }
    // 마지막 파일들의 확인을 기다림
    const until = Date.now() + 120000;
    while (sess.pending.size && aliveNow() && Date.now() < until) await Promise.race([new Promise(r => sess.wake.push(r)), sleep(1000)]);
    if (sess.pending.size) throw new Error('ack timeout');
    const n = sess.prog.done;
    toast(sess.prog.errors ? `${n}개 보냄 · ${sess.prog.errors}개 실패` : `${sess.name}에 변경 ${n}개를 보냈어요`);
  } catch (err) {
    console.warn('push', err);
    toast('동기화가 중간에 끊겼어요. 다시 연결되면 남은 것만 이어서 맞춰요.');
  }
  const pg = sess.prog;
  if (pg && pg.files.length) {
    histAdd({ dir: 'out', folder: Sync.share.name, peer: sess.name, files: pg.files, errors: pg.errors }, pg.diffs);
  }
  sess.state = aliveNow() ? 'ready' : 'away';
  sess.prog = null;
  diff(sess);
  syncRender();
}
function wakeAll(sess) { for (const r of sess.wake.splice(0)) r(); }

// ---------- 받는 쪽 ----------
async function inOffer(p, m) {
  const sid = String(m.sid);
  if (!/^[a-z0-9]{12}$/.test(sid)) return;
  const rules = compileIgnore(`${DEFAULT_IGNORE}\n${SYNC_EXTRA_IGNORE}\n${m.rules || ''}`);
  let s = Sync.inbound.get(sid);
  if (!s) {
    const saved = await idb.get('kv', `recv:${sid}`);
    s = { sid, handle: saved ? saved.handle : null, count: 0, applied: 0, last: null, sig: '', timer: null, receiving: 0, cache: null, cacheTimer: null };
    Sync.inbound.set(sid, s);
  }
  Object.assign(s, { peerId: p.id, peerName: p.name, name: cleanName(m.name), rules });
  if (s.handle && await fsPermission(s.handle, 'readwrite', false)) return inReady(s);
  s.state = s.handle ? 'perm' : 'ask';
  sendCtrl(p, { t: 'sync-waiting', sid }).catch(() => {});
  toast(`${p.name}에서 '${s.name}' 폴더를 공유하려고 해요`);
  announce(`${p.name}에서 폴더 공유 요청`, `'${s.name}' 폴더를 받을 위치를 골라 주세요`);
  syncRender();
}
async function inPick(sid) {
  const s = Sync.inbound.get(sid);
  if (!s) return;
  let parent;
  try { parent = await showDirectoryPicker({ id: 'omgyeo-recv', mode: 'readwrite' }); } catch { return; }
  // 고른 폴더 이름이 공유 폴더와 같으면 그 폴더에, 아니면 그 안에 같은 이름의 폴더를 만들어 받음
  s.handle = parent.name === s.name ? parent : await parent.getDirectoryHandle(s.name, { create: true });
  await idb.set('kv', `recv:${sid}`, { handle: s.handle, name: s.name, peerName: s.peerName });
  persistStorage();
  inReady(s);
}
async function inAllow(sid) {
  const s = Sync.inbound.get(sid);
  if (!s) return;
  if (await fsPermission(s.handle, 'readwrite', true)) inReady(s);
  else toast('폴더 접근을 허용해야 받을 수 있어요.');
}
async function inReady(s) {
  s.state = 'ready';
  s.sig = null;   // 빈 폴더(요약값 '')도 처음 한 번은 꼭 보내도록
  syncRender();
  await inIndex(s);
  clearInterval(s.timer);
  s.timer = setInterval(() => inIndex(s), SYNC_RESCAN_RECV);   // 이쪽에서 고친 파일도 알려 줌
}
async function inIndex(s) {
  if (s.state !== 'ready' || s.receiving || s.indexing) return;
  const p = S.peers.get(s.peerId);
  if (!p) return;
  s.indexing = true;
  try {
    await flushCache(s);
    const idx = await scanFolder(s.handle, s.rules, `recv:${s.sid}`);
    const entries = [...idx].map(([path, e]) => [path, e.size, e.hash]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const sig = entries.map(e => `${e[0]}|${e[2]}`).join('\n');
    if (sig !== s.sig) {
      s.sig = sig;
      if (!entries.length) await sendCtrl(p, { t: 'sync-index', sid: s.sid, first: true, last: true, files: [] });
      for (let i = 0; i < entries.length; i += SYNC_INDEX_PART) {
        await sendCtrl(p, { t: 'sync-index', sid: s.sid, first: i === 0, last: i + SYNC_INDEX_PART >= entries.length, files: entries.slice(i, i + SYNC_INDEX_PART) });
      }
    }
  } catch (err) {
    console.warn('index', err);
    if (!(await fsPermission(s.handle, 'readwrite', false))) { s.state = 'perm'; syncRender(); }
  } finally { s.indexing = false; }
}
async function inFile(p, m) {
  const s = Sync.inbound.get(m.sid);
  const path = safePath(m.path);
  const fail = msg => sendCtrl(p, { t: 'sync-err', sid: m.sid, path: m.path, msg }).catch(() => {});
  if (!s || !['ready', 'receiving'].includes(s.state)) return fail('not ready');
  if (!path || isIgnored(s.rules, path, false)) return fail('bad path');
  try {
    let existed = false, oldText = null;
    try {
      const old = await (await fileHandleAt(s.handle, path, false)).getFile();
      existed = true;
      if (isTextPath(path)) oldText = await readTextMaybe(old);
    } catch {}
    const fh = await fileHandleAt(s.handle, path, true);
    const w = await fh.createWritable();   // 다 쓰고 닫을 때 한 번에 바뀜 (쓰는 중에 파일이 깨지지 않음)
    const st = { s, path, fh, w, size: Number(m.size) || 0, hash: String(m.hash), done: 0, status: existed ? 'M' : 'A', existed, oldText };
    s.receiving++; s.state = 'receiving';
    if (st.size === 0) return inFinish(p, st);
    Sync.fidMap.set(`${p.id}:${m.fid}`, st);
    syncRender();
  } catch (err) {
    console.warn('sync write', err);
    fail(err.message);
  }
}
Sync.onChunk = async (p, fid, data) => {
  const key = `${p.id}:${fid}`;
  const st = Sync.fidMap.get(key);
  if (!st) return;
  try { await st.w.write(data); } catch (err) {
    Sync.fidMap.delete(key);
    st.w.abort().catch(() => {});
    st.s.receiving--; if (!st.s.receiving) st.s.state = 'ready';
    sendCtrl(p, { t: 'sync-err', sid: st.s.sid, path: st.path, msg: err.message }).catch(() => {});
    return;
  }
  st.done += data.length;
  if (st.done >= st.size) { Sync.fidMap.delete(key); await inFinish(p, st); }
};
async function inFinish(p, st) {
  const s = st.s;
  try {
    await st.w.close();
    const file = await st.fh.getFile();
    if (!s.cache) s.cache = (await idb.get('hash', `recv:${s.sid}`)) || {};
    s.cache[st.path] = [file.size, file.lastModified, st.hash];   // 받은 파일은 다시 해시하지 않도록
    clearTimeout(s.cacheTimer); s.cacheTimer = setTimeout(() => flushCache(s), 1000);
    s.count++; s.applied++; s.last = Date.now();
    let d = null;
    if (isTextPath(st.path) && (!st.existed || st.oldText != null)) {
      const newText = await readTextMaybe(file);
      if (newText != null) d = lineDiff(st.existed ? st.oldText : '', newText);
    }
    if (!s.batch) s.batch = { files: [], diffs: {} };
    s.batch.files.push([st.path, st.status, st.size, d ? d.adds : null, d ? d.dels : null]);
    if (d && d.hunks) s.batch.diffs[st.path] = d.hunks;
    sendCtrl(p, { t: 'sync-ack', sid: s.sid, path: st.path, size: st.size, hash: st.hash, st: st.status, adds: d ? d.adds : null, dels: d ? d.dels : null, diff: d ? d.hunks : null }).catch(() => {});
  } catch (err) {
    sendCtrl(p, { t: 'sync-err', sid: s.sid, path: st.path, msg: err.message }).catch(() => {});
  }
  s.receiving--;
  if (!s.receiving) {
    s.state = 'ready';
    clearTimeout(s.doneTimer);
    s.doneTimer = setTimeout(() => {
      saveBatch(s);
      if (!s.applied) return;
      announce(`'${s.name}' 폴더 업데이트`, `${s.peerName}에서 변경 ${s.applied}개가 적용됐어요`);
      s.applied = 0;
    }, 1500);
  }
  syncRender();
}
async function flushCache(s) {
  if (!s.cache) return;
  clearTimeout(s.cacheTimer);
  const c = s.cache; s.cache = null;
  await idb.set('hash', `recv:${s.sid}`, c);
}
async function inDel(p, m) {
  const s = Sync.inbound.get(m.sid);
  if (!s || !['ready', 'receiving'].includes(s.state)) return;
  const removed = [];
  for (const raw of (m.paths || []).slice(0, 100000)) {
    const path = safePath(raw);
    if (!path || isIgnored(s.rules, path, false)) continue;
    try { await removeAt(s.handle, path); removed.push(raw); } catch {}
  }
  if (removed.length) {
    toast(`'${s.name}'에서 ${removed.length}개를 지웠어요 (보낸 쪽에서 지운 파일)`);
    if (!s.batch) s.batch = { files: [], diffs: {} };
    for (const path of removed) s.batch.files.push([path, 'D', 0, null, null]);
    clearTimeout(s.doneTimer);
    s.doneTimer = setTimeout(() => saveBatch(s), 1500);
  }
  sendCtrl(p, { t: 'sync-deleted', sid: m.sid, paths: removed }).catch(() => {});
}
function inStop(sid, notify) {
  const s = Sync.inbound.get(sid);
  if (!s) return;
  clearInterval(s.timer);
  Sync.inbound.delete(sid);
  if (notify) toast(`${s.peerName}이(가) '${s.name}' 폴더 공유를 멈췄어요`);
  syncRender();
}
async function inDecline(sid) {
  const s = Sync.inbound.get(sid);
  if (!s) return;
  const p = S.peers.get(s.peerId);
  if (p) sendCtrl(p, { t: 'sync-decline', sid }).catch(() => {});
  await idb.del('kv', `recv:${sid}`);
  inStop(sid, false);
}

// ---------- 메시지 ----------
Sync.onCtrl = async (p, m) => {
  const sess = p.caps && Sync.sessions.get(p.caps.pid);
  const mine = sess && Sync.share && m.sid === Sync.share.id;
  switch (m.t) {
    // 받는 쪽
    case 'sync-offer': return inOffer(p, m);
    case 'sync-file': return inFile(p, m);
    case 'sync-del': return inDel(p, m);
    case 'sync-stop': return inStop(m.sid, true);
    case 'sync-peek': return inPeek(p, m);
    case 'sync-peekr': { const w = Sync.peeks.get(m.rid); if (w) { Sync.peeks.delete(m.rid); w(m); } return; }
    // 공유하는 쪽
    case 'sync-waiting': if (mine) { sess.state = 'waiting'; syncRender(); } return;
    case 'sync-index':
      if (!mine) return;
      if (m.first) sess.parts = [];
      sess.parts.push(...(m.files || []));
      if (m.last) {
        sess.remote = new Map(sess.parts.map(([path, size, hash]) => [path, [size, hash]]));
        sess.parts = [];
        if (sess.state !== 'syncing') sess.state = 'ready';
        diff(sess); autoPush(sess);
        syncRender();
      }
      return;
    case 'sync-ack':
    case 'sync-err': {
      if (!mine) return;
      if (m.t === 'sync-ack' && sess.remote) sess.remote.set(m.path, [m.size, m.hash]);
      if (m.t === 'sync-ack' && sess.prog) {
        sess.prog.files.push([m.path, m.st || sess.prog.status.get(m.path) || 'M', m.size, m.adds ?? null, m.dels ?? null]);
        if (m.diff) sess.prog.diffs[m.path] = m.diff;
      }
      const w = sess.pending.get(m.path);
      if (w != null) { sess.pending.delete(m.path); sess.inflight -= w; }
      if (sess.prog) { if (m.t === 'sync-ack') sess.prog.done++; else sess.prog.errors++; }
      wakeAll(sess);
      syncRender();
      return;
    }
    case 'sync-deleted':
      if (mine && sess.remote) {
        for (const path of m.paths || []) { sess.remote.delete(path); if (sess.prog) sess.prog.files.push([path, 'D', 0, null, null]); }
        diff(sess); syncRender();
      }
      return;
    case 'sync-decline':
      if (mine) { toast(`${sess.name}이(가) 폴더 받기를 멈췄어요`); stopWith(sess.pid); }
      return;
  }
};

// ---------- 기기 드나듦 ----------
Sync.onPeerJoined = p => {
  if (isTarget(p)) offer(p);
  syncRender();
};
Sync.onPeerLeft = p => {
  for (const sess of Sync.sessions.values()) if (sess.peerId === p.id) { sess.state = 'away'; wakeAll(sess); }
  for (const [key, st] of Sync.fidMap) {
    if (!key.startsWith(`${p.id}:`)) continue;
    st.w.abort().catch(() => {});   // 쓰다 만 파일은 원래 내용 그대로 둠
    Sync.fidMap.delete(key);
    st.s.receiving = Math.max(0, st.s.receiving - 1);
  }
  for (const s of Sync.inbound.values()) if (s.peerId === p.id) { s.state = 'away'; clearInterval(s.timer); flushCache(s); }
  syncRender();
};

// ---------- 화면 ----------
let syncQueued = false;
function syncRender() {
  if (syncQueued || !FS_OK) return;
  syncQueued = true;
  const next = document.hidden ? cb => setTimeout(cb, 300) : requestAnimationFrame;
  next(() => { syncQueued = false; drawSync(); });
}
function drawSync() {
  const box = $('#syncBox');
  if (!box) return;
  const sh = Sync.share;
  const fsPeers = [...S.peers.values()].filter(p => p.caps && p.caps.fs);
  let html = `<div class="sync-head"><h2>폴더 동기화</h2><span>PC끼리 · 바뀐 파일만 보내요 · <button type="button" class="link" data-sa="hist">히스토리</button></span></div>`;

  // 받는 폴더
  for (const s of Sync.inbound.values()) {
    const st = {
      ask: `<b>${esc(s.peerName)}</b>이(가) <b>'${esc(s.name)}'</b> 폴더를 보내려고 해요. 고른 위치 안에 '${esc(s.name)}' 폴더를 만들어 받아요.`,
      perm: `<b>'${esc(s.name)}'</b> 폴더에 받으려면 접근 허용이 필요해요.`,
      ready: `<span class="ok">✓ 연결됨</span> · ${esc(s.peerName)}에서 받는 중 · 받은 파일 ${s.count}개${s.last ? ` · 마지막 적용 ${ago(s.last)}` : ''}`,
      receiving: `<span class="busy">변경 적용 중…</span> · 받은 파일 ${s.count}개`,
      away: '연결 끊김 · 다시 연결되면 이어서 받아요',
    }[s.state] || '';
    const act = {
      ask: `<button type="button" class="solid" data-sa="in-pick" data-id="${s.sid}">받을 위치 고르기</button><button type="button" data-sa="in-decline" data-id="${s.sid}">거절</button>`,
      perm: `<button type="button" class="solid" data-sa="in-allow" data-id="${s.sid}">폴더 접근 허용</button><button type="button" data-sa="in-decline" data-id="${s.sid}">거절</button>`,
    }[s.state] || `<button type="button" data-sa="in-decline" data-id="${s.sid}">받기 중지</button>`;
    html += `<div class="sync-card in"><div class="sc-top">${ICONS.folder}<div class="sc-name"><b>${esc(s.name)}</b><small>받는 폴더</small></div></div>
      <p class="sc-status">${st}</p><div class="sc-act">${act}</div></div>`;
  }

  // 공유하는 폴더
  if (!sh) {
    html += `<div class="sync-empty"><p>내 PC의 폴더를 연결된 PC와 맞춰요. 처음엔 전부, 그다음부턴 바뀐 파일만 보내서 zip으로 옮기는 것보다 훨씬 빨라요.</p>
      <button type="button" class="solid" data-sa="pick">공유할 폴더 고르기</button></div>`;
  } else {
    const n = Sync.local ? Sync.local.size : null;
    const size = Sync.local ? [...Sync.local.values()].reduce((a, e) => a + e.size, 0) : 0;
    html += `<div class="sync-card out"><div class="sc-top">${ICONS.folder}<div class="sc-name"><b>${esc(sh.name)}</b>
      <small>공유하는 폴더${n != null ? ` · 파일 ${n.toLocaleString()}개 · ${fmtSize(size)}` : ''}</small></div>
      <div class="sc-menu"><button type="button" class="link" data-sa="pick">폴더 바꾸기</button><button type="button" class="link" data-sa="unshare">공유 해제</button></div></div>`;
    if (!Sync.shareOk) html += `<div class="sc-act"><button type="button" class="solid" data-sa="grant">'${esc(sh.name)}' 폴더 접근 허용</button></div><p class="sc-status">브라우저를 다시 열면 한 번 허용해야 해요. 크롬에서 "방문할 때마다 허용"을 고르면 다음부턴 묻지 않아요.</p>`;
    if (Sync.scanMsg) html += `<p class="sc-status">${esc(Sync.scanMsg)}</p>`;

    if (Sync.shareOk) {
      const rows = [];
      const seen = new Set();
      for (const p of fsPeers) {
        seen.add(p.caps.pid);
        const sess = Sync.sessions.get(p.caps.pid);
        rows.push(sess ? peerRow(sess) : `<li><div class="pr-name"><b>${esc(p.name)}</b><small>연결됨 · 아직 공유 안 함</small></div>
          <div class="sc-act"><button type="button" data-sa="start" data-id="${p.id}">이 기기와 공유</button></div></li>`);
      }
      for (const sess of Sync.sessions.values()) if (!seen.has(sess.pid)) rows.push(peerRow(sess));
      html += rows.length ? `<ul class="sync-peers">${rows.join('')}</ul>`
        : `<p class="sc-status">폴더를 받을 PC가 연결되지 않았어요. 양쪽 모두 PC의 크롬이나 엣지에서 열어야 해요.</p>`;
      html += `<div class="sync-opts">
        <label><input type="checkbox" id="optAuto" ${sh.auto ? 'checked' : ''}> 바뀌면 자동으로 보내기</label>
        <label><input type="checkbox" id="optGit" ${sh.gitignore ? 'checked' : ''}> .gitignore 규칙 따르기</label>
        <label><input type="checkbox" id="optMirror" ${sh.mirror ? 'checked' : ''}> 내 쪽에 없는 파일은 상대 쪽에서도 지우기</label>
      </div>
      <details class="sync-ignore"${Sync.ignoreOpen ? ' open' : ''}><summary>제외 규칙</summary>
        <p>.gitignore와 같은 문법이에요. 기본으로 .git/, node_modules/ 는 빠져요.</p>
        <textarea id="ignoreText" rows="4" spellcheck="false" placeholder="예: dist/&#10;*.log&#10;.env">${esc(sh.ignore || '')}</textarea>
        <button type="button" data-sa="ignore">규칙 저장</button>
      </details>`;
    }
    html += '</div>';
  }
  // 입력 중인 제외 규칙은 다시 그리지 않음
  const ta = document.activeElement && document.activeElement.id === 'ignoreText';
  if (ta) return;
  box.innerHTML = html;
}
function peerRow(sess) {
  const d = sess.diff;
  let st = '', btn = '';
  const canPush = sess.state === 'ready' && hasWork(sess);
  if (sess.state === 'offer') st = '요청 보냄 · 상대가 확인하는 중';
  else if (sess.state === 'waiting') st = '상대가 받을 위치를 고르는 중';
  else if (sess.state === 'away') st = '연결 끊김 · 다시 연결되면 이어서 맞춰요';
  else if (sess.state === 'syncing' && sess.prog) {
    const pg = sess.prog;
    st = `<span class="busy">보내는 중 ${pg.done}/${pg.total}개 · ${fmtSize(pg.bytes)} / ${fmtSize(pg.totalBytes)}</span>`;
  } else if (sess.state === 'ready' && !sess.remote) st = '상대 폴더 확인 중…';
  else if (sess.state === 'ready' && d) {
    const parts = [];
    if (d.send.length) parts.push(`보낼 변경 ${d.send.length.toLocaleString()}개 · ${fmtSize(d.bytes)}`);
    if (Sync.share.mirror && d.extra.length) parts.push(`지울 파일 ${d.extra.length}개`);
    st = parts.length ? parts.join(' · ') : '<span class="ok">✓ 같아요</span>';
    if (!Sync.share.mirror && d.extra.length && !d.send.length) st += ` <small>(상대 쪽에만 있는 파일 ${d.extra.length}개)</small>`;
  }
  if (sess.state !== 'away') btn = `<button type="button" class="solid" data-sa="push" data-id="${sess.pid}" ${canPush ? '' : 'disabled'}>공유하기</button>`;
  const open = Sync.openList.has(sess.pid);
  const toggle = canPush ? `<button type="button" class="link" data-sa="list" data-id="${sess.pid}">${open ? '변경 목록 접기' : '변경 목록 보기'}</button>` : '';
  const list = canPush && open ? changeList(sess) : '';
  return `<li><div class="pr-name"><b>${esc(sess.name)}</b><small>${st}</small>${toggle}</div>
    <div class="sc-act">${btn}<button type="button" class="link" data-sa="stop" data-id="${sess.pid}">공유 끊기</button></div>${list}</li>`;
}

// ---------- 화면 조작 ----------
if (FS_OK) {
  $('#syncBox').addEventListener('click', e => {
    const b = e.target.closest('[data-sa]');
    if (!b || b.disabled) return;
    const id = b.dataset.id;
    switch (b.dataset.sa) {
      case 'pick': return pickShare();
      case 'grant': return grantShare();
      case 'unshare': return unshare();
      case 'start': return startWith(id);
      case 'stop': return stopWith(id);
      case 'push': { const s = Sync.sessions.get(id); return s && push(s); }
      case 'list': Sync.openList.has(id) ? Sync.openList.delete(id) : Sync.openList.add(id); return syncRender();
      case 'peek': return peek(id, b.dataset.path);
      case 'hist': return openHistory();
      case 'in-pick': return inPick(id);
      case 'in-allow': return inAllow(id);
      case 'in-decline': return inDecline(id);
      case 'ignore': {
        Sync.share.ignore = $('#ignoreText').value;
        return saveShare().then(buildRules).then(() => { toast('제외 규칙을 저장했어요'); reoffer(); });
      }
    }
  });
  $('#syncBox').addEventListener('change', async e => {
    if (!Sync.share) return;
    if (e.target.id === 'optAuto') { Sync.share.auto = e.target.checked; for (const s of Sync.sessions.values()) autoPush(s); }
    if (e.target.id === 'optMirror') Sync.share.mirror = e.target.checked;
    if (e.target.id === 'optGit') { Sync.share.gitignore = e.target.checked; await buildRules(); reoffer(); }
    await saveShare();
    syncRender();
  });
  $('#syncBox').addEventListener('toggle', e => { if (e.target.classList.contains('sync-ignore')) Sync.ignoreOpen = e.target.open; }, true);
}
// 규칙이 바뀌면 상대도 같은 규칙으로 다시 훑도록
function reoffer() {
  Sync.local = null;
  scanShare();
  for (const sess of Sync.sessions.values()) { const p = S.peers.get(sess.peerId); if (p && sess.state !== 'away') offer(p); }
}

// ---------- 변경 목록 ----------
const ST_LABEL = { A: ['add', '+', '추가'], M: ['mod', '~', '수정'], D: ['del', '−', '삭제'] };
function changeList(sess) {
  const d = sess.diff;
  const rows = d.send.map(path => [path, d.status.get(path) || 'M', Sync.local.get(path)]);
  if (Sync.share.mirror) for (const path of d.extra) rows.push([path, 'D', null]);
  const LIMIT = 300;
  const html = rows.slice(0, LIMIT).map(([path, st, e]) => {
    const [cls, mark, label] = ST_LABEL[st];
    const canPeek = st !== 'D' && isTextPath(path) && e && e.size <= TEXT_MAX;
    return `<div class="cl-row ${cls}"><span class="cl-mark" title="${label}">${mark}</span><span class="cl-path">${esc(path)}</span>
      <span class="cl-size">${e ? fmtSize(e.size) : ''}</span>
      ${canPeek ? `<button type="button" class="link" data-sa="peek" data-id="${sess.pid}" data-path="${esc(path)}">바뀐 줄</button>` : '<span></span>'}</div>`;
  }).join('');
  const more = rows.length > LIMIT ? `<div class="cl-more">외 ${rows.length - LIMIT}개</div>` : '';
  const cnt = { A: 0, M: 0, D: 0 };
  for (const r of rows) cnt[r[1]]++;
  return `<div class="changes"><div class="cl-sum"><span class="add">추가 ${cnt.A}</span><span class="mod">수정 ${cnt.M}</span>${Sync.share.mirror ? `<span class="del">삭제 ${cnt.D}</span>` : ''}</div>${html}${more}</div>`;
}
// 보내기 전에 상대 PC의 지금 내용과 비교
async function peek(pid, path) {
  const sess = Sync.sessions.get(pid);
  const p = sess && S.peers.get(sess.peerId);
  const e = Sync.local && Sync.local.get(path);
  if (!p || !e) return;
  const rid = randStr(10);
  const reply = new Promise(res => { Sync.peeks.set(rid, res); setTimeout(() => { if (Sync.peeks.delete(rid)) res(null); }, 10000); });
  sendCtrl(p, { t: 'sync-peek', sid: Sync.share.id, rid, path }).catch(() => {});
  const [r, mine] = await Promise.all([reply, e.handle.getFile().then(readTextMaybe).catch(() => null)]);
  if (!r) return toast('상대 PC에서 내용을 받지 못했어요.');
  if (mine == null || (r.exists && r.text == null)) return toast('텍스트 파일이 아니거나 너무 커서 줄 비교를 할 수 없어요.');
  openDiff(path, lineDiff(r.exists ? r.text : '', mine), r.exists ? '보내기 전 미리보기' : '새 파일 미리보기');
}
async function inPeek(p, m) {
  const s = Sync.inbound.get(m.sid);
  const path = safePath(m.path);
  const reply = o => sendCtrl(p, { t: 'sync-peekr', rid: m.rid, ...o }).catch(() => {});
  if (!s || !s.handle || s.peerId !== p.id || !path || isIgnored(s.rules, path, false) || !isTextPath(path)) return reply({ exists: false, text: null, denied: true });
  try {
    const file = await (await fileHandleAt(s.handle, path, false)).getFile();
    reply({ exists: true, text: await readTextMaybe(file) });
  } catch { reply({ exists: false, text: null }); }
}

// ---------- 히스토리 ----------
async function histAdd(entry, diffs) {
  const id = randStr(12);
  const counts = { A: 0, M: 0, D: 0 };
  for (const f of entry.files) counts[f[1]] = (counts[f[1]] || 0) + 1;
  const list = (await idb.get('kv', 'hist')) || [];
  list.unshift({ id, time: Date.now(), counts, ...entry });
  for (const old of list.splice(200)) idb.del('kv', `histdiff:${old.id}`);   // 최근 200번까지만
  await idb.set('kv', 'hist', list);
  if (diffs && Object.keys(diffs).length) await idb.set('kv', `histdiff:${id}`, diffs);
}
function saveBatch(s) {
  const b = s.batch;
  s.batch = null;
  if (b && b.files.length) histAdd({ dir: 'in', folder: s.name, peer: s.peerName, files: b.files, errors: 0 }, b.diffs);
}
const pad2 = n => String(n).padStart(2, '0');
const fmtTime = t => { const d = new Date(t); return `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
async function openHistory() {
  const list = (await idb.get('kv', 'hist')) || [];
  const body = list.length ? list.map(h => {
    const c = h.counts;
    const chips = [c.A && `<span class="add">추가 ${c.A}</span>`, c.M && `<span class="mod">수정 ${c.M}</span>`, c.D && `<span class="del">삭제 ${c.D}</span>`, h.errors && `<span class="del">실패 ${h.errors}</span>`].filter(Boolean).join('');
    return `<details class="h-item" data-id="${h.id}"><summary>
        <span class="h-time">${fmtTime(h.time)}</span>
        <span class="h-what"><b>${esc(h.folder)}</b> ${h.dir === 'out' ? `보냄 → ${esc(h.peer)}` : `받음 ← ${esc(h.peer)}`}</span>
        <span class="cl-sum">${chips}</span></summary><div class="h-files" data-files="${h.id}"></div></details>`;
  }).join('') : '<p class="h-empty">아직 동기화 기록이 없어요. 공유하기를 하면 여기에 쌓여요.</p>';
  $('#histBody').innerHTML = body;
  Sync.hist = list;
  $('#histDlg').showModal();
}
async function fillHistory(id) {
  const h = (Sync.hist || []).find(x => x.id === id);
  const box = document.querySelector(`[data-files="${id}"]`);
  if (!h || !box || box.dataset.filled) return;
  box.dataset.filled = '1';
  const diffs = (await idb.get('kv', `histdiff:${id}`)) || {};
  Sync.histDiffs = Sync.histDiffs || {};
  Sync.histDiffs[id] = diffs;
  box.innerHTML = h.files.slice(0, 1000).map(([path, st, size, adds, dels]) => {
    const [cls, mark, label] = ST_LABEL[st] || ST_LABEL.M;
    const lines = adds != null ? `<span class="cl-lines"><span class="add">+${adds}</span> <span class="del">−${dels}</span></span>` : `<span class="cl-lines">${st === 'D' ? '' : fmtSize(size)}</span>`;
    const btn = diffs[path] ? `<button type="button" class="link" data-hd="${id}" data-path="${esc(path)}">바뀐 줄</button>` : '<span></span>';
    return `<div class="cl-row ${cls}"><span class="cl-mark" title="${label}">${mark}</span><span class="cl-path">${esc(path)}</span>${lines}${btn}</div>`;
  }).join('') + (h.files.length > 1000 ? `<div class="cl-more">외 ${h.files.length - 1000}개</div>` : '');
}
if (FS_OK) {
  $('#histBody').addEventListener('toggle', e => { if (e.target.open && e.target.dataset.id) fillHistory(e.target.dataset.id); }, true);
  $('#histBody').addEventListener('click', e => {
    const b = e.target.closest('[data-hd]');
    if (!b) return;
    const hunks = Sync.histDiffs[b.dataset.hd][b.dataset.path];
    const adds = (hunks.match(/^\+/gm) || []).length, dels = (hunks.match(/^-/gm) || []).length;
    openDiff(b.dataset.path, { hunks, adds, dels }, '히스토리');
  });
  $('#histClose').onclick = () => $('#histDlg').close();
  $('#histClear').onclick = async () => {
    if ($('#histClear').dataset.armed !== '1') { $('#histClear').dataset.armed = '1'; $('#histClear').textContent = '한 번 더 누르면 지워요'; return; }
    const list = (await idb.get('kv', 'hist')) || [];
    for (const h of list) idb.del('kv', `histdiff:${h.id}`);
    await idb.del('kv', 'hist');
    $('#histClear').dataset.armed = ''; $('#histClear').textContent = '기록 지우기';
    openHistory();
  };
}

// ---------- 바뀐 줄 보기 ----------
function openDiff(path, d, label) {
  $('#diffPath').textContent = path;
  $('#diffMeta').innerHTML = `${esc(label || '')} · <span class="add">+${d.adds}</span> <span class="del">−${d.dels}</span>${d.approx ? ' · 파일이 커서 바뀐 구간을 통째로 표시' : ''}${d.truncated ? ' · 길어서 일부만 표시' : ''}`;
  const lines = (d.hunks || '').split('\n').slice(0, 6000);
  $('#diffBody').innerHTML = lines.length && d.hunks ? lines.map(l => {
    const c = l.startsWith('@@') ? 'hk' : l[0] === '+' ? 'add' : l[0] === '-' ? 'del' : 'ctx';
    return `<div class="dl ${c}">${esc(l) || ' '}</div>`;
  }).join('') : '<div class="dl ctx">내용이 같아요.</div>';
  $('#diffDlg').showModal();
}
if (FS_OK) $('#diffClose').onclick = () => $('#diffDlg').close();

Sync.init();

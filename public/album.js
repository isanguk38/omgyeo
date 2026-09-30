'use strict';
/* 모임 앨범: 같은 방에 연결된 사람들이 올린 사진을 찍은 시간순으로 한곳에 모음
 * - 올릴 때는 작은 미리보기(약 30KB)와 정보만 모두에게 보내고, 원본은 필요한 사진만 골라서 받음
 * - 원본은 올린 사람(또는 이미 원본을 받은 사람)에게서 기기끼리 직접 받음. 서버에는 저장하지 않음
 * - 연사처럼 비슷한 사진은 촬영 시각과 이미지 지문(dHash)으로 한 묶음으로 보여 줌
 * - 앨범은 방별로 이 브라우저(IndexedDB)에 저장. 원본은 내가 올렸거나 받은 것만 가지고 있음
 */
const ALB_THUMB = 360;                // 미리보기 긴 변(px)
const ALB_THUMB_MAX = 220 * 1024;     // 받는 미리보기 크기 한도
const ALB_STALL = 20000;              // 원본 받기에서 이만큼 진행이 없으면 다른 사람에게 요청
const ALB_SIMILAR_MS = 20000;         // 비슷한 사진으로 묶을 촬영 간격
const ALB_SIMILAR_BITS = 12;          // 이미지 지문 차이 허용치 (64비트 중)

const Album = {
  room: null,
  items: new Map(),     // id -> 사진 기록
  holders: new Map(),   // id -> Set(peerId) 원본을 가진 연결된 기기
  fidMap: new Map(),    // `${peerId}:${fid}` -> 받는 중인 원본
  gets: new Map(),      // 요청 id -> 받는 중인 원본
  selecting: false, sel: new Set(), open: new Set(), unseen: 0, busy: null,
};
const albKey = id => `${PERSIST_ID}:${id}`;
const albPub = it => ({ id: it.id, name: it.name, size: it.size, mime: it.mime, taken: it.taken, dh: it.dh || '', up: it.up, upName: it.upName, w: it.w || 0, h: it.h || 0 });
function thumbUrl(it) { if (!it.thumbUrl && it.thumb) it.thumbUrl = URL.createObjectURL(it.thumb); return it.thumbUrl || ''; }
function origUrl(it) { if (!it.origUrl && it.orig) it.origUrl = URL.createObjectURL(it.orig); return it.origUrl || ''; }
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(b); });
async function dataURLToBlob(u) { return (await fetch(u)).blob(); }

// ---------- 사진 정보: 촬영 시각(EXIF), 미리보기, 이미지 지문 ----------
async function exifTaken(file) {
  try {
    if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
    const v = new DataView(await file.slice(0, 256 * 1024).arrayBuffer());
    if (v.getUint16(0) !== 0xFFD8) return null;
    let off = 2;
    while (off + 10 < v.byteLength) {
      const marker = v.getUint16(off), len = v.getUint16(off + 2);
      if (marker === 0xFFE1 && v.getUint32(off + 4) === 0x45786966) {   // "Exif"
        const t = off + 10, le = v.getUint16(t) === 0x4949;
        const g16 = o => v.getUint16(t + o, le), g32 = o => v.getUint32(t + o, le);
        const ifd = at => { const tags = {}; const n = g16(at); for (let i = 0; i < n; i++) { const e = at + 2 + i * 12; tags[g16(e)] = { count: g32(e + 4), val: g32(e + 8), pos: e + 8 }; } return tags; };
        const str = tag => { if (!tag) return null; const o = tag.count > 4 ? tag.val : tag.pos; let s = ''; for (let i = 0; i < tag.count - 1; i++) s += String.fromCharCode(v.getUint8(t + o + i)); return s; };
        const ifd0 = ifd(g32(4));
        let dt = null;
        if (ifd0[0x8769]) { const sub = ifd(ifd0[0x8769].val); dt = str(sub[0x9003]) || str(sub[0x9004]); }
        dt = dt || str(ifd0[0x0132]);
        const m = dt && /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(dt);
        return m ? new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime() : null;
      }
      if ((marker & 0xFF00) !== 0xFF00) break;
      off += 2 + len;
    }
  } catch {}
  return null;
}
function videoFrame(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
    const fail = () => { URL.revokeObjectURL(url); reject(new Error('video')); };
    v.onerror = fail;
    v.onloadeddata = () => { v.currentTime = Math.min(0.5, (v.duration || 1) / 2); };
    v.onseeked = () => { resolve({ src: v, w: v.videoWidth, h: v.videoHeight, done: () => URL.revokeObjectURL(url) }); };
    setTimeout(fail, 8000);
  });
}
function dHash(src, w, h) {
  const c = document.createElement('canvas');
  c.width = 9; c.height = 8;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.drawImage(src, 0, 0, w, h, 0, 0, 9, 8);
  const d = g.getImageData(0, 0, 9, 8).data;
  let bits = '';
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const i = (y * 9 + x) * 4, j = i + 4;
    bits += (d[i] * 0.3 + d[i + 1] * 0.59 + d[i + 2] * 0.11) > (d[j] * 0.3 + d[j + 1] * 0.59 + d[j + 2] * 0.11) ? '1' : '0';
  }
  let hex = '';
  for (let k = 0; k < 64; k += 4) hex += parseInt(bits.slice(k, k + 4), 2).toString(16);
  return hex;
}
function hamming(a, b) {
  if (!a || !b || a.length !== b.length) return 64;
  let n = 0;
  for (let i = 0; i < a.length; i++) { let x = parseInt(a[i], 16) ^ parseInt(b[i], 16); while (x) { n += x & 1; x >>= 1; } }
  return n;
}
async function makeThumb(file) {
  let src, w, h, done = () => {};
  try {
    if (file.type.startsWith('video/')) ({ src, w, h, done } = await videoFrame(file));
    else { src = await createImageBitmap(file); w = src.width; h = src.height; }
  } catch { return { thumb: null, dh: '', w: 0, h: 0 }; }   // 브라우저가 못 여는 형식(예: 일부 HEIC)
  const scale = Math.min(1, ALB_THUMB / Math.max(w, h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w * scale)); c.height = Math.max(1, Math.round(h * scale));
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  const thumb = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.72));
  const dh = dHash(src, w, h);
  if (src.close) src.close();
  done();
  return { thumb, dh, w, h };
}

// ---------- 방 바뀜, 불러오기 ----------
Album.load = async room => {
  for (const it of Album.items.values()) { if (it.thumbUrl) URL.revokeObjectURL(it.thumbUrl); if (it.origUrl) URL.revokeObjectURL(it.origUrl); }
  Album.room = room; Album.items.clear(); Album.holders.clear(); Album.sel.clear(); Album.selecting = false; Album.unseen = 0;
  if (room) for (const r of await idb.albumList(room)) if (r.owner === PERSIST_ID && Album.room === room) Album.items.set(r.id, r);
  albRender();
};
async function albSaveRec(it) { it.k = albKey(it.id); await idb.albumPut({ ...it, thumbUrl: undefined, origUrl: undefined }); persistStorage(); }

// ---------- 올리기 ----------
async function albUpload(files) {
  const list = [...files].filter(f => /^(image|video)\//.test(f.type) || /\.(jpe?g|png|gif|webp|heic|heif|mp4|mov)$/i.test(f.name));
  if (!list.length) return toast('사진이나 영상만 올릴 수 있어요.');
  if (!S.room) return;
  Album.busy = `사진 정리 중 0/${list.length}`; albRender();
  let n = 0;
  for (const f of list) {
    const [taken, meta] = await Promise.all([exifTaken(f), makeThumb(f)]);
    const it = {
      id: randStr(14), room: S.room, owner: PERSIST_ID, up: PERSIST_ID, upName: myName,
      name: cleanName(f.name), size: f.size, mime: f.type || 'application/octet-stream',
      taken: taken || f.lastModified || Date.now(), added: Date.now(), dh: meta.dh, w: meta.w, h: meta.h, thumb: meta.thumb, orig: f,
    };
    Album.items.set(it.id, it);
    await albSaveRec(it);
    const thumb = it.thumb ? await blobToDataURL(it.thumb) : null;
    for (const p of S.peers.values()) sendCtrl(p, { t: 'alb-add', item: albPub(it), thumb, have: true }).catch(() => {});
    Album.busy = `사진 정리 중 ${++n}/${list.length}`;
    albRender();
  }
  Album.busy = null;
  albRender();
  toast(S.peers.size ? `사진 ${n}장을 올렸어요. 연결된 사람들 앨범에 바로 보여요.` : `사진 ${n}장을 올렸어요. 다른 사람이 연결되면 앨범에 보여요.`);
}

// ---------- 원본 받기 ----------
function albCandidates(it) {
  const peers = [...S.peers.values()];
  const up = peers.filter(p => p.caps && p.caps.pid === it.up);
  const others = peers.filter(p => !up.includes(p) && (Album.holders.get(it.id) || new Set()).has(p.id));
  return [...up, ...others];
}
function albRequest(p, it) {
  return new Promise((resolve, reject) => {
    const rid = randStr(10);
    const g = { rid, it, p, parts: [], size: 0, done: 0, fid: null, lastAt: Date.now(), resolve, reject };
    Album.gets.set(rid, g);
    const tick = setInterval(() => {
      if (!Album.gets.has(rid)) return clearInterval(tick);
      if (!alive(p) || Date.now() - g.lastAt > ALB_STALL) { clearInterval(tick); albDropGet(g); reject(new Error('stalled')); }
    }, 1000);
    sendCtrl(p, { t: 'alb-get', id: it.id, rid }).catch(() => {});
  });
}
function albDropGet(g) { Album.gets.delete(g.rid); if (g.fid != null) Album.fidMap.delete(`${g.p.id}:${g.fid}`); }
async function albOriginal(it) {
  if (it.orig) return it.orig;
  for (const p of albCandidates(it)) {
    try {
      const blob = await albRequest(p, it);
      it.orig = blob;
      await albSaveRec(it);
      for (const q of S.peers.values()) sendCtrl(q, { t: 'alb-have', id: it.id }).catch(() => {});   // 이제 나도 원본을 나눠 줄 수 있음
      return blob;
    } catch {}
  }
  throw new Error('nobody');
}
async function albSave(ids) {
  const list = ids.map(id => Album.items.get(id)).filter(Boolean).sort((a, b) => a.taken - b.taken);
  if (!list.length) return;
  const got = [];
  let failed = 0, i = 0;
  for (const it of list) {
    Album.busy = `원본 받는 중 ${++i}/${list.length}`; albRender();
    try { got.push({ blob: await albOriginal(it), name: it.name, mime: it.mime }); } catch { failed++; }
  }
  Album.busy = null; albRender();
  if (failed) toast(`${failed}장은 원본을 가진 사람이 지금 연결돼 있지 않아서 받지 못했어요. 올린 사람이 연결되면 다시 시도해 주세요.`, 5000);
  if (!got.length) return;
  // 같은 이름 정리
  const seen = new Map();
  for (const g of got) {
    const c = seen.get(g.name) || 0; seen.set(g.name, c + 1);
    if (c) { const d = g.name.lastIndexOf('.'); g.name = d > 0 ? `${g.name.slice(0, d)} (${c})${g.name.slice(d)}` : `${g.name} (${c})`; }
  }
  const stamp = (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; })();
  if (S.dl && S.dl.ok) {   // 바로 저장 폴더가 있으면 그 안에 "모임 앨범 날짜" 폴더로
    try {
      const dir = await S.dl.handle.getDirectoryHandle(`모임 앨범 ${stamp}`, { create: true });
      for (const g of got) { const fh = await uniqueFileHandle(dir, g.name); const w = await fh.createWritable(); await w.write(g.blob); await w.close(); }
      return toast(`원본 ${got.length}장을 '${S.dl.handle.name}/모임 앨범 ${stamp}' 폴더에 저장했어요`, 4000);
    } catch { toast('저장 폴더에 쓰지 못해서 다운로드로 저장해요.'); }
  }
  if (IS_MOBILE || got.length === 1) return saveBlobs(got);   // 폰은 공유 메뉴로 사진 앱에 저장
  const entries = [];
  for (const g of got) entries.push({ path: g.name, blob: g.blob, size: g.blob.size, crc: crc32(0, new Uint8Array(await g.blob.arrayBuffer())) });
  saveBlobs([{ blob: buildZip(entries), name: `모임 앨범 ${stamp}.zip`, mime: 'application/zip' }]);
}
async function albDelete(ids) {
  const mine = ids.map(id => Album.items.get(id)).filter(it => it && it.up === PERSIST_ID);
  if (!mine.length) return toast('내가 올린 사진만 지울 수 있어요.');
  for (const it of mine) {
    Album.items.delete(it.id); await idb.albumDel(albKey(it.id));
    for (const p of S.peers.values()) sendCtrl(p, { t: 'alb-del', id: it.id }).catch(() => {});
  }
  toast(`내가 올린 사진 ${mine.length}장을 모두의 앨범에서 지웠어요${mine.length < ids.length ? ' (다른 사람 사진은 그대로예요)' : ''}`, 4000);
  Album.sel.clear(); Album.selecting = false; albRender();
}

// ---------- 메시지 ----------
Album.onCtrl = async (p, m) => {
  switch (m.t) {
    case 'alb-index': {   // 연결되면 서로 가진 사진 목록을 알려 주고, 없는 것만 요청
      const need = [];
      for (const [id, have] of (m.ids || []).slice(0, 20000)) {
        if (typeof id !== 'string') continue;
        if (have) { if (!Album.holders.has(id)) Album.holders.set(id, new Set()); Album.holders.get(id).add(p.id); }
        if (!Album.items.has(id)) need.push(id);
      }
      if (need.length) sendCtrl(p, { t: 'alb-need', ids: need }).catch(() => {});
      return;
    }
    case 'alb-need':
      for (const id of (m.ids || []).slice(0, 20000)) {
        const it = Album.items.get(id);
        if (it) await sendCtrl(p, { t: 'alb-add', item: albPub(it), thumb: it.thumb ? await blobToDataURL(it.thumb) : null, have: !!it.orig }).catch(() => {});
      }
      return;
    case 'alb-add': {
      const src = m.item || {};
      const id = String(src.id || '');
      if (!/^[a-z0-9]{8,20}$/.test(id) || !S.room) return;
      if (m.have) { if (!Album.holders.has(id)) Album.holders.set(id, new Set()); Album.holders.get(id).add(p.id); }
      if (Album.items.has(id)) return;
      let thumb = null;
      if (typeof m.thumb === 'string' && m.thumb.startsWith('data:image/') && m.thumb.length < ALB_THUMB_MAX * 1.4) thumb = await dataURLToBlob(m.thumb).catch(() => null);
      const it = {
        id, room: S.room, owner: PERSIST_ID, up: String(src.up || ''), upName: String(src.upName || p.name).slice(0, 30),
        name: cleanName(src.name), size: Number(src.size) || 0, mime: String(src.mime || ''), taken: Number(src.taken) || Date.now(),
        added: Date.now(), dh: /^[0-9a-f]{16}$/.test(src.dh) ? src.dh : '', w: Number(src.w) || 0, h: Number(src.h) || 0, thumb,
      };
      Album.items.set(id, it);
      await albSaveRec(it);
      if (!$('#paneAlbum') || $('#paneAlbum').hidden) Album.unseen++;
      albRender();
      return;
    }
    case 'alb-have':
      if (!Album.holders.has(m.id)) Album.holders.set(m.id, new Set());
      Album.holders.get(m.id).add(p.id);
      return;
    case 'alb-del': {
      const it = Album.items.get(m.id);
      if (it && p.caps && it.up === p.caps.pid) { Album.items.delete(m.id); Album.sel.delete(m.id); await idb.albumDel(albKey(m.id)); albRender(); }
      return;
    }
    case 'alb-get': {   // 원본 요청: 가지고 있으면 기기끼리 바로 보냄
      const it = Album.items.get(m.id);
      if (!it || !it.orig) return sendCtrl(p, { t: 'alb-nofile', rid: m.rid }).catch(() => {});
      const how = via(p);
      const chunk = how === 'dc' ? CHUNK_DC : CHUNK_WS;
      const fid = S.fidSeq++;
      try {
        await sendCtrl(p, { t: 'alb-file', rid: m.rid, fid, size: it.orig.size, mime: it.mime }, how);
        for (let off = 0; off < it.orig.size; off += READ_BLOCK) {
          const block = new Uint8Array(await it.orig.slice(off, off + READ_BLOCK).arrayBuffer());
          for (let i = 0; i < block.length; i += chunk) {
            const frame = await frameChunk(p, fid, block.subarray(i, i + chunk));
            await drain(p, how);
            if (!canSend(p, how)) return;
            rawSend(p, how, frame);
          }
        }
      } catch {}
      return;
    }
    case 'alb-file': {
      const g = Album.gets.get(m.rid);
      if (!g || g.p !== p) return;
      g.fid = m.fid; g.size = Number(m.size) || 0; g.mime = m.mime; g.lastAt = Date.now();
      Album.fidMap.set(`${p.id}:${m.fid}`, g);
      if (!g.size) { albDropGet(g); g.resolve(new Blob([], { type: g.mime })); }
      return;
    }
    case 'alb-nofile': {
      const g = Album.gets.get(m.rid);
      if (g) { albDropGet(g); g.reject(new Error('nofile')); }
      return;
    }
  }
};
Album.onChunk = (p, fid, data) => {
  const g = Album.fidMap.get(`${p.id}:${fid}`);
  if (!g) return;
  g.parts.push(data); g.done += data.length; g.lastAt = Date.now();
  if (g.done >= g.size) { albDropGet(g); g.resolve(new Blob(g.parts, { type: g.mime || g.it.mime })); }
};
Album.onPeerJoined = p => {
  if (!S.room || !alive(p)) return;
  const ids = [...Album.items.values()].map(it => [it.id, !!it.orig]);
  if (ids.length) sendCtrl(p, { t: 'alb-index', ids }).catch(() => {});
  albRender();
};
Album.onPeerLeft = p => {
  for (const g of [...Album.gets.values()]) if (g.p === p) { albDropGet(g); g.reject(new Error('gone')); }
  for (const set of Album.holders.values()) set.delete(p.id);
  albRender();
};

// ---------- 화면 ----------
let albQueued = false;
function albRender() { if (albQueued) return; albQueued = true; nextFrame(() => { albQueued = false; albDraw(); }); }
function albGroups() {
  const list = [...Album.items.values()].sort((a, b) => a.taken - b.taken);
  const groups = [];
  for (const it of list) {
    const g = groups[groups.length - 1];
    const last = g && g[g.length - 1];
    if (last && it.taken - last.taken <= ALB_SIMILAR_MS && hamming(last.dh, it.dh) <= ALB_SIMILAR_BITS) g.push(it);
    else groups.push([it]);
  }
  return groups;
}
function albTile(it, extra = '') {
  const sel = Album.sel.has(it.id);
  const url = thumbUrl(it);
  const video = it.mime.startsWith('video/');
  return `<button type="button" class="alb-tile${sel ? ' sel' : ''}${extra}" data-alb="${it.id}" title="${esc(it.name)} · ${esc(it.upName)}">
    ${url ? `<img src="${url}" alt="" loading="lazy">` : `<span class="alb-noimg">${esc(extOf(it.name))}</span>`}
    ${video ? '<span class="alb-video">▶</span>' : ''}
    <span class="alb-who">${esc(it.upName)}</span>
    ${it.orig ? '' : '<span class="alb-remote" title="원본은 올린 사람에게 있어요">미리보기</span>'}
    ${Album.selecting ? `<span class="alb-check">${sel ? '✓' : ''}</span>` : ''}
  </button>`;
}
function albDraw() {
  const pane = $('#paneAlbum');
  if (!pane) return;
  const n = Album.items.size;
  const people = new Set([...Album.items.values()].map(it => it.up)).size;
  $('#albInfo').textContent = n ? `사진 ${n.toLocaleString()}장 · ${people}명이 올림` : '아직 사진이 없어요';
  const badge = $('#albumBadge');
  badge.hidden = !Album.unseen; badge.textContent = String(Album.unseen);
  $('#albActions').innerHTML = Album.busy ? `<span class="alb-busy"><span class="spin"></span>${esc(Album.busy)}</span>`
    : Album.selecting
      ? `<span class="alb-count">${Album.sel.size}장 선택</span>
         <button type="button" class="link" data-alba="all">${Album.sel.size === n ? '선택 해제' : '전체 선택'}</button>
         <button type="button" data-alba="del" ${Album.sel.size ? '' : 'disabled'}>내 사진 지우기</button>
         <button type="button" class="solid" data-alba="save" ${Album.sel.size ? '' : 'disabled'}>원본 받기</button>
         <button type="button" data-alba="cancel">취소</button>`
      : `${n ? '<button type="button" data-alba="select">선택</button>' : ''}<button type="button" class="solid" data-alba="upload">＋ 사진 올리기</button>`;
  if (!n) {
    $('#albBody').innerHTML = `<div class="alb-empty"><span class="fe-ic" aria-hidden="true">${ICONS.folder}</span>
      <b>모임에서 찍은 사진을 한곳에 모아요</b>
      <span>연결된 사람 모두 사진을 올리면 찍은 시간순으로 합쳐져요. 작은 미리보기만 먼저 오고, 필요한 사진만 골라 원본으로 받을 수 있어요.</span>
      <button type="button" class="solid" data-alba="upload">＋ 사진 올리기</button></div>`;
    return;
  }
  let html = '', day = null;
  for (const g of albGroups()) {
    const d = dayKey(g[0].taken);
    if (d !== day) { if (day !== null) html += '</div>'; day = d; html += `<h3 class="alb-day">${dayLabel(g[0].taken)}</h3><div class="alb-grid">`; }
    if (g.length === 1) { html += albTile(g[0]); continue; }
    const key = g[0].id;
    if (Album.open.has(key)) {
      html += g.map((it, i) => albTile(it, ` in-group${i === 0 ? ' g-first' : ''}`)).join('');
      html += `<button type="button" class="alb-fold" data-fold="${key}">묶기</button>`;
    } else {
      html += albTile(g[0], ' stack').replace('</button>', `<span class="alb-stack" data-fold="${key}">비슷한 사진 ${g.length}장</span></button>`);
    }
  }
  if (day !== null) html += '</div>';
  const body = $('#albBody');
  const top = body.scrollTop;
  body.innerHTML = html;
  body.scrollTop = top;
}
// 크게 보기: 원본이 있으면 원본, 없으면 미리보기를 보여 주고 "원본 저장"으로 받음
function albViewList() {
  return albGroups().flat().map(it => ({
    album: true, id: it.id, kind: 'file', dir: 'in', name: it.orig ? it.name : `${it.name} (미리보기)`,
    mime: it.orig ? it.mime : 'image/jpeg', size: it.size, peerName: it.upName, state: 'done',
    url: it.orig ? origUrl(it) : thumbUrl(it),
  }));
}
if ($('#paneAlbum')) {
  $('#paneAlbum').addEventListener('click', e => {
    const fold = e.target.closest('[data-fold]');
    if (fold) { e.stopPropagation(); const k = fold.dataset.fold; Album.open.has(k) ? Album.open.delete(k) : Album.open.add(k); return albRender(); }
    const a = e.target.closest('[data-alba]');
    if (a && !a.disabled) {
      switch (a.dataset.alba) {
        case 'upload': if (!S.room) return; return $('#albInput').click();
        case 'select': Album.selecting = true; Album.sel.clear(); return albRender();
        case 'cancel': Album.selecting = false; Album.sel.clear(); return albRender();
        case 'all': if (Album.sel.size === Album.items.size) Album.sel.clear(); else for (const id of Album.items.keys()) Album.sel.add(id); return albRender();
        case 'save': { const ids = [...Album.sel]; Album.selecting = false; Album.sel.clear(); albRender(); return albSave(ids); }
        case 'del': return albDelete([...Album.sel]);
      }
    }
    const t = e.target.closest('[data-alb]');
    if (!t) return;
    const id = t.dataset.alb;
    if (Album.selecting) { Album.sel.has(id) ? Album.sel.delete(id) : Album.sel.add(id); return albRender(); }
    const list = albViewList();
    openViewerList(list, Math.max(0, list.findIndex(x => x.id === id)));
  });
  $('#albInput').addEventListener('change', e => { albUpload(e.target.files); e.target.value = ''; });
}

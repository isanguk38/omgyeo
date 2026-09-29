'use strict';
/* 폴더 접근 도구 (크롬·엣지 PC의 File System Access API)
 * - 고른 폴더 핸들을 IndexedDB에 기억해서 다음 접속 때 다시 고르지 않게 함
 * - 파일 지문(해시)을 [크기, 수정 시각, 해시]로 캐시해서 바뀐 파일만 다시 계산
 * - .gitignore와 같은 문법의 제외 규칙
 */
const FS_OK = typeof window.showDirectoryPicker === 'function' && !!globalThis.isSecureContext;

// ---------- IndexedDB ----------
const idb = (() => {
  let dbp = null;
  const open = () => dbp || (dbp = new Promise((resolve, reject) => {
    const r = indexedDB.open('omgyeo', 1);
    r.onupgradeneeded = () => { r.result.createObjectStore('kv'); r.result.createObjectStore('hash'); };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const req = fn(t.objectStore(store));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
    });
  }
  return {
    get: (store, key) => run(store, 'readonly', s => s.get(key)).catch(() => undefined),
    set: (store, key, val) => run(store, 'readwrite', s => { s.put(val, key); }).catch(err => console.warn('idb', err)),
    del: (store, key) => run(store, 'readwrite', s => { s.delete(key); }).catch(() => {}),
  };
})();

// 디스크가 부족해도 브라우저가 이 사이트의 저장 데이터(폴더 기억, 해시 캐시)를 지우지 않도록 요청
async function persistStorage() {
  try { if (navigator.storage && navigator.storage.persist && !(await navigator.storage.persisted())) await navigator.storage.persist(); } catch {}
}

// ---------- 권한 ----------
async function fsPermission(handle, mode, ask) {
  const opts = { mode };
  try {
    if ((await handle.queryPermission(opts)) === 'granted') return true;
    if (!ask) return false;
    return (await handle.requestPermission(opts)) === 'granted';
  } catch { return false; }
}

// ---------- 제외 규칙 (.gitignore 문법의 주요 부분: *, **, ?, 끝의 /, 앞의 /, !부정) ----------
const DEFAULT_IGNORE = ['.git/', 'node_modules/', '.DS_Store', 'Thumbs.db', 'desktop.ini', '~$*'].join('\n');
function compileIgnore(text) {
  const rules = [];
  for (let line of String(text || '').split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#')) continue;
    let neg = false;
    if (line.startsWith('!')) { neg = true; line = line.slice(1); }
    const dirOnly = line.endsWith('/');
    if (dirOnly) line = line.slice(0, -1);
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    let re = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '*') {
        if (line[i + 1] === '*') {
          if (line[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
        } else re += '[^/]*';
      } else if (c === '?') re += '[^/]';
      else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
    const start = anchored ? '^' : '(?:^|/)';
    rules.push({ neg, dirOnly, exact: new RegExp(`${start}${re}$`), inside: new RegExp(`${start}${re}/`) });
  }
  return rules;
}
function isIgnored(rules, path, isDir) {
  let out = false;
  for (const r of rules) {
    const hit = r.inside.test(path) || (r.exact.test(path) && (isDir || !r.dirOnly));
    if (hit) out = !r.neg;
  }
  return out;
}

// ---------- 해시 ----------
const HASH_WHOLE = 16 * 1024 * 1024;   // 이보다 작으면 통째로
const HASH_BLOCK = 8 * 1024 * 1024;    // 크면 8MB 블록 해시들을 다시 해시
const hex = buf => Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
async function hashFile(file) {
  if (file.size <= HASH_WHOLE) return hex(await crypto.subtle.digest('SHA-256', await file.arrayBuffer())).slice(0, 32);
  const parts = [];
  for (let off = 0; off < file.size; off += HASH_BLOCK) {
    parts.push(new Uint8Array(await crypto.subtle.digest('SHA-256', await file.slice(off, off + HASH_BLOCK).arrayBuffer())));
  }
  const all = new Uint8Array(parts.length * 32);
  parts.forEach((p, i) => all.set(p, i * 32));
  return `m${hex(await crypto.subtle.digest('SHA-256', all)).slice(0, 31)}`;
}

// ---------- 폴더 훑기 ----------
// 결과: Map(path -> { size, mtime, hash, handle })
async function scanFolder(root, rules, scope, onProgress) {
  const list = [];
  async function walk(dir, prefix) {
    for await (const [name, h] of dir.entries()) {
      const path = prefix + name;
      if (h.kind === 'directory') { if (!isIgnored(rules, path, true)) await walk(h, `${path}/`); }
      else if (!isIgnored(rules, path, false)) list.push({ path, handle: h });
    }
  }
  await walk(root, '');
  const cache = (await idb.get('hash', scope)) || {};
  const next = {};
  const out = new Map();
  let changed = false, done = 0;
  const BATCH = 24;
  for (let i = 0; i < list.length; i += BATCH) {
    await Promise.all(list.slice(i, i + BATCH).map(async ({ path, handle }) => {
      let file;
      try { file = await handle.getFile(); } catch { return; }   // 훑는 사이 지워진 파일
      const c = cache[path];
      let hash;
      if (c && c[0] === file.size && c[1] === file.lastModified) hash = c[2];
      else { hash = await hashFile(file); changed = true; }
      next[path] = [file.size, file.lastModified, hash];
      out.set(path, { size: file.size, mtime: file.lastModified, hash, handle });
    }));
    done += Math.min(BATCH, list.length - i);
    if (onProgress) onProgress(done, list.length);
  }
  if (changed || Object.keys(cache).length !== Object.keys(next).length) await idb.set('hash', scope, next);
  return out;
}
// 받은 파일을 썼을 때 캐시에 바로 반영 (다시 해시하지 않도록)
async function rememberHash(scope, path, file, hash) {
  const cache = (await idb.get('hash', scope)) || {};
  cache[path] = [file.size, file.lastModified, hash];
  await idb.set('hash', scope, cache);
}

// ---------- 경로로 파일 다루기 ----------
async function fileHandleAt(root, path, create) {
  const parts = path.split('/');
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i], { create });
  return dir.getFileHandle(parts[parts.length - 1], { create });
}
async function removeAt(root, path) {
  const parts = path.split('/');
  let dir = root;
  for (let i = 0; i < parts.length - 1; i++) dir = await dir.getDirectoryHandle(parts[i]);
  await dir.removeEntry(parts[parts.length - 1]);
}
// 같은 이름이 있으면 "이름 (1).확장자"
async function uniqueFileHandle(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 1000; i++) {
    const candidate = i ? `${base} (${i})${ext}` : name;
    try { await dir.getFileHandle(candidate); } catch { return dir.getFileHandle(candidate, { create: true }); }
  }
  return dir.getFileHandle(`${base} (${Date.now()})${ext}`, { create: true });
}

// ---------- 텍스트 파일 줄 비교 (GitLab의 diff 화면처럼) ----------
const TEXT_MAX = 512 * 1024;   // 이보다 큰 파일은 줄 비교를 하지 않음
const TEXT_EXT = /\.(txt|md|markdown|mdx|js|mjs|cjs|jsx|ts|tsx|json|jsonc|css|scss|sass|less|html?|xml|svg|ya?ml|toml|ini|cfg|conf|env|properties|py|rb|php|java|kt|kts|go|rs|c|h|cc|cpp|hpp|cs|swift|m|mm|sh|bash|zsh|ps1|bat|cmd|sql|gradle|vue|svelte|astro|lua|pl|r|dart|scala|groovy|tf|csv|tsv|log|lock)$/i;
const TEXT_NAMES = /^(Dockerfile|Makefile|Procfile|README|LICENSE|CHANGELOG|\.env(\..+)?|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc|\.editorconfig|\.prettierrc|\.eslintrc|\.babelrc)$/i;
function isTextPath(path) { const base = path.split('/').pop(); return TEXT_EXT.test(base) || TEXT_NAMES.test(base); }
async function readTextMaybe(file) {
  if (!file || file.size > TEXT_MAX) return null;
  const buf = new Uint8Array(await file.arrayBuffer());
  if (buf.subarray(0, 8000).includes(0)) return null;   // NUL 바이트가 있으면 바이너리
  return new TextDecoder().decode(buf);
}
// 결과: { hunks: "@@ -1,3 +1,4 @@\n 같은 줄\n-지운 줄\n+추가한 줄", adds, dels, approx, truncated }
function lineDiff(oldText, newText, maxBytes = 64 * 1024) {
  const A = oldText ? oldText.split(/\r?\n/) : [];
  const B = newText ? newText.split(/\r?\n/) : [];
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let suf = 0;
  while (suf < A.length - pre && suf < B.length - pre && A[A.length - 1 - suf] === B[B.length - 1 - suf]) suf++;
  const a = A.slice(pre, A.length - suf), b = B.slice(pre, B.length - suf);
  const n = a.length, m = b.length;
  const mid = [];
  let approx = false;
  if (n * m <= 4e6) {   // 최장 공통 부분(LCS)으로 정확히 비교
    const W = m + 1, L = new Uint32Array((n + 1) * W);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) {
      L[i * W + j] = a[i] === b[j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
    }
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { mid.push([' ', a[i]]); i++; j++; }
      else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) mid.push(['-', a[i++]]);
      else mid.push(['+', b[j++]]);
    }
    while (i < n) mid.push(['-', a[i++]]);
    while (j < m) mid.push(['+', b[j++]]);
  } else {              // 너무 크면 바뀐 구간을 통째로 지우고 추가한 것으로 표시
    approx = true;
    for (const x of a) mid.push(['-', x]);
    for (const x of b) mid.push(['+', x]);
  }
  const ops = [...A.slice(0, pre).map(x => [' ', x]), ...mid, ...A.slice(A.length - suf).map(x => [' ', x])];
  let adds = 0, dels = 0;
  for (const [t] of ops) { if (t === '+') adds++; else if (t === '-') dels++; }
  // 바뀐 곳 앞뒤 3줄씩 묶어서 덩어리(hunk)로
  const CTX = 3, out = [];
  let size = 0, truncated = false, k = 0;
  const aLine = [], bLine = [];
  for (let i = 0, x = 1, y = 1; i < ops.length; i++) { aLine[i] = x; bLine[i] = y; if (ops[i][0] !== '+') x++; if (ops[i][0] !== '-') y++; }
  while (k < ops.length && !truncated) {
    while (k < ops.length && ops[k][0] === ' ') k++;
    if (k >= ops.length) break;
    const start = Math.max(0, k - CTX);
    let end = k;
    for (;;) {
      while (end < ops.length && ops[end][0] !== ' ') end++;
      let next = end;
      while (next < ops.length && ops[next][0] === ' ' && next - end < CTX * 2 + 1) next++;
      if (next < ops.length && ops[next][0] !== ' ' && next - end <= CTX * 2) { end = next; continue; }
      break;
    }
    const stop = Math.min(ops.length, end + CTX);
    const slice = ops.slice(start, stop);
    const ac = slice.filter(o => o[0] !== '+').length, bc = slice.filter(o => o[0] !== '-').length;
    const head = `@@ -${ac ? aLine[start] : aLine[start] - 1},${ac} +${bc ? bLine[start] : bLine[start] - 1},${bc} @@`;
    out.push(head); size += head.length;
    for (const [t, line] of slice) {
      const row = t + line;
      size += row.length + 1;
      if (size > maxBytes) { truncated = true; break; }
      out.push(row);
    }
    k = stop;
  }
  return { hunks: out.join('\n'), adds, dels, approx, truncated };
}

// 앱 화면(HTML·JS·CSS)을 캐시해서 무료 서버가 잠들어 있어도 화면은 바로 뜨게 함.
// 항상 네트워크를 먼저 시도하고, 3초 안에 응답이 없으면 캐시를 보여 줌.
const CACHE = 'omgyeo-v23';
const SHELL = ['/index.html', '/app.js', '/style.css', '/fsutil.js', '/sync.js', '/album.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  const key = e.request.mode === 'navigate' ? '/index.html' : url.pathname;
  if (!SHELL.includes(key)) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const net = fetch(e.request).then(r => { if (r.ok) cache.put(key, r.clone()); return r; });
    const cached = await cache.match(key);
    if (!cached) return net;
    const late = new Promise(res => setTimeout(() => res(cached), 3000));
    return Promise.race([net.catch(() => cached), late]);
  })());
});

// 알림을 누르면 열려 있는 옮겨 창으로 이동
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const c = list.find(w => new URL(w.url).origin === location.origin);
    return c ? c.focus() : self.clients.openWindow('/');
  }));
});

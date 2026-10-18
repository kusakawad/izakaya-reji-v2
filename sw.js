// 居酒屋レジ v2 オフライン用。アプリを更新したら VERSION を上げる
// 注意：本番版（/izakaya-reji/）と同じ kusakawad.github.io 上で動くのでキャッシュ置き場を共有する。
// 本番版は「izakaya-reji-」で始まるキャッシュを消すため、こちらは別の接頭辞を使い、自分の分だけを消す。
const VERSION = 'v2';
const PREFIX = 'akari-reji-v2-';
const CACHE = PREFIX + VERSION;
const FILES = ['./', './index.html', './manifest.webmanifest', './icon-192.png', './icon-512.png', './apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k.startsWith(PREFIX) && k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// ネットにつながっていれば最新を取得してキャッシュも更新、つながっていなければキャッシュを使う
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  if (!new URL(e.request.url).pathname.startsWith(new URL('./', self.registration.scope).pathname)) return;
  e.respondWith(
    fetch(e.request).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});

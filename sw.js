// SAEMi Service Worker — v6.9.5
// Handles: cache/offline, Web Push notifications, notification tap

const CACHE = 'saemi-v6.9.5';

// ── Install: cache the app shell ──────────────────────────────
self.addEventListener('install', e => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE)
      .then(c => c.add(self.registration.scope))
      .catch(() => {})
  );
});

// ── Activate: wipe old caches ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first with network fallback ──────────────────
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        if (res && res.status === 200 && res.type === 'basic') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(self.registration.scope));
    })
  );
});

// ── Message from app → show notification ─────────────────────
// Used for in-app triggered notifications (e.g. story alerts)
self.addEventListener('message', e => {
  if (e.data?.type !== 'SHOW_NOTIFICATION') return;
  const { title, body, icon } = e.data;
  e.waitUntil(
    self.registration.showNotification(title || 'SÆMi', {
      body: body || '…',
      icon: icon || undefined,
      badge: icon || undefined,
      tag: 'saemi-msg',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: self.registration.scope },
    })
  );
});

// ── Push event → show notification ───────────────────────────
// Payload from Cloudflare Worker: { title, body }
self.addEventListener('push', e => {
  let payload = { title: 'SÆMi', body: '…' };
  try {
    if (e.data) payload = { ...payload, ...e.data.json() };
  } catch {}

  e.waitUntil(
    self.registration.showNotification(payload.title || 'SÆMi', {
      body: payload.body || '…',
      tag: 'saemi-push',
      renotify: true,
      vibrate: [200, 100, 200],
      data: { url: self.registration.scope },
    })
  );
});

// ── Notification tap → focus or open app ─────────────────────
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) {
        if (c.url === e.notification.data?.url && 'focus' in c) return c.focus();
      }
      return clients.openWindow(e.notification.data?.url || self.registration.scope);
    })
  );
});

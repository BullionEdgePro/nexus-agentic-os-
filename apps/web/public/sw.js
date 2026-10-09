/* Nexus service worker (spec 2026-10-09-nexus-mobile-app-design.md).
 *
 * Three jobs and nothing else:
 *   1. turn a push into a notification;
 *   2. open the right chat when the notification is tapped;
 *   3. show an offline page when a navigation fails.
 *
 * NO DATA CACHE, deliberately. Nexus shows customers' private conversations;
 * a cached copy would outlive a sign-out and could be shown stale. The only
 * thing ever stored is the offline page, and API traffic is never intercepted.
 */
const CACHE = "nexus-shell-v1";
const PRECACHE = ["/offline.html"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Never touch API traffic: no interception, no caching, no fallback.
  if (url.pathname.startsWith("/api") || url.hostname === "api.nexusagenticos.com") return;
  // Only page navigations get the offline fallback; everything else goes
  // straight to the network as if this worker were not here.
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(() => caches.match("/offline.html")));
  }
});

self.addEventListener("push", (event) => {
  let data = { title: "Nexus", body: "You have a new update", tag: "nexus", url: "/inbox" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    // A malformed payload still produces a notification rather than nothing.
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      // A newer alert for the same chat replaces the old one, but still buzzes.
      renotify: true,
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: data.url },
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || "/inbox";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
      if (open) return open.focus().then((client) => client.navigate(target));
      return self.clients.openWindow(target);
    })
  );
});

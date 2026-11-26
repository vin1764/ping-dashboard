/* Ping's service worker: the app shell from the cache (instant open, works offline), the demo snapshot network-first,
 * and push notifications (docs/PUSH.md). Supabase calls are never cached here: the page keeps its own copy of the
 * last-loaded thread (IndexedDB) for reading offline, and queues what you send until you're back online.
 * BUILD is filled in by dashboard/build.sh, so every deploy installs a new worker with a fresh cache. */
const BUILD = "76aa3fe";
const SHELL = `ping-shell-${BUILD}`;
const DATA = "ping-data";
const FILES = ["./", "index.html", "style.css", "app.js", "onboarding.js", "names.js", "live.js", "today.js", "forms.js", "cards.js", "reply.js", "help.js", "answer_rules.js",
  "config.js", "manifest.webmanifest", "setup.html", "icons/icon-192.png", "icons/icon-512.png", "icons/maskable-512.png",
  "icons/badge-96.png", "icons/apple-touch-icon.png", "icons/favicon-32.png"];
const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.min.js";

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(SHELL);
    // straight from the network: a plain addAll can take the old copy from the browser's HTTP cache (Pages keeps
    // files 10 minutes), and the new build would then run yesterday's today.js
    await c.addAll(FILES.map((f) => new Request(f, { cache: "reload" })));
    try { await c.put(CDN, await fetch(CDN, { mode: "cors" })); } catch { /* the library comes from the network then */ }
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith("ping-shell-") && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

// cache first, then refresh the copy in the background (the next open gets the new one)
async function shell(req, key) {
  const c = await caches.open(SHELL);
  const hit = await c.match(key || req, { ignoreSearch: true });
  const fresh = fetch(req).then((r) => { if (r.ok) c.put(key || req, r.clone()); return r; }).catch(() => null);
  return hit || (await fresh) || new Response("Offline", { status: 503 });
}
// network first, the last copy when offline
async function data(req) {
  const c = await caches.open(DATA);
  try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
  catch { return (await c.match(req, { ignoreSearch: true })) || new Response("{}", { status: 503, headers: { "Content-Type": "application/json" } }); }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.href === CDN) { e.respondWith(caches.match(CDN).then((r) => r || fetch(req))); return; }
  if (url.origin !== self.location.origin || !url.pathname.startsWith(new URL(self.registration.scope).pathname)) return;
  if (url.pathname.endsWith("/demo-data.json") || url.pathname.endsWith("/demo-details.json")) { e.respondWith(data(req)); return; }
  if (req.mode === "navigate") { e.respondWith(shell(req, "index.html")); return; }
  e.respondWith(shell(req));
});

// ---- push (docs/PUSH.md): one notification, tap opens the thread at that message
self.addEventListener("push", (e) => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch { p = { title: "Ping", body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(p.title || "Ping", {
    body: p.body || "", tag: p.tag || "ping", renotify: !!p.tag, icon: "icons/icon-192.png", badge: "icons/badge-96.png",
    data: { url: p.url || "./#chat" }, timestamp: p.at ? Date.parse(p.at) : Date.now(),
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "./#chat", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); open.postMessage({ type: "open", url: target }); return; }
    await self.clients.openWindow(target);
  })());
});

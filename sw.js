/* LTPApp service worker — minimal app-shell precache for the iOS home-screen PWA.
 *
 * SCOPE: served from /sw.js (see backend/main.py service_worker route, which
 * sets Service-Worker-Allowed: /) so this worker controls the whole origin.
 *
 * WHAT IT CACHES
 *   - Precache (install): the HTML shell, boot-critical scripts, self-hosted
 *     fonts CSS, icons, the manifest, and the pinned CDN libraries (React,
 *     ReactDOM, DOMPurify, signature_pad — versioned URLs with SRI, safe to
 *     cache long-term). This is what lets the app open full-screen offline.
 *   - Runtime (stale-while-revalidate): every OTHER same-origin static asset
 *     (the /components, /modules, /data scripts, /assets fonts+images). They
 *     are all fetched on the first online load, so after one signed-in session
 *     the entire shell is available offline.
 *
 * WHAT IT NEVER CACHES (hard bypass, network passthrough):
 *   - /api/*, /auth/*, /pdf/*  — authenticated / per-user / tokenized data.
 *     Caching these could serve one user's data to another or a logged-out
 *     stale shell. They ALWAYS go to the network.
 *   - Anything that isn't a GET.
 *   - /sw.js itself (the browser manages worker updates natively).
 *
 * UPDATE STRATEGY (see components/register-sw.js):
 *   Bump CACHE_VERSION on any shell/asset change. A new worker installs and
 *   WAITS (we do NOT skipWaiting on install) so the running app isn't swapped
 *   mid-session. register-sw.js detects the waiting worker and shows a
 *   "new version — tap to refresh" banner; tapping posts SKIP_WAITING, this
 *   worker activates + claims clients, and the page reloads once. On activate
 *   we delete caches from older versions.
 */
'use strict';

// ── Bump this string whenever the app shell or any precached asset changes. ──
// It is the sole cache-busting lever (filenames are un-versioned and the server
// serves them no-cache/ETag, so the version here is what forces a fresh shell).
// v45: scan-import adds Claude label-OCR (live-view auto-escalation, snap
// fallback, and an in-viewfinder shutter). /api/scan/* is dynamic and already
// hard-bypassed by isBypass's /api/ rule — nothing OCR-related is ever cached.
// Decoder stack unchanged: native BarcodeDetector where available, else the
// vendored ZXing-C++ WASM (runtime-cached on first scan, not precached).
// v49: interactive drag-to-reorder (components/sortable.js) for quote and
// invoice line items + sections. index.html changed (new script tag + the
// reorder CSS), so the shell must be refetched; sortable.js itself is picked
// up by the runtime /components/ rule below, not precached.
// v50: the app typeface moved onto <body> and form controls were told to
// inherit it (index.html again). Two branches had independently claimed v49
// for the two changes; anything already holding a v49 shell needs a new
// string to refetch, so the merge takes the next one rather than reusing it.
// v51: per-client service rates (contract rates + day minimums). index.html
// gained three script tags (data/client-rates.js, components/client-rates.js,
// modules/quotes-client-rates.js), so the shell must be refetched; the new
// files themselves are picked up by the runtime /data/, /components/ and
// /modules/ rules below, not precached.
// v55: shared field labels + chip-field restyle, the per-quote expiry date, and
// the LTPApp hook-order fix. index.html is untouched, so it would have been easy
// to assume no bump was needed — but theme.js and app.js are BOTH precached and
// runtime-cached, so without a new version every device serves the whole old
// shell for one more launch and no worker installs, meaning no refresh banner
// either. The rule is the header above, not "did index.html change": any
// precached or runtime-cached file moving needs this string to move.
// v56: this worker answers GET_VERSION, and the sidebar footer shows the answer
// instead of a hardcoded "v1.0" that had never been iterated. app.js and
// components/register-sw.js changed with it. Remembering the bump is no longer
// on the author: tests/check_shell_version.py fails the PR when a file the
// browser caches moves and this string doesn't — it is what flagged this one.
// v57: editable terms & conditions on quotes and invoices. index.html gained a
// script tag (components/doc-terms.js), so the precached shell must be refetched;
// the component itself is picked up by the runtime /components/ rule below.
// v58: crew-announcement screenshots under assets/crew-email/. No script tag and
// no shell file moved — but /assets/ is runtime-cached, so a device holding the
// v57 cache would serve its own (empty) view of the new tree for one more launch.
// The images are linked from an email that renders outside the app entirely, so
// they have to be right the first time a crew member opens it.
// v59: the standalone crew announcement page (assets/crew-email/announcement.html)
// and the allow-list entry that serves it. Runtime-cached like everything under
// /assets/, and it is the page crew are sent when their mail client fails them —
// so a device answering it from a v58 cache would hand back the SPA shell that
// URL used to resolve to. Nothing precached moved; the bump is for that entry.
// v60: the crew announcement page is rebuilt through email_compose.email_shell
// (grey canvas, 580px card, masthead, footer) instead of a hand-rolled wrapper.
// The old one rendered with no padding: its markup carries an inline padding:0
// for mail clients, and inline beats any stylesheet selector, so the page's own
// <style> rule never applied. Bumped so no device answers that URL from a v59
// cache holding the broken copy.
// v61: the announcement page is rebuilt from the shared crew-briefing template
// so it matches the published artifact — the branded layout with numbered steps
// and proper list formatting, in place of the plain email-shell copy it used to
// serve. Its sender toolbar moved into assets/crew-email/briefing.js: script-src
// is 'self' with no 'unsafe-inline', so the inline block it used to carry was
// refused and the buttons rendered dead. Both files are runtime-cached, so a
// device on a v60 cache would pair the new page with no script at all.
// v62: the announcement page's sender toolbar was painted for everyone. The
// `hidden` attribute only carries a UA-stylesheet display:none, which .tools's
// display:flex overrides, so the page needs its own [hidden] reset — the
// artifact host injects one, the standalone page had nothing. Bumped so no
// device answers that URL from a v61 cache showing the toolbar to crew.
// v63: crew announcement copy edit — sections rewritten to stand on their own,
// "pencilled" corrected to the "penciled in" the app actually renders, and two
// content fixes from the owner: a request is ALWAYS sent even for work agreed
// by phone, and accepting is the first step in getting paid. Page + script both
// moved, so a v62 cache would serve the old wording.
var CACHE_VERSION = 'ltp-shell-v63';

var SAME_ORIGIN_PRECACHE = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.ico',
  '/assets/fonts.css',
  // Boot chain — the scripts index.html loads before the app can render.
  '/components/viewport-height.js',
  '/router.js',
  '/theme.js',
  '/app.js',
  '/mount.js',
  // Icons referenced by the manifest / head.
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png',
  '/assets/icons/apple-touch-icon.png',
];

// Cross-origin, version-pinned libraries (CORS-enabled on cdnjs). Best-effort:
// a CDN hiccup at install time must not fail the whole install.
var CDN_PRECACHE = [
  'https://cdnjs.cloudflare.com/ajax/libs/react/18.2.0/umd/react.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.2.0/umd/react-dom.production.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/dompurify/3.2.7/purify.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/signature_pad/5.0.4/signature_pad.umd.min.js',
];

// Paths that must always hit the network and never be cached.
function isBypass(url) {
  return url.pathname.startsWith('/api/') ||
         url.pathname.startsWith('/auth/') ||
         url.pathname.startsWith('/pdf/') ||
         url.pathname === '/sw.js';
}

// Same-origin static assets we runtime-cache (stale-while-revalidate).
function isRuntimeStatic(url) {
  if (url.pathname.startsWith('/assets/') ||
      url.pathname.startsWith('/components/') ||
      url.pathname.startsWith('/modules/') ||
      url.pathname.startsWith('/data/')) {
    return true;
  }
  // Root-level static files (e.g. /router.js, /theme.js, /manifest.webmanifest).
  return /\.(js|css|png|jpe?g|svg|gif|webp|ico|woff2?|ttf|otf|webmanifest)$/.test(url.pathname);
}

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_VERSION).then(function(cache) {
      // Same-origin core must succeed for a usable offline shell.
      var core = cache.addAll(SAME_ORIGIN_PRECACHE);
      // CDN libs are best-effort so a CDN failure can't break install.
      var cdn = Promise.all(CDN_PRECACHE.map(function(u) {
        return cache.add(new Request(u, { mode: 'cors' })).catch(function() {});
      }));
      return Promise.all([core, cdn]);
    })
    // NOTE: intentionally NO self.skipWaiting() here — the new worker waits so
    // register-sw.js can surface the "tap to refresh" prompt.
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) {
        if (k !== CACHE_VERSION) return caches.delete(k);
      }));
    }).then(function() {
      // Control existing clients immediately once activated (after skipWaiting).
      return self.clients.claim();
    })
  );
});

self.addEventListener('message', function(event) {
  if (!event.data) return;

  // Let the page trigger activation of a waiting worker (the "tap to refresh").
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
    return;
  }

  // Which shell this device is actually running. The app footer shows it so
  // "did my fix ship to this phone?" is answerable without devtools — the
  // question that follows every deploy, and the one that went unanswered when
  // a change shipped without a version bump.
  //
  // Answered on the asker's MessagePort rather than broadcast to all clients:
  // the page wants the version of the worker CONTROLLING it, and a newly
  // installed worker sitting in `waiting` must not answer for the active one.
  if (event.data.type === 'GET_VERSION') {
    var port = event.ports && event.ports[0];
    if (port) port.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});

// ── Web Push (iOS 16.4+ home-screen PWA) ────────────────────────────────────
// The push service wakes this worker and hands us the encrypted payload the
// backend sent (backend/webpush.py). iOS is strict: EVERY push event MUST end
// in a shown notification or the subscription is revoked — so the catch below
// always falls back to a generic notification rather than showing nothing.
self.addEventListener('push', function(event) {
  var data = {};
  try { data = event.data ? event.data.json() : {}; } catch (e) { data = {}; }
  var title = data.title || 'LTPApp';
  var options = {
    body: data.body || '',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    // Where notificationclick should take us (SPA hash route). Kept in data so
    // it survives the notification → click round-trip.
    data: { url: data.url || '/#/dashboard' },
    // Collapse repeats of the same subject instead of stacking duplicates.
    tag: data.tag || undefined,
  };
  event.waitUntil(
    self.registration.showNotification(title, options).catch(function() {
      // Never leave a push un-shown — iOS penalizes silent pushes.
      return self.registration.showNotification('LTPApp', { body: '' });
    })
  );
});

// Tapping a notification focuses an open app window (navigating it to the
// target route) or opens a new one if none is around.
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var target = (event.notification.data && event.notification.data.url) || '/#/dashboard';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list) {
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if ('focus' in c) {
          if ('navigate' in c) { try { c.navigate(target); } catch (e) {} }
          return c.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;  // never cache mutations

  var url;
  try { url = new URL(req.url); } catch (e) { return; }

  // Hard bypass: authenticated / tokenized / worker script — network only.
  if (isBypass(url)) return;

  // Navigations (opening the app / any SPA URL that resolves to index.html):
  // network-first so a fresh shell is preferred, cached shell as offline
  // fallback. The server strips the hash, so this is effectively GET '/'.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then(function(resp) {
        // Keep the cached shell fresh for offline launches.
        if (resp && resp.ok && url.origin === self.location.origin) {
          var copy = resp.clone();
          caches.open(CACHE_VERSION).then(function(c) { c.put('/', copy); });
        }
        return resp;
      }).catch(function() {
        return caches.match('/').then(function(m) {
          return m || caches.match('/index.html');
        });
      })
    );
    return;
  }

  // Cross-origin pinned CDN libs: cache-first (immutable, version-pinned URLs).
  if (url.origin === 'https://cdnjs.cloudflare.com') {
    event.respondWith(
      caches.match(req).then(function(hit) {
        return hit || fetch(req).then(function(resp) {
          if (resp && (resp.ok || resp.type === 'opaque')) {
            var copy = resp.clone();
            caches.open(CACHE_VERSION).then(function(c) { c.put(req, copy); });
          }
          return resp;
        });
      })
    );
    return;
  }

  // Same-origin static assets: stale-while-revalidate.
  if (url.origin === self.location.origin && isRuntimeStatic(url)) {
    event.respondWith(
      caches.open(CACHE_VERSION).then(function(cache) {
        return cache.match(req).then(function(hit) {
          var network = fetch(req).then(function(resp) {
            if (resp && resp.ok) cache.put(req, resp.clone());
            return resp;
          }).catch(function() { return hit; });
          // Serve cache immediately when present; otherwise wait for network.
          return hit || network;
        });
      })
    );
    return;
  }

  // Everything else: plain network (no caching).
});

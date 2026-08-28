/**
 * New Coworker service worker.
 *
 * Scope: the whole origin, registered from the dashboard once a user is
 * signed in. Its ONLY jobs are push delivery, the click receipt, and an
 * offline fallback for navigations.
 *
 * THIS FILE IS NOT TYPECHECKED AND NOT BUNDLED. It ships to browsers exactly
 * as written, so a reference to a name that does not exist is a runtime
 * failure on somebody's phone, where the only symptom is that an alert
 * silently never arrives. Two guards stand in for the compiler:
 * eslint.config.mjs runs no-undef over this file with serviceworker globals
 * (the same block, and the same reasoning, as vps/ ** /*.mjs), and
 * tests/service-worker-contract.test.ts asserts the payload keys read here
 * match what buildPushPayload actually produces and that every /api/ path
 * below resolves to a route that exists.
 *
 * DELIBERATELY NO CACHE API. Chrome's installability criteria only want a
 * fetch handler that can answer a navigation offline, and this app is a Next
 * build with content-hashed chunks: a cache-first worker over it is how you
 * serve an owner a three-week-old dashboard shell. Nothing here is cached.
 */

const RECEIPT_PATH = "/api/push/receipt";
const SUBSCRIBE_PATH = "/api/push/subscribe";
const VAPID_KEY_PATH = "/api/push/vapid-key";

const FALLBACK_TITLE = "New Coworker";
const FALLBACK_BODY = "You have a new alert. Tap to open your dashboard.";
const FALLBACK_URL = "/dashboard";

const OFFLINE_HTML =
  '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width,initial-scale=1">' +
  "<title>Offline</title><style>" +
  "body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;" +
  "background:#0d2235;color:#f7fafc;font:16px/1.5 system-ui,-apple-system,sans-serif;padding:24px}" +
  "div{max-width:22rem;text-align:center}h1{font-size:1.25rem;margin:0 0 .5rem}" +
  "p{margin:0;opacity:.8}</style></head><body><div>" +
  "<h1>You are offline</h1><p>New Coworker needs a connection. " +
  "This page will work again as soon as you are back online.</p>" +
  "</div></body></html>";

self.addEventListener("install", () => {
  // Take over immediately. A stale worker holding an old payload shape is
  // worse than a reload, because it fails silently rather than visibly.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await self.clients.claim();
      if (self.registration.navigationPreload) {
        try {
          await self.registration.navigationPreload.enable();
        } catch {
          // Not supported everywhere; the fetch handler works without it.
        }
      }
    })()
  );
});

/**
 * Render a push.
 *
 * This handler MUST always end in a showNotification. Chrome enforces the
 * userVisibleOnly contract it granted the subscription under: a push event
 * that shows nothing makes the browser post its own "This site has been
 * updated in the background" notification, and repeated violations revoke the
 * permission outright. So a malformed or empty payload still shows the
 * generic alert rather than returning early.
 */
self.addEventListener("push", (event) => {
  // Named `pushData`, not `data`: the envelope returned by our own /api routes
  // also has a `.data`, and tests/service-worker-contract.test.ts matches this
  // object's reads against buildPushPayload's output by name.
  let pushData = {};
  try {
    pushData = event.data ? event.data.json() : {};
  } catch {
    pushData = {};
  }

  const title =
    typeof pushData.title === "string" && pushData.title ? pushData.title : FALLBACK_TITLE;
  const body = typeof pushData.body === "string" && pushData.body ? pushData.body : FALLBACK_BODY;
  const url = typeof pushData.url === "string" && pushData.url ? pushData.url : FALLBACK_URL;
  const notificationId =
    typeof pushData.notificationId === "string" ? pushData.notificationId : null;
  const tag = typeof pushData.tag === "string" && pushData.tag ? pushData.tag : undefined;

  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      icon: "/logo-192.png",
      badge: "/logo-192.png",
      // Collapse repeats about the same subject, but still alert: without
      // renotify a replaced notification updates silently, which for an
      // urgent alert reads as never having arrived.
      tag,
      renotify: Boolean(tag),
      data: { url, notificationId }
    })
  );
});

/**
 * A tap. This is the read receipt, and the reason the channel is worth
 * building: it fires even when the app is already open and no navigation
 * happens, so it measures attention rather than traffic.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const payload = event.notification.data || {};
  const target = safeInternalPath(payload.url);

  event.waitUntil(
    Promise.all([reportClick(payload.notificationId), focusOrOpen(target)])
  );
});

/**
 * The push service rotated this subscription. Re-subscribe and re-register.
 *
 * Authenticated by the SESSION COOKIE, which a same-origin fetch sends
 * automatically. It deliberately does NOT present the old endpoint as proof
 * of identity: an endpoint is a bearer capability, so accepting one as
 * authentication would let anybody holding a leaked endpoint rebind the
 * owner's alerts to their own browser.
 *
 * If there is no session, this does nothing on purpose. The next dashboard
 * load re-subscribes, and any send in between gets a 410 and revokes cleanly.
 */
self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(resubscribe());
});

/**
 * Navigations only. Never intercept anything else: an asset handler here
 * would start caching a hashed Next build.
 */
self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        return new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }
    })()
  );
});

/**
 * Keep a tap inside the app. "Starts with /" is not enough on its own:
 * "//evil.example.com" is a protocol-relative URL the browser resolves
 * against another origin, which would let a notification navigate the owner
 * off-site.
 */
function safeInternalPath(value) {
  if (typeof value !== "string") return FALLBACK_URL;
  if (!value.startsWith("/") || value.startsWith("//")) return FALLBACK_URL;
  return value;
}

async function reportClick(notificationId) {
  try {
    const subscription = await self.registration.pushManager.getSubscription();
    if (!subscription) return;
    const body = { endpoint: subscription.endpoint };
    if (typeof notificationId === "string" && notificationId) {
      body.notificationId = notificationId;
    }
    await fetch(RECEIPT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body)
    });
  } catch {
    // A receipt is telemetry. Losing one must never stop the window opening.
  }
}

async function focusOrOpen(path) {
  const clientList = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true
  });
  for (const client of clientList) {
    if (new URL(client.url).origin !== self.location.origin) continue;
    await client.focus();
    if ("navigate" in client) {
      try {
        await client.navigate(path);
      } catch {
        // Some browsers refuse navigate() on a cross-document client; the
        // focus above still put the owner in the right app.
      }
    }
    return;
  }
  await self.clients.openWindow(path);
}

async function resubscribe() {
  try {
    const res = await fetch(VAPID_KEY_PATH, { credentials: "same-origin" });
    if (!res.ok) return;
    const json = await res.json();
    const publicKey = json && json.data ? json.data.publicKey : null;
    if (typeof publicKey !== "string" || !publicKey) return;

    const subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(publicKey)
    });

    await fetch(SUBSCRIBE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        businessId: null,
        subscription: subscription.toJSON()
      })
    });
  } catch {
    // No session, or the push service refused. The next dashboard load fixes
    // it; see the handler comment.
  }
}

/**
 * applicationServerKey wants raw bytes, and VAPID keys travel as base64url.
 * Duplicated from src/lib/push/vapid.ts on purpose: a service worker cannot
 * import from the app bundle, and inlining eight lines beats shipping a
 * second script just to share them.
 */
function base64UrlToUint8Array(base64Url) {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4);
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = self.atob(base64);
  const output = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) {
    output[i] = raw.charCodeAt(i);
  }
  return output;
}

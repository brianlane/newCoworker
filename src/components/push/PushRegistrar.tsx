"use client";

import { useEffect } from "react";
import { urlBase64ToUint8Array } from "@/lib/push/vapid";

/**
 * Marks that this browser was deliberately turned OFF, as opposed to having
 * lost its subscription.
 *
 * The silent re-create below cannot tell those apart on its own: "Turn off on
 * this device" revokes the row and drops the browser subscription, but the OS
 * permission stays granted, which is byte-for-byte what a reinstall or a 410
 * leaves behind. Without this marker the next dashboard load would helpfully
 * re-subscribe and clear `revoked_at`, so off would not stay off.
 *
 * Per device, in localStorage, because that is exactly the scope of the
 * decision: it says nothing about the same person's other browsers.
 */
const PUSH_OPTED_OUT_KEY = "ncw_push_opted_out_v1";

function readPushOptedOut(): boolean {
  try {
    return window.localStorage.getItem(PUSH_OPTED_OUT_KEY) === "1";
  } catch {
    // Storage unavailable: treat as not opted out. The cost is one unwanted
    // re-subscribe on a browser that cannot remember anything; the opposite
    // default would silently disable push for everyone in private mode.
    return false;
  }
}

export function writePushOptedOut(value: boolean): void {
  try {
    if (value) window.localStorage.setItem(PUSH_OPTED_OUT_KEY, "1");
    else window.localStorage.removeItem(PUSH_OPTED_OUT_KEY);
  } catch {
    // Nothing to do; the in-page state already reflects the choice.
  }
}

/** Fired after a silent re-create so any mounted card re-reads its state. */
export const PUSH_SUBSCRIBED_EVENT = "ncw:push-subscribed";


/**
 * Keeps an already-opted-in browser's push subscription alive. Renders
 * nothing.
 *
 * Mounted on every dashboard load, next to HipaaIdleLogout, and it does
 * exactly three things:
 *
 *  1. Registers the service worker, so `push` and `pushsubscriptionchange`
 *     have somewhere to land.
 *  2. Recovers from a VAPID key rotation. `pushManager.subscribe()` with the
 *     SAME key returns the existing subscription, but with a DIFFERENT key it
 *     throws InvalidStateError. That makes one call both the refresh and the
 *     mismatch detector, with no byte comparison: on the throw we drop the
 *     stale subscription and take a new one. This is the recovery path that
 *     makes a 403 from the push service survivable without asking every owner
 *     to re-install, and it only works because the public key is served from
 *     /api/push/vapid-key rather than baked into the bundle.
 *  3. Re-POSTs the subscription, which bumps `last_seen_at` (the staleness
 *     floor reads it) and clears any stale `revoked_at`.
 *
 * It never asks for permission. Permission requires a user gesture on iOS and
 * an unprompted request is penalised by Chrome, so the ask lives behind a
 * button in PushSetupCard. A browser that has not opted in exits at the
 * `getSubscription()` check having done nothing but register the worker.
 */
export function PushRegistrar({ businessId }: { businessId: string | null }) {
  useEffect(() => {
    let cancelled = false;

    async function sync() {
      if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
      try {
        const registration = await navigator.serviceWorker.register("/sw.js");
        if (cancelled) return;
        if (!("pushManager" in registration)) return;

        const existing = await registration.pushManager.getSubscription();
        /**
         * No subscription on this browser. If permission was never granted,
         * registering the worker is all that is wanted: asking needs a user
         * gesture, so PushSetupCard drives that.
         *
         * A GRANTED permission with no subscription is a different case, and
         * it used to be handled identically, which sent someone who had
         * already said yes back to tap the same button for nothing. It happens
         * whenever the subscription is lost while the grant survives:
         * reinstalling the app, clearing site data, signing in on a second
         * device, or a send discovering a 410 and revoking the row.
         * `subscribe()` needs no gesture once permission exists, so the right
         * answer is to re-create it silently.
         */
        const permission =
          typeof Notification === "undefined" ? "default" : Notification.permission;
        // An explicit "Turn off on this device" must stay off. It leaves the
        // permission granted and no subscription, which is indistinguishable
        // from a lost one, so the marker is the only thing that separates
        // "recover this" from "they said no".
        if (!existing && (permission !== "granted" || readPushOptedOut())) return;
        if (cancelled) return;

        const res = await fetch("/api/push/vapid-key");
        if (!res.ok || cancelled) return;
        const key = (await res.json())?.data?.publicKey;
        if (typeof key !== "string" || key.length === 0 || cancelled) return;

        const applicationServerKey = urlBase64ToUint8Array(key);
        let subscription: PushSubscription;
        try {
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey
          });
        } catch (err) {
          /**
           * ONLY a key mismatch may discard a working subscription.
           *
           * `subscribe()` with the same applicationServerKey returns the
           * existing subscription; with a DIFFERENT one it throws
           * InvalidStateError, which is the rotation signal. Every other
           * throw here is transient (offline, a permission race, a push
           * service hiccup), and unsubscribing on those would destroy a
           * perfectly live subscription the owner already granted. They would
           * then receive nothing until they noticed and opted in again, and
           * the next send would 410-revoke the stored row on the way past.
           */
          // Nothing to drop and retry when there was no subscription to begin
          // with: that is the silent re-create path above, so a failure there
          // is just a failure.
          if (!existing) throw err;
          if ((err as { name?: string } | null)?.name !== "InvalidStateError") throw err;
          await existing.unsubscribe();
          subscription = await registration.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey
          });
        }
        if (cancelled) return;

        await fetch("/api/push/subscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ businessId, subscription: subscription.toJSON() })
        });

        // A card mounted before this finished is still showing "Turn on
        // alerts" for a device that is now subscribed, so tell it to re-read.
        if (!existing) window.dispatchEvent(new Event(PUSH_SUBSCRIBED_EVENT));
      } catch {
        // Best effort by design. A browser that refuses service workers
        // (private mode, an enterprise policy) must not break the dashboard,
        // and there is nothing useful to tell the owner here: the setup card
        // reports the same state where they can act on it.
      }
    }

    void sync();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  return null;
}

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import {
  installCoachState,
  shouldOfferPushBanner,
  type InstallCoachState
} from "@/lib/push/install";
import { urlBase64ToUint8Array } from "@/lib/push/vapid";

/**
 * The push opt-in surface.
 *
 * Every decision about WHAT to show lives in `installCoachState`, a pure
 * function under the lib coverage gate. This component only reads browser
 * globals, hands them over, and renders the answer, which is the same split
 * HipaaIdleLogout uses against src/lib/hipaa/session-timeout.ts.
 */
export function PushSetupCard({
  businessId,
  variant = "card",
  onDismiss
}: {
  businessId: string | null;
  /**
   * "card" is the settings surface: it explains every state, including the
   * ones nobody can act on from here, because someone who went looking
   * deserves the whole picture. "banner" interrupts, so it renders only the
   * actionable states and carries a dismiss.
   */
  variant?: "card" | "banner";
  onDismiss?: () => void;
}) {
  const [state, setState] = useState<InstallCoachState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * Prefetched on mount so the click handler needs no network round trip.
   * Safari drops the user activation across an await, and losing it means
   * `requestPermission()` silently resolves to "denied" forever after.
   */
  const vapidKey = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return;

    const hasPushManager = "PushManager" in window;
    const permission = "Notification" in window ? Notification.permission : "denied";
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;

    let subscribed = false;
    if ("serviceWorker" in navigator) {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        subscribed = Boolean(await registration?.pushManager?.getSubscription());
      } catch {
        subscribed = false;
      }
    }

    setState(
      installCoachState({
        userAgent: navigator.userAgent,
        maxTouchPoints: navigator.maxTouchPoints,
        standalone,
        hasPushManager,
        permission: permission as "default" | "granted" | "denied",
        subscribed
      })
    );
  }, []);

  useEffect(() => {
    void refresh();
    void fetch("/api/push/vapid-key")
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        const key = j?.data?.publicKey;
        if (typeof key === "string") vapidKey.current = key;
      })
      .catch(() => {
        // The click handler re-fetches as a cold fallback.
      });
  }, [refresh]);

  async function enable() {
    setError(null);
    // FIRST, with nothing awaited before it. On Safari the user activation
    // does not survive an await, and a request made without activation is
    // rejected outright rather than shown.
    const permission = await Notification.requestPermission();
    setBusy(true);
    try {
      if (permission !== "granted") {
        await refresh();
        return;
      }
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;

      const key = vapidKey.current ?? (await (await fetch("/api/push/vapid-key")).json())?.data?.publicKey;
      if (typeof key !== "string" || key.length === 0) {
        setError("Push is not configured on this server yet.");
        return;
      }

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(key)
      });

      const res = await fetch("/api/push/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, subscription: subscription.toJSON() })
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(body?.error?.message ?? "Could not turn on notifications.");
        await subscription.unsubscribe();
        return;
      }
      await refresh();
    } catch {
      setError("Could not turn on notifications on this device.");
    } finally {
      setBusy(false);
    }
  }

  async function disable() {
    setBusy(true);
    setError(null);
    try {
      const registration = await navigator.serviceWorker.getRegistration();
      const subscription = await registration?.pushManager?.getSubscription();
      if (subscription) {
        await fetch("/api/push/unsubscribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ endpoint: subscription.endpoint })
        });
        await subscription.unsubscribe();
      }
      await refresh();
    } catch {
      setError("Could not turn off notifications on this device.");
    } finally {
      setBusy(false);
    }
  }

  // Nothing is rendered until the browser has been read, so the card never
  // flashes the wrong advice on first paint.
  if (state === null) return null;

  if (variant === "banner") {
    // The banner never renders a state it cannot resolve; see
    // shouldOfferPushBanner for which those are and why.
    if (!shouldOfferPushBanner(state)) return null;
    return (
      <div className="rounded-lg border border-signal-teal/30 bg-signal-teal/5 px-4 py-3 flex flex-wrap items-start gap-3">
        <div className="flex-1 min-w-[16rem]">
          <p className="text-sm font-medium text-parchment">
            {state === "prompt"
              ? "Get urgent alerts on this device"
              : "Add New Coworker to your Home Screen for alerts"}
          </p>
          <p className="text-xs text-parchment/60 mt-1">
            {state === "prompt"
              ? "One tap. Alerts arrive even when the dashboard is closed."
              : "iPhone and iPad only deliver alerts to apps on the Home Screen: Share, then Add to Home Screen, then open it from there."}
          </p>
          {error && (
            <p className="text-xs text-spark-orange mt-1" role="alert">
              {error}
            </p>
          )}
        </div>
        <div className="flex items-center gap-2">
          {state === "prompt" && (
            <Button type="button" size="sm" onClick={enable} loading={busy}>
              Turn on alerts
            </Button>
          )}
          <Button type="button" size="sm" variant="ghost" onClick={onDismiss}>
            Not now
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {state === "enabled" && (
        <>
          <p className="text-sm text-parchment">
            Alerts are on for this device. You will get them even when the dashboard is closed.
          </p>
          <Button type="button" variant="ghost" onClick={disable} loading={busy}>
            Turn off on this device
          </Button>
        </>
      )}

      {state === "prompt" && (
        <>
          <p className="text-sm text-parchment/70">
            Get urgent alerts on this device as soon as they happen, without keeping the dashboard
            open.
          </p>
          <Button type="button" onClick={enable} loading={busy}>
            Turn on alerts
          </Button>
        </>
      )}

      {/*
        iOS delivers push ONLY to a web app on the Home Screen, and Apple gives
        no programmatic install prompt, so there is nothing to put behind a
        button here. The steps name the real controls, and the last line is the
        one that matters: owners routinely install, come back to this Safari
        tab, tap the button, and cannot understand why nothing happens.
      */}
      {state === "needs_ios_install" && (
        <div className="rounded-lg border border-signal-teal/30 bg-signal-teal/5 px-4 py-3">
          <p className="text-sm font-medium text-parchment">Add New Coworker to your Home Screen</p>
          <p className="text-xs text-parchment/60 mt-1">
            iPhone and iPad only deliver alerts to apps on the Home Screen.
          </p>
          <ol className="text-xs text-parchment/70 mt-2 space-y-1 list-decimal list-inside">
            <li>Tap the Share button in Safari.</li>
            <li>Choose Add to Home Screen.</li>
            <li>Open New Coworker from your Home Screen.</li>
          </ol>
          <p className="text-xs text-parchment/60 mt-2">
            Then come back to this page <strong className="text-parchment/80">in the installed
            app</strong> and turn alerts on there. This Safari tab cannot do it.
          </p>
        </div>
      )}

      {state === "needs_browser" && (
        <p className="text-sm text-parchment/70">
          Open this page in your normal browser (Safari or Chrome) to turn on alerts. In-app
          browsers cannot receive them.
        </p>
      )}

      {/*
        No retry button: once permission is denied, requestPermission()
        resolves to "denied" instantly and forever without showing anything,
        so a button here would look broken every time it was pressed.
      */}
      {state === "blocked" && (
        <p className="text-sm text-parchment/70">
          Notifications are blocked for this site. Turn them back on in your browser settings for
          this site, then reload this page.
        </p>
      )}

      {state === "unsupported" && (
        <p className="text-sm text-parchment/60">
          This browser cannot receive push notifications. Alerts still arrive by text and email.
        </p>
      )}

      {error && (
        <p className="text-xs text-spark-orange" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

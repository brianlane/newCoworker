"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  HIPAA_IDLE_TIMEOUT_MS,
  SESSION_TIMEOUT_ERROR,
  idleState,
  secondsUntilLogout
} from "@/lib/hipaa/session-timeout";
import { clearConfidentialBrowserStorage } from "@/lib/auth/clear-confidential-storage";

/**
 * Automatic logoff for a HIPAA tenant (45 CFR 164.312(a)(2)(iii)).
 *
 * Rendered by the dashboard layout ONLY when the active business has
 * hipaa_mode on, so no other tenant is ever timed out. The policy itself
 * (window, warning lead, phase calculation) lives in
 * src/lib/hipaa/session-timeout.ts, which is pure and unit-tested; this file
 * is the DOM plumbing around it.
 *
 * Signing out reuses the platform's canonical path rather than calling
 * supabase.auth.signOut() here: POSTing to /api/auth/signout revokes the
 * session server-side, clears the admin view-as cookie, and knows to send an
 * admin to /admin/login. Rolling a second sign-out would have quietly skipped
 * those. `reason` tells the login page why, and the route whitelists it.
 */
export function HipaaIdleLogout({ timeoutMs = HIPAA_IDLE_TIMEOUT_MS }: { timeoutMs?: number }) {
  const t = useTranslations("dashboard.idleLogout");
  const formRef = useRef<HTMLFormElement | null>(null);
  const lastActivityRef = useRef<number>(0);
  const signingOutRef = useRef(false);
  const [warning, setWarning] = useState<number | null>(null);

  useEffect(() => {
    // Seeded here, not in the component body: Date.now() during render is
    // impure and React's lint rules reject it.
    lastActivityRef.current = Date.now();

    const expire = () => {
      // Guard against a second trigger while the navigation is in flight.
      if (signingOutRef.current) return;
      signingOutRef.current = true;
      clearConfidentialBrowserStorage();
      formRef.current?.requestSubmit();
    };

    /**
     * Activity only counts while the session is still alive. Checking expiry
     * FIRST is what stops a returning tab from reviving a session that should
     * already be gone: browsers throttle and often suspend timers in a hidden
     * tab, so the interval below may never have fired past the deadline, and
     * an unconditional "mark active" on focus would silently reset the clock
     * in exactly the unattended-dashboard case this control exists for.
     */
    const handleActivity = () => {
      const now = Date.now();
      if (idleState(lastActivityRef.current, now, timeoutMs) === "expired") {
        expire();
        return;
      }
      lastActivityRef.current = now;
      setWarning((prev) => (prev === null ? prev : null));
    };

    // pointermove is included because the warning tells the reader to move the
    // mouse; without it, following the instruction would not save the session.
    const events = ["pointerdown", "pointermove", "keydown", "focus"] as const;
    for (const evt of events) window.addEventListener(evt, handleActivity, { passive: true });
    // Scroll needs CAPTURE: the dashboard's content lives in a
    // `[data-app-main]` overflow container, and scroll does not bubble to
    // window, so a reader scrolling a long thread would otherwise look idle.
    window.addEventListener("scroll", handleActivity, { passive: true, capture: true });
    const onVisible = () => {
      if (document.visibilityState === "visible") handleActivity();
    };
    document.addEventListener("visibilitychange", onVisible);

    const tick = setInterval(() => {
      const now = Date.now();
      const state = idleState(lastActivityRef.current, now, timeoutMs);
      if (state === "expired") {
        expire();
        return;
      }
      setWarning(
        state === "warning" ? secondsUntilLogout(lastActivityRef.current, now, timeoutMs) : null
      );
    }, 1000);

    return () => {
      for (const evt of events) window.removeEventListener(evt, handleActivity);
      window.removeEventListener("scroll", handleActivity, { capture: true });
      document.removeEventListener("visibilitychange", onVisible);
      clearInterval(tick);
    };
  }, [timeoutMs]);

  return (
    <>
      {/* Submitted by the timer above; never shown. A real form POST is also
          what keeps this working without client-side navigation. */}
      <form ref={formRef} action="/api/auth/signout" method="POST" className="hidden">
        <input type="hidden" name="reason" value={SESSION_TIMEOUT_ERROR} />
      </form>
      {warning !== null && (
        <div
          role="alertdialog"
          aria-live="assertive"
          className="fixed inset-x-0 bottom-4 z-50 mx-auto w-[min(28rem,calc(100%-2rem))] rounded-lg border border-spark-orange/40 bg-deep-ink px-4 py-3 shadow-lg shadow-black/50"
        >
          <p className="text-sm text-parchment">{t("title")}</p>
          <p className="mt-1 text-xs text-parchment/60">{t("body", { seconds: warning })}</p>
        </div>
      )}
    </>
  );
}

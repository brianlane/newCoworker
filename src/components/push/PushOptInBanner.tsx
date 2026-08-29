"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { PushSetupCard } from "@/components/push/PushSetupCard";

/**
 * Versioned so a future change to what the banner says can ask again. Bumping
 * the suffix re-shows it to everyone who dismissed the previous wording; the
 * old key is simply orphaned.
 */
const DISMISS_KEY = "ncw_push_banner_dismissed_v1";

/**
 * The dashboard nudge for turning push on.
 *
 * The opt-in also lives permanently on the notifications settings page, which
 * is where someone goes when they are LOOKING for it. This exists for the
 * larger group who never go looking, because nobody visits a settings page to
 * enable a feature they do not know exists.
 *
 * IT ASKS ONCE. Any decision ends it: turning alerts on flips the state to
 * `enabled`, which stops satisfying `shouldOfferPushBanner`, and "Not now"
 * writes the dismissal below. A nudge that reappears after being answered is
 * not a nudge, it is nagging, and the reliable outcome of nagging is that
 * people learn to dismiss our banners without reading them.
 *
 * The dismissal is per DEVICE (localStorage), which matches what is being
 * decided: push permission is granted per device, so declining on a phone
 * says nothing about a laptop that has never been asked.
 */
export function PushOptInBanner({ businessId }: { businessId: string | null }) {
  const pathname = usePathname();
  // Starts hidden and is revealed after the read, so a dismissed banner never
  // flashes on first paint.
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    // One-shot post-mount sync from external storage (the documented
    // exception, same as TasksWorkspace): reading localStorage during render
    // would desync the SSR markup from the first client paint.
    try {
      const stored = window.localStorage.getItem(DISMISS_KEY) === "1";
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(stored);
    } catch {
      // Private mode, or storage disabled by policy. Showing the banner is the
      // right failure: it stays dismissable for this session, and the worst
      // case is being asked again on a browser that cannot remember anything.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setDismissed(false);
    }
  }, []);

  if (dismissed) return null;

  /**
   * Never on the notifications page, where the permanent opt-in card already
   * lives. Two independent copies of the same control mount there with
   * separate state, so acting on one leaves the other stale: the page would
   * show "Alerts are on" and "Turn on alerts" at the same time until a
   * remount. Suppressing the banner there fixes that by removing the
   * duplicate rather than syncing it, which is also the better answer on its
   * own terms: this exists to reach people who never open settings, and it
   * has nothing to tell someone already standing in them.
   */
  if (pathname?.startsWith("/dashboard/notifications")) return null;

  return (
    <PushSetupCard
      businessId={businessId}
      variant="banner"
      onDismiss={() => {
        setDismissed(true);
        try {
          window.localStorage.setItem(DISMISS_KEY, "1");
        } catch {
          // Hidden for this session either way; nothing else to do.
        }
      }}
    />
  );
}

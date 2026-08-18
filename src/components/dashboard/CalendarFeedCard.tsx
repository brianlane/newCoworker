"use client";

/**
 * The subscribable calendar link, on the Bookings page for EVERY tenant.
 *
 * This is deliberately provider-agnostic: it renders for Vagaro and Acuity
 * businesses too (whose native booking page is disabled), because they are
 * exactly the tenants the shared NewCoworker calendar cannot always reach,
 * it needs a Google or Microsoft account to live on, and a feed URL does
 * not. Any calendar app that can subscribe to a URL works.
 *
 * Rotation revokes every previously shared copy at once, which is the whole
 * recovery story for a leaked link.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

const inputClass =
  "w-full rounded-md bg-ink-black/40 border border-parchment/15 px-3 py-2 text-sm " +
  "text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-signal-teal/60";

export function CalendarFeedCard({ businessId }: { businessId: string }) {
  const t = useTranslations("dashboard.bookings");
  const [feedUrl, setFeedUrl] = useState<string | null>(null);
  const [error, setError] = useState(false);
  /** Copy/rotate failures: shown as a line UNDER the URL, never replacing
   * it. A denied clipboard must not make a fetched link disappear. */
  const [actionError, setActionError] = useState(false);
  const [copied, setCopied] = useState(false);
  const [rotating, setRotating] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Reset before fetching: a multi-business owner switching businesses
    // must never be shown (and copy, or rotate) the PREVIOUS business's
    // link while the new one loads.
    setFeedUrl(null);
    setError(false);
    setActionError(false);
    (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/calendar-feed?businessId=${encodeURIComponent(businessId)}`
        );
        const json = (await res.json()) as { data?: { feedUrl?: string } };
        if (cancelled) return;
        if (!res.ok || !json.data?.feedUrl) {
          setError(true);
          return;
        }
        setFeedUrl(json.data.feedUrl);
      } catch {
        if (!cancelled) setError(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  async function copy() {
    if (!feedUrl) return;
    setActionError(false);
    try {
      await navigator.clipboard.writeText(feedUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard denied: the URL stays visible and selectable above.
      setActionError(true);
    }
  }

  async function rotate() {
    setRotating(true);
    setActionError(false);
    try {
      const res = await fetch("/api/dashboard/calendar-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as { data?: { feedUrl?: string } };
      if (res.ok && json.data?.feedUrl) {
        setFeedUrl(json.data.feedUrl);
      } else {
        setActionError(true);
      }
    } catch {
      setActionError(true);
    } finally {
      setRotating(false);
    }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-parchment">{t("feedTitle")}</h3>
      <p className="text-xs text-parchment/50 mt-1">{t("feedBenefit")}</p>
      {error ? (
        <p className="text-xs text-spark-orange mt-3">{t("feedError")}</p>
      ) : feedUrl ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input readOnly value={feedUrl} className={inputClass} />
            <Button type="button" variant="secondary" size="sm" onClick={copy}>
              {copied ? t("feedCopied") : t("feedCopy")}
            </Button>
          </div>
          {actionError ? (
            <p className="text-xs text-spark-orange">{t("feedActionError")}</p>
          ) : null}
          <div className="flex items-center justify-between">
            <p className="text-[11px] text-parchment/40">{t("feedHint")}</p>
            <Button type="button" variant="ghost" size="sm" onClick={rotate} loading={rotating}>
              {t("feedRotate")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-parchment/40 mt-3">{t("feedLoading")}</p>
      )}
    </Card>
  );
}

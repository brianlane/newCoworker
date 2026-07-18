"use client";

/**
 * Email campaigns manager (Dashboard → Marketing).
 *
 * Compose a campaign (subject + body + audience tag), leave it as a draft
 * or schedule it, and watch the send counters fill in as the per-minute
 * sweep drains the audience. The audience field offers the directory's
 * existing tags and previews the live recipient count (debounced through
 * /api/dashboard/campaigns/audience) so scheduling is never a blind send —
 * including a warning when the audience holds Instagram prospects still
 * pending review. The content calendar below groups scheduled and sent
 * campaigns by month so the marketing plan reads at a glance.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type CampaignItem = {
  id: string;
  subject: string;
  body_md: string;
  audience_tag: string;
  status: "draft" | "scheduled" | "sending" | "sent" | "cancelled";
  send_at: string | null;
  completed_at: string | null;
  recipients_total: number;
  recipients_sent: number;
  recipients_failed: number;
  recipients_skipped: number;
  created_at: string;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

const STATUS_BADGES: Record<CampaignItem["status"], { text: string; tone: string }> = {
  draft: { text: "Draft", tone: "text-parchment/60 border-parchment/20" },
  scheduled: { text: "Scheduled", tone: "text-signal-teal border-signal-teal/40" },
  sending: { text: "Sending…", tone: "text-amber-300 border-amber-300/40" },
  sent: { text: "Sent", tone: "text-claw-green border-claw-green/40" },
  cancelled: { text: "Cancelled", tone: "text-parchment/40 border-parchment/15" }
};

/** "2026-08" → "August 2026" for the calendar grouping. */
function monthLabel(iso: string): string {
  return new Date(`${iso.slice(0, 7)}-01T00:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
    timeZone: "UTC"
  });
}

type AudiencePreview = {
  recipients: number;
  needsReview: number;
  clipped: boolean;
  tags: string[];
};

/**
 * A non-email item on the unified content calendar (e.g. a scheduled
 * Instagram post), server-fetched by the Marketing page.
 */
export type CalendarExtraItem = {
  id: string;
  /** Short display label (a caption snippet, a subject line). */
  label: string;
  /** The anchor instant (publish/send time). */
  at: string;
  /** Badge text ("Scheduled", "Published", …). */
  statusText: string;
  /** Channel marker rendered beside the label. */
  channel: string;
};

export function CampaignsManager({
  businessId,
  calendarExtras = []
}: {
  businessId: string;
  calendarExtras?: CalendarExtraItem[];
}) {
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer.
  const [subject, setSubject] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [audienceTag, setAudienceTag] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<AudiencePreview | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/dashboard/campaigns?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as { ok: boolean; data?: { campaigns?: CampaignItem[] } };
      if (json.ok && json.data?.campaigns) setCampaigns(json.data.campaigns);
    } catch {
      /* keep the last list */
    } finally {
      setLoading(false);
    }
  }, [businessId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Debounced live audience preview: re-count as the owner edits the tag.
  // Best-effort — a failed preview keeps the last count rather than blocking
  // the composer (the sweep re-snapshots authoritatively at send time). The
  // cleanup flag drops out-of-order responses: a slow response for an OLD
  // tag must never overwrite the preview for the tag currently typed.
  useEffect(() => {
    let stale = false;
    const handle = setTimeout(() => {
      void (async () => {
        try {
          const res = await fetch(
            `/api/dashboard/campaigns/audience?businessId=${encodeURIComponent(businessId)}&tag=${encodeURIComponent(audienceTag.trim())}`,
            { cache: "no-store" }
          );
          const json = (await res.json()) as { ok: boolean; data?: AudiencePreview };
          if (!stale && json.ok && json.data) setPreview(json.data);
        } catch {
          /* keep the last preview */
        }
      })();
    }, 400);
    return () => {
      stale = true;
      clearTimeout(handle);
    };
  }, [businessId, audienceTag]);

  async function create(asDraft: boolean) {
    if (!subject.trim() || !bodyMd.trim()) {
      setError("Give the campaign a subject and a body.");
      return;
    }
    if (!asDraft && !sendAt) {
      setError("Pick a send time (or save as a draft).");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/dashboard/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          subject: subject.trim(),
          bodyMd: bodyMd.trim(),
          ...(audienceTag.trim() ? { audienceTag: audienceTag.trim() } : {}),
          ...(!asDraft && sendAt ? { sendAt: new Date(sendAt).toISOString() } : {})
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not save the campaign");
        return;
      }
      setSubject("");
      setBodyMd("");
      setAudienceTag("");
      setSendAt("");
      await refresh();
    } catch {
      setError("Could not save the campaign — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function cancel(campaignId: string) {
    try {
      const res = await fetch(`/api/dashboard/campaigns/${campaignId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, action: "cancel" })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) setError(json.error?.message ?? "Could not cancel");
      await refresh();
    } catch {
      setError("Could not cancel — try again.");
    }
  }

  async function remove(campaignId: string) {
    if (!window.confirm("Delete this campaign?")) return;
    try {
      const res = await fetch(
        `/api/dashboard/campaigns/${campaignId}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) setError(json.error?.message ?? "Could not delete");
      await refresh();
    } catch {
      setError("Could not delete — try again.");
    }
  }

  // Content calendar: scheduled + sent campaigns and any extra channel
  // items (Instagram posts) merged into one monthly view. Rows normalize
  // to { at, label, statusText, channel } so both render identically.
  type CalendarRow = { id: string; at: string; label: string; statusText: string; tone: string; channel: string };
  const calendar = new Map<string, CalendarRow[]>();
  const pushRow = (row: CalendarRow) => {
    const key = row.at.slice(0, 7);
    calendar.set(key, [...(calendar.get(key) ?? []), row]);
  };
  for (const c of campaigns) {
    const anchor = c.send_at ?? c.completed_at;
    if (!anchor || (c.status !== "scheduled" && c.status !== "sending" && c.status !== "sent")) {
      continue;
    }
    pushRow({
      id: c.id,
      at: anchor,
      label: c.subject,
      statusText: STATUS_BADGES[c.status].text,
      tone: STATUS_BADGES[c.status].tone,
      channel: "Email"
    });
  }
  for (const x of calendarExtras) {
    pushRow({
      id: x.id,
      at: x.at,
      label: x.label,
      statusText: x.statusText,
      tone: "text-signal-teal border-signal-teal/40",
      channel: x.channel
    });
  }
  const calendarMonths = [...calendar.keys()].sort();

  return (
    <div className="space-y-4">
      <Card>
        <h2 className="text-sm font-semibold text-parchment">New campaign</h2>
        <div className="mt-3 space-y-3">
          <div>
            <label className={labelClass}>Subject</label>
            <input
              className={inputClass}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Spring check-up special"
              maxLength={300}
            />
          </div>
          <div>
            <label className={labelClass}>Body (plain text / markdown paragraphs)</label>
            <textarea
              className={`${inputClass} min-h-32`}
              value={bodyMd}
              onChange={(e) => setBodyMd(e.target.value)}
              placeholder={"Hi!\n\nWe're offering…"}
              maxLength={8000}
            />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label className={labelClass}>
                Audience tag (blank = every contact with an email)
              </label>
              <input
                className={inputClass}
                value={audienceTag}
                onChange={(e) => setAudienceTag(e.target.value)}
                placeholder="vip"
                maxLength={40}
                list="campaign-audience-tags"
              />
              <datalist id="campaign-audience-tags">
                {(preview?.tags ?? []).map((t) => (
                  <option key={t} value={t} />
                ))}
              </datalist>
              {preview ? (
                <p className="mt-1 text-[11px] text-parchment/50">
                  Reaches{" "}
                  <span className="text-parchment/80">
                    {preview.clipped ? "at least " : ""}
                    {preview.recipients.toLocaleString()}
                  </span>{" "}
                  contact{preview.recipients === 1 ? "" : "s"} right now
                  {preview.needsReview > 0 ? (
                    <span className="text-spark-orange">
                      {" "}
                      — includes {preview.needsReview} Instagram prospect
                      {preview.needsReview === 1 ? "" : "s"} pending review (scraped, never
                      opted in — review them before emailing)
                    </span>
                  ) : null}
                </p>
              ) : null}
            </div>
            <div>
              <label className={labelClass}>Send at</label>
              <input
                type="datetime-local"
                className={inputClass}
                value={sendAt}
                onChange={(e) => setSendAt(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="primary" size="sm" loading={saving} onClick={() => void create(false)}>
              Schedule campaign
            </Button>
            <Button type="button" variant="secondary" size="sm" loading={saving} onClick={() => void create(true)}>
              Save as draft
            </Button>
          </div>
          {error && (
            <p className="text-xs text-spark-orange" role="alert">
              {error}
            </p>
          )}
          <p className="text-[11px] text-parchment/40">
            Sends go out from your AI mailbox in batches, only to customers who haven&apos;t
            unsubscribed from marketing. Replies go to your email. Want a text follow-up for
            the same audience? Build it as an{" "}
            <Link href="/dashboard/aiflows" className="text-signal-teal hover:underline">
              AiFlow
            </Link>{" "}
            — texts need each contact&apos;s SMS consent.
          </p>
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-3">Campaigns</h2>
        {loading ? (
          <p className="text-sm text-parchment/40">Loading…</p>
        ) : campaigns.length === 0 ? (
          <p className="text-sm text-parchment/40">No campaigns yet — compose one above.</p>
        ) : (
          <ul className="divide-y divide-parchment/10">
            {campaigns.map((c) => {
              const badge = STATUS_BADGES[c.status];
              return (
                <li key={c.id} className="py-2.5 flex flex-wrap items-center gap-2">
                  <span className="text-sm text-parchment/90">{c.subject}</span>
                  <span className={`rounded border px-1.5 py-0.5 text-[11px] ${badge.tone}`}>
                    {badge.text}
                  </span>
                  {c.audience_tag && (
                    <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                      #{c.audience_tag}
                    </span>
                  )}
                  {c.send_at && (
                    <span className="text-[11px] text-parchment/40">
                      {new Date(c.send_at).toLocaleString()}
                    </span>
                  )}
                  {(c.status === "sending" || c.status === "sent") && (
                    <span className="text-[11px] text-parchment/50">
                      {c.recipients_sent}/{c.recipients_total} sent
                      {c.recipients_failed > 0 ? ` · ${c.recipients_failed} failed` : ""}
                      {c.recipients_skipped > 0 ? ` · ${c.recipients_skipped} unsubscribed` : ""}
                    </span>
                  )}
                  <span className="ml-auto flex gap-2">
                    {(c.status === "draft" || c.status === "scheduled") && (
                      <button
                        type="button"
                        onClick={() => void cancel(c.id)}
                        className="text-[11px] text-parchment/50 hover:text-parchment"
                      >
                        Cancel
                      </button>
                    )}
                    {c.status !== "sending" && (
                      <button
                        type="button"
                        onClick={() => void remove(c.id)}
                        className="text-[11px] text-spark-orange/80 hover:text-spark-orange"
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {calendarMonths.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-parchment mb-1">Content calendar</h2>
          <p className="text-xs text-parchment/50 mb-3">
            What&apos;s going out (and what went out), month by month
          </p>
          <div className="space-y-3">
            {calendarMonths.map((month) => (
              <div key={month}>
                <p className="text-[11px] uppercase tracking-wide text-parchment/40 mb-1">
                  {monthLabel(month)}
                </p>
                <ul className="space-y-0.5">
                  {(calendar.get(month) ?? [])
                    .sort((a, b) => a.at.localeCompare(b.at))
                    .map((row) => (
                      <li key={row.id} className="flex items-center gap-2 text-xs">
                        <span className="text-parchment/40 w-14 shrink-0">
                          {row.at.slice(5, 10)}
                        </span>
                        <span className="rounded border border-parchment/15 px-1 py-0 text-[10px] uppercase tracking-wider text-parchment/45">
                          {row.channel}
                        </span>
                        <span className="truncate text-parchment/80">{row.label}</span>
                        <span className={`rounded border px-1 py-0 text-[10px] ${row.tone}`}>
                          {row.statusText}
                        </span>
                      </li>
                    ))}
                </ul>
              </div>
            ))}
          </div>
        </Card>
      )}
    </div>
  );
}

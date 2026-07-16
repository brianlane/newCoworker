"use client";

/**
 * Email campaigns manager (Dashboard → Marketing).
 *
 * Compose a campaign (subject + body + audience tag), leave it as a draft
 * or schedule it, and watch the send counters fill in as the per-minute
 * sweep drains the audience. The content calendar below groups scheduled
 * and sent campaigns by month so the marketing plan reads at a glance.
 */

import { useCallback, useEffect, useState } from "react";
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

export function CampaignsManager({ businessId }: { businessId: string }) {
  const [campaigns, setCampaigns] = useState<CampaignItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Composer.
  const [subject, setSubject] = useState("");
  const [bodyMd, setBodyMd] = useState("");
  const [audienceTag, setAudienceTag] = useState("");
  const [sendAt, setSendAt] = useState("");
  const [saving, setSaving] = useState(false);

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

  // Content calendar: scheduled + sent campaigns grouped by their month.
  const calendar = new Map<string, CampaignItem[]>();
  for (const c of campaigns) {
    const anchor = c.send_at ?? c.completed_at;
    if (!anchor || (c.status !== "scheduled" && c.status !== "sending" && c.status !== "sent")) {
      continue;
    }
    const key = anchor.slice(0, 7);
    calendar.set(key, [...(calendar.get(key) ?? []), c]);
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
              />
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
            unsubscribed from marketing. Replies go to your email.
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
                    .sort((a, b) => (a.send_at ?? "").localeCompare(b.send_at ?? ""))
                    .map((c) => (
                      <li key={c.id} className="flex items-center gap-2 text-xs">
                        <span className="text-parchment/40 w-14 shrink-0">
                          {(c.send_at ?? c.completed_at ?? "").slice(5, 10)}
                        </span>
                        <span className="text-parchment/80">{c.subject}</span>
                        <span className={`rounded border px-1 py-0 text-[10px] ${STATUS_BADGES[c.status].tone}`}>
                          {STATUS_BADGES[c.status].text}
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

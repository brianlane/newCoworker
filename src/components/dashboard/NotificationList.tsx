"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { ConversationScroll } from "@/components/dashboard/ConversationScroll";
import type { NotificationRow } from "@/lib/db/notifications";
import {
  notificationDetailFields,
  notificationEventLinks,
  notificationLink
} from "@/lib/notifications/display";

type Props = {
  businessId: string;
  initial: NotificationRow[];
};

function statusVariant(status: NotificationRow["status"]): React.ComponentProps<typeof Badge>["variant"] {
  if (status === "sent") return "success";
  if (status === "failed") return "error";
  if (status === "skipped") return "neutral";
  return "pending";
}

function describeKind(row: NotificationRow): string {
  switch (row.kind) {
    case "urgent_alert":
      return "Urgent alert";
    case "voice_capture":
      return "Voice capture";
    case "digest":
      return row.payload?.window === "weekly" ? "Weekly digest" : "Daily digest";
    default:
      return row.kind ?? "Notification";
  }
}

function describeReason(payload: Record<string, unknown>): string | null {
  const reason = payload?.reason;
  if (typeof reason !== "string" || reason.length === 0) return null;
  switch (reason) {
    case "unsubscribed":
      return "Skipped: you've unsubscribed from all alerts";
    case "no_email":
      return "Skipped: no email on file";
    case "no_phone":
      return "Skipped: no phone on file";
    case "email_urgent_disabled":
      return "Skipped: urgent email disabled";
    case "sms_urgent_disabled":
      return "Skipped: urgent SMS disabled";
    case "email_digest_disabled":
      return "Skipped: daily digest disabled";
    case "email_digest_weekly_disabled":
      return "Skipped: weekly digest disabled";
    case "dashboard_alerts_disabled":
      return "Skipped: dashboard alerts disabled";
    case "no_activity":
      return "Skipped: no activity in this digest window";
    case "resend_unconfigured":
      return "Skipped: email service not configured";
    case "telnyx_unconfigured":
      return "Skipped: SMS service not configured";
    default:
      return `Skipped: ${reason}`;
  }
}

export function NotificationList({ businessId, initial }: Props) {
  const [items, setItems] = useState<NotificationRow[]>(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const unreadCount = items.filter((it) => !it.read_at).length;

  async function markAll() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_all_read", businessId })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "Failed to mark all read");
        return;
      }
      const now = new Date().toISOString();
      setItems((prev) => prev.map((it) => (it.read_at ? it : { ...it, read_at: now })));
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  async function markOne(id: string) {
    setError(null);
    try {
      const res = await fetch("/api/notifications", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "mark_read", businessId, id })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "Failed to mark read");
        return;
      }
      const now = new Date().toISOString();
      setItems((prev) => prev.map((it) => (it.id === id ? { ...it, read_at: now } : it)));
    } catch {
      setError("Network error");
    }
  }

  async function deleteOne(id: string) {
    if (!window.confirm("Delete this notification?")) return;
    setError(null);
    try {
      const res = await fetch(
        `/api/notifications?businessId=${encodeURIComponent(businessId)}&id=${encodeURIComponent(id)}`,
        { method: "DELETE" }
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "Failed to delete");
        return;
      }
      setExpandedId((prev) => (prev === id ? null : prev));
      setItems((prev) => prev.filter((it) => it.id !== id));
    } catch {
      setError("Network error");
    }
  }

  if (items.length === 0) {
    return <p className="text-sm text-parchment/40">No notifications yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-parchment/45">
          {unreadCount > 0 ? `${unreadCount} unread` : "All caught up"}
        </p>
        {unreadCount > 0 && (
          <Button type="button" variant="secondary" onClick={markAll} loading={busy}>
            Mark all read
          </Button>
        )}
      </div>
      {/* Same bounded scroll window as the Emails page inbox list: the card
          stops growing with the notification count and the list scrolls in
          place. Newest-first, so no bottom anchoring. The unread header and
          the error line stay outside so they're always visible. */}
      <ConversationScroll maxHeightClass="max-h-[70vh]" className="pr-1">
      <ul className="divide-y divide-parchment/10">
        {items.map((n) => {
          const reason = describeReason((n.payload as Record<string, unknown>) ?? {});
          const isUnread = !n.read_at;
          const isExpanded = expandedId === n.id;
          const link = notificationLink(n);
          const detailFields = notificationDetailFields(n);
          const eventLinks = notificationEventLinks(n);
          return (
            <li
              key={n.id}
              className={["py-3 transition-colors", isUnread ? "" : "opacity-60"].join(" ")}
            >
              <button
                type="button"
                data-testid="notification-row"
                aria-expanded={isExpanded}
                onClick={() => {
                  setExpandedId(isExpanded ? null : n.id);
                  // Viewing the detail counts as reading it.
                  if (!isExpanded && isUnread) void markOne(n.id);
                }}
                className="flex w-full flex-wrap items-center justify-between gap-3 text-left cursor-pointer"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium text-parchment">
                      {n.summary ?? describeKind(n)}
                    </span>
                    {isUnread && (
                      <span
                        className="inline-block h-2 w-2 rounded-full bg-signal-teal"
                        aria-label="unread"
                      />
                    )}
                  </div>
                  <p className="text-xs text-parchment/45 mt-1">
                    {describeKind(n)} • {n.delivery_channel} •{" "}
                    {new Date(n.created_at).toLocaleString()}
                  </p>
                  {reason && <p className="text-xs text-parchment/35 mt-1 italic">{reason}</p>}
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={statusVariant(n.status)}>{n.status}</Badge>
                  <span className="text-xs text-parchment/40">{isExpanded ? "▾" : "▸"}</span>
                </div>
              </button>
              {isExpanded && (
                <div
                  data-testid="notification-detail"
                  className="mt-3 rounded-lg border border-parchment/10 bg-deep-ink/40 px-4 py-3 space-y-2"
                >
                  {detailFields.length === 0 && eventLinks.length === 0 && !link && (
                    <p className="text-xs text-parchment/40">No additional detail recorded.</p>
                  )}
                  {detailFields.map((f) => (
                    <p key={f.label} className="text-xs text-parchment/70">
                      <span className="font-medium text-parchment/50">{f.label}: </span>
                      {f.value}
                    </p>
                  ))}
                  {eventLinks.length > 0 && (
                    <div data-testid="notification-events" className="pt-1">
                      <p className="text-xs font-medium text-parchment/50">Events</p>
                      <ul className="mt-1 space-y-1">
                        {eventLinks.map((ev, i) => (
                          <li key={`${ev.href}-${i}`} className="text-xs">
                            <Link
                              href={ev.href}
                              className="text-signal-teal hover:underline"
                            >
                              {ev.label}
                            </Link>
                            {ev.at && (
                              <span className="ml-2 text-parchment/35">
                                {new Date(ev.at).toLocaleString()}
                              </span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {link && (
                    <Link
                      href={link.href}
                      className="inline-block text-xs font-medium text-signal-teal hover:underline"
                    >
                      {link.label} →
                    </Link>
                  )}
                  <div className="pt-1">
                    <button
                      type="button"
                      data-testid="notification-delete"
                      onClick={() => void deleteOne(n.id)}
                      className="text-xs font-medium text-spark-orange/80 hover:text-spark-orange cursor-pointer"
                    >
                      Delete
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      </ConversationScroll>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}

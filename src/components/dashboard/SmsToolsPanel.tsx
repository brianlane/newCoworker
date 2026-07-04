"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { SmsTemplateOption } from "./SmsComposeNew";

export type ScheduledSmsItem = {
  id: string;
  toE164: string;
  body: string;
  sendAt: string;
  status: string;
  error: string | null;
};

type Props = {
  businessId: string;
  templates: SmsTemplateOption[];
  scheduled: ScheduledSmsItem[];
};

/**
 * Scheduled texts + saved templates management (Standard/Enterprise perk),
 * rendered under the Text history list. Server component passes the initial
 * data; mutations go through the dashboard API routes and refresh the page.
 */
export function SmsToolsPanel({ businessId, templates, scheduled }: Props) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newBody, setNewBody] = useState("");
  const [creating, setCreating] = useState(false);

  async function cancelScheduled(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/messages/schedule/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message || `Could not cancel (${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyId(null);
    }
  }

  async function createTemplate() {
    if (!newName.trim() || !newBody.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const res = await fetch("/api/dashboard/messages/templates", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, name: newName.trim(), body: newBody.trim() })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message || `Could not save (${res.status}).`);
        return;
      }
      setNewName("");
      setNewBody("");
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setCreating(false);
    }
  }

  async function deleteTemplate(id: string) {
    setBusyId(id);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/messages/templates/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message || `Could not delete (${res.status}).`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setBusyId(null);
    }
  }

  const upcoming = scheduled.filter((s) => s.status === "pending");
  const recent = scheduled.filter((s) => s.status !== "pending").slice(0, 5);

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <div className="rounded-xl border border-parchment/15 bg-deep-ink/40 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-parchment">Scheduled texts</h2>
        {upcoming.length === 0 ? (
          <p className="text-xs text-parchment/40">
            Nothing queued. Use “Send later” in the composer to schedule a text.
          </p>
        ) : (
          <ul className="space-y-2">
            {upcoming.map((s) => (
              <li
                key={s.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-parchment/10 bg-deep-ink/60 p-2.5"
              >
                <div className="min-w-0">
                  <p className="text-xs font-mono text-parchment/70">{s.toE164}</p>
                  <p className="truncate text-sm text-parchment/90">{s.body}</p>
                  <p className="text-xs text-parchment/40">
                    {new Date(s.sendAt).toLocaleString()}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => void cancelScheduled(s.id)}
                  disabled={busyId === s.id}
                  className="shrink-0 text-xs text-red-300/80 transition-colors hover:text-red-300 disabled:opacity-50"
                >
                  {busyId === s.id ? "Canceling…" : "Cancel"}
                </button>
              </li>
            ))}
          </ul>
        )}
        {recent.length > 0 && (
          <div className="space-y-1 border-t border-parchment/10 pt-2">
            <p className="text-xs text-parchment/40">Recent</p>
            <ul className="space-y-1">
              {recent.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 text-xs">
                  <span className="truncate text-parchment/60">
                    {s.toE164} · {s.body}
                  </span>
                  <span
                    className={
                      s.status === "sent" ? "text-claw-green" : "text-red-300/80"
                    }
                  >
                    {s.status}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="rounded-xl border border-parchment/15 bg-deep-ink/40 p-4 space-y-3">
        <h2 className="text-sm font-semibold text-parchment">Saved templates</h2>
        {templates.length === 0 ? (
          <p className="text-xs text-parchment/40">
            No templates yet. Save the messages you type most.
          </p>
        ) : (
          <ul className="space-y-2">
            {templates.map((t) => (
              <li
                key={t.id}
                className="flex items-start justify-between gap-3 rounded-lg border border-parchment/10 bg-deep-ink/60 p-2.5"
              >
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-parchment/80">{t.name}</p>
                  <p className="truncate text-sm text-parchment/60">{t.body}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void deleteTemplate(t.id)}
                  disabled={busyId === t.id}
                  className="shrink-0 text-xs text-red-300/80 transition-colors hover:text-red-300 disabled:opacity-50"
                >
                  {busyId === t.id ? "Deleting…" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="space-y-2 border-t border-parchment/10 pt-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            maxLength={80}
            placeholder="Template name"
            disabled={creating}
            className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
          />
          <textarea
            value={newBody}
            onChange={(e) => setNewBody(e.target.value)}
            rows={2}
            maxLength={1600}
            placeholder="Template message (sent verbatim)"
            disabled={creating}
            className="w-full resize-none rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
          />
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void createTemplate()}
              disabled={!newName.trim() || !newBody.trim() || creating}
              className="rounded-lg bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-40"
            >
              {creating ? "Saving…" : "Save template"}
            </button>
          </div>
        </div>
      </div>
      {error && <p className="text-xs text-red-300 md:col-span-2">{error}</p>}
    </div>
  );
}

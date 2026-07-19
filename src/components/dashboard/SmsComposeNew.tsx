"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { normalizeContactNumber } from "@/lib/telnyx/format";
import { SmsSegmentHint } from "./SmsSegmentHint";

export type SmsTemplateOption = { id: string; name: string; body: string };

type Props = {
  businessId: string;
  /** True when this tenant's sends go RCS-first (softens the emoji hint). */
  rcsEnabled?: boolean;
  /** Saved templates for the picker (Standard+; empty/omitted hides it). */
  templates?: SmsTemplateOption[];
  /** True when the tenant may schedule sends (Standard+). */
  schedulingEnabled?: boolean;
};

/**
 * "New message" composer on the Text history index. Sends a brand-new SMS to
 * an arbitrary number via /api/dashboard/messages/send, then routes the owner
 * into the resulting thread (which now has at least one logged message).
 *
 * Standard+ tenants also get a template picker (fills the body verbatim) and
 * a "Send later" mode that queues via /api/dashboard/messages/schedule.
 */
export function SmsComposeNew({
  businessId,
  rcsEnabled = false,
  templates = [],
  schedulingEnabled = false
}: Props) {
  const t = useTranslations("dashboard.smsComposer");
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [to, setTo] = useState("");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [scheduleMode, setScheduleMode] = useState(false);
  const [sendAtLocal, setSendAtLocal] = useState("");
  // Per-message channel override for RCS-first tenants (immediate sends only —
  // the scheduled path has no override, so the toggle hides in schedule mode).
  const [forceSms, setForceSms] = useState(false);

  const textTrimmed = text.trim();
  // Normalize as the owner types so "(305) 613-3412" enables Send and we both
  // send and navigate using the canonical +13056133412 (the thread is keyed by
  // the normalized value, so navigating to the raw input would 404).
  const normalized = normalizeContactNumber(to);
  const toE164 = normalized.ok ? normalized.value : null;
  const scheduleReady = !scheduleMode || sendAtLocal.trim().length > 0;
  const canSend = Boolean(toE164) && textTrimmed.length > 0 && scheduleReady && !busy;

  function applyTemplate(id: string) {
    const tpl = templates.find((t) => t.id === id);
    if (tpl) setText(tpl.body);
  }

  async function send() {
    if (!canSend || !toE164) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      if (scheduleMode) {
        const sendAtMs = Date.parse(sendAtLocal);
        if (!Number.isFinite(sendAtMs)) {
          setError("Pick a valid send time.");
          return;
        }
        const res = await fetch("/api/dashboard/messages/schedule", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            toE164,
            text,
            sendAt: new Date(sendAtMs).toISOString()
          })
        });
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          error?: { message?: string };
        } | null;
        if (!res.ok || !json?.ok) {
          setError(json?.error?.message || `Could not schedule (${res.status}).`);
          return;
        }
        setNotice(`Scheduled for ${new Date(sendAtMs).toLocaleString()}.`);
        setText("");
        setSendAtLocal("");
        router.refresh();
        return;
      }
      const res = await fetch("/api/dashboard/messages/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          toE164,
          text,
          ...(rcsEnabled && forceSms ? { forceChannel: "sms" } : {})
        })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { logged?: boolean };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error?.message || `Could not send (${res.status}).`);
        return;
      }
      // The send succeeded but couldn't be saved to history (e.g. the
      // owner_manual migration isn't applied yet). Navigating to the thread
      // would 404 on an empty history, so stay put and tell the owner the
      // message went out without being recorded.
      if (json.data?.logged === false) {
        setError("Sent, but it couldn't be saved to history yet; it may not appear in the thread.");
        setText("");
        return;
      }
      setOpen(false);
      setText("");
      router.push(`/dashboard/messages/${encodeURIComponent(toE164)}`);
    } catch {
      setError("Network error; please try again.");
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => {
          setError(null);
          setNotice(null);
          setOpen(true);
        }}
        className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
      >
        New message
      </button>
    );
  }

  return (
    <div className="w-full space-y-2 rounded-xl border border-parchment/15 bg-deep-ink/40 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-parchment">New message</span>
        <button
          type="button"
          onClick={() => {
            setOpen(false);
            setError(null);
            setNotice(null);
          }}
          disabled={busy}
          className="text-xs text-parchment/50 transition-colors hover:text-parchment/80"
        >
          Cancel
        </button>
      </div>
      <input
        type="tel"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        placeholder="(305) 613-3412, +1…, or short code"
        disabled={busy}
        className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      {to.trim() && toE164 && toE164 !== to.trim() && (
        <p className="text-xs text-parchment/40">
          Sends to <span className="font-mono text-parchment/70">{toE164}</span>
        </p>
      )}
      {templates.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            if (e.target.value) applyTemplate(e.target.value);
          }}
          disabled={busy}
          className="w-full rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
        >
          <option value="">Insert a saved template…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={3}
        maxLength={1600}
        placeholder="Message (sent verbatim)"
        disabled={busy}
        className="w-full resize-none rounded-lg border border-parchment/15 bg-deep-ink/60 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
      />
      {rcsEnabled && !scheduleMode && (
        <label className="flex items-center gap-1.5 text-xs text-parchment/60">
          <input
            type="checkbox"
            checked={forceSms}
            onChange={(e) => setForceSms(e.target.checked)}
            disabled={busy}
            className="accent-claw-green"
          />
          {t("sendAsPlainSms")}
        </label>
      )}
      <SmsSegmentHint
        text={text}
        mode="verbatim"
        channel={rcsEnabled && !(forceSms && !scheduleMode) ? "rcs" : "sms"}
      />
      {schedulingEnabled && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-parchment/60">
            <input
              type="checkbox"
              checked={scheduleMode}
              onChange={(e) => setScheduleMode(e.target.checked)}
              disabled={busy}
              className="accent-claw-green"
            />
            Send later
          </label>
          {scheduleMode && (
            <input
              type="datetime-local"
              value={sendAtLocal}
              onChange={(e) => setSendAtLocal(e.target.value)}
              disabled={busy}
              className="rounded-lg border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment focus:border-claw-green/60 focus:outline-none disabled:opacity-50"
            />
          )}
        </div>
      )}
      {error && <p className="text-xs text-red-300">{error}</p>}
      {notice && <p className="text-xs text-claw-green">{notice}</p>}
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          className="rounded-lg bg-claw-green px-4 py-2 text-sm font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-40"
        >
          {busy ? (scheduleMode ? "Scheduling…" : "Sending…") : scheduleMode ? "Schedule" : "Send"}
        </button>
      </div>
    </div>
  );
}

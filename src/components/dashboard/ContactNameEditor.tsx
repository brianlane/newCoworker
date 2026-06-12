"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Props = {
  businessId: string;
  e164: string;
  /** Name currently shown for this number (derived or override), if any. */
  currentName: string | null;
  /**
   * Whether the shown name comes from a manual override row. "Remove" only
   * makes sense then — deleting an override under a derived name would
   * succeed yet visibly change nothing.
   */
  hasOverride: boolean;
};

/**
 * Inline "set contact name" control for an SMS thread. Saves an owner-set
 * override that wins over derived names (owner/employee/customer) — the
 * way to label a number the system can't identify (short-code lead sources
 * like ReferralExchange) or identifies wrongly.
 */
export function ContactNameEditor(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(props.currentName ?? "");
  const [busy, setBusy] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  async function call(method: "POST" | "DELETE", body: Record<string, string>) {
    setBusy(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/dashboard/contacts?businessId=${encodeURIComponent(props.businessId)}`,
        {
          method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      setOpen(false);
      router.refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-[10px] uppercase tracking-wide text-parchment/40 hover:text-parchment/80 border border-parchment/15 rounded px-1.5 py-0.5 transition-colors"
      >
        {props.currentName ? "Edit contact" : "Set contact"}
      </button>
    );
  }

  return (
    <span className="inline-flex items-center gap-2">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Contact name"
        maxLength={120}
        className="bg-deep-ink/60 border border-parchment/15 rounded px-2 py-1 text-xs text-parchment focus:outline-none focus:border-claw-green/60 w-40"
      />
      <button
        type="button"
        onClick={() => call("POST", { e164: props.e164, name: name.trim() })}
        disabled={busy || name.trim().length === 0}
        className="rounded bg-claw-green text-deep-ink px-2 py-1 text-xs font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      {props.hasOverride && (
        <button
          type="button"
          onClick={() => call("DELETE", { e164: props.e164 })}
          disabled={busy}
          className="rounded border border-parchment/20 text-parchment/60 px-2 py-1 text-xs hover:bg-parchment/5 transition-colors disabled:opacity-40"
        >
          Remove
        </button>
      )}
      <button
        type="button"
        onClick={() => {
          setOpen(false);
          setName(props.currentName ?? "");
          setErrorMsg(null);
        }}
        disabled={busy}
        className="text-xs text-parchment/50 hover:text-parchment/80 transition-colors"
      >
        Cancel
      </button>
      {errorMsg && <span className="text-xs text-red-300">{errorMsg}</span>}
    </span>
  );
}

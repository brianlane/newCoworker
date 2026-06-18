"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";

type Props = {
  businessId: string;
  customerE164: string;
  initialDisplayName: string | null;
  initialPinnedMd: string | null;
  initialEmail: string | null;
};

const PINNED_MAX = 2000;
const NAME_MAX = 120;
const EMAIL_MAX = 254;

export function CustomerProfileEditor(props: Props) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState(props.initialDisplayName ?? "");
  const [pinnedMd, setPinnedMd] = useState(props.initialPinnedMd ?? "");
  const [email, setEmail] = useState(props.initialEmail ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const dirty =
    (props.initialDisplayName ?? "") !== displayName ||
    (props.initialPinnedMd ?? "") !== pinnedMd ||
    (props.initialEmail ?? "") !== email;

  async function save() {
    setSaving(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(
          props.customerE164
        )}?businessId=${encodeURIComponent(props.businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            displayName: displayName.trim() === "" ? null : displayName.trim(),
            pinnedMd: pinnedMd.trim() === "" ? null : pinnedMd.trim(),
            email: email.trim() === "" ? null : email.trim()
          })
        }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      setStatusMsg("Saved.");
      // Re-render with the fresh values from the server so the
      // "dirty" indicator clears and any other client island sees the
      // update.
      router.refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    // Two-step confirmation so an accidental click doesn't nuke the
    // customer's rolling memory. The underlying SMS/voice history is
    // NOT touched by this delete — only the rollup row.
    const ok = window.confirm(
      "Delete this customer's rolling memory?\n\nThe customer's SMS and call history stays in the per-channel dashboards. Only the unified profile + pinned notes are removed. Your AI coworker will treat them as a new contact next time they reach out."
    );
    if (!ok) return;
    setDeleting(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(
          props.customerE164
        )}?businessId=${encodeURIComponent(props.businessId)}`,
        { method: "DELETE" }
      );
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      router.push("/dashboard/customers");
      router.refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setDeleting(false);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-3">Profile</h2>

      <label className="block text-xs text-parchment/70 mb-1">
        Display name
        <span className="ml-1 text-parchment/40">(optional)</span>
      </label>
      <input
        type="text"
        value={displayName}
        onChange={(e) => setDisplayName(e.target.value.slice(0, NAME_MAX))}
        placeholder="e.g. Joe at ACME"
        maxLength={NAME_MAX}
        className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
      />

      <label className="block text-xs text-parchment/70 mb-1 mt-4">
        Email
        <span className="ml-1 text-parchment/40">
          (optional — links their email so inbound/outbound mail rolls up here)
        </span>
      </label>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value.slice(0, EMAIL_MAX))}
        placeholder="joe@acme.com"
        maxLength={EMAIL_MAX}
        className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
      />

      <label className="block text-xs text-parchment/70 mb-1 mt-4">
        Pinned notes
        <span className="ml-1 text-parchment/40">
          ({pinnedMd.length}/{PINNED_MAX} chars; survives every summarizer
          regenerate)
        </span>
      </label>
      <textarea
        value={pinnedMd}
        onChange={(e) => setPinnedMd(e.target.value.slice(0, PINNED_MAX))}
        placeholder="VIP — escalate to owner on every call.&#10;Always greet by Mr. Smith.&#10;Do not upsell."
        rows={5}
        maxLength={PINNED_MAX}
        className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60 font-mono"
      />
      <p className="text-[10px] text-parchment/40 mt-1">
        Pinned notes are concatenated into every SMS, voice call, and
        dashboard chat preamble, BEFORE the auto-generated summary. Use
        for stable facts you want the AI to always know about this person.
      </p>

      <div className="flex items-center gap-3 mt-4">
        <button
          type="button"
          onClick={save}
          disabled={!dirty || saving || deleting}
          className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={saving || deleting}
          className="rounded-lg border border-red-400/40 text-red-300 px-4 py-2 text-sm hover:bg-red-400/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {deleting ? "Deleting…" : "Delete profile"}
        </button>
        {statusMsg && (
          <span className="text-xs text-claw-green/90">{statusMsg}</span>
        )}
        {errorMsg && (
          <span className="text-xs text-red-300">{errorMsg}</span>
        )}
      </div>
    </Card>
  );
}

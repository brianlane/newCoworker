"use client";

/**
 * Admin privacy / data-lifecycle console (security review G6).
 *
 * Two admin-only levers, both audit-logged to coworker_logs server-side:
 *   * Retention window — `businesses.data_retention_days` (min 30, blank =
 *     keep forever). The daily data-retention-sweep prunes content history
 *     older than the window; contacts are exempt.
 *   * End-user erasure — deletes one person's rows (by E.164 and/or email)
 *     across the content tables, central AND the tenant box for residency
 *     tenants. Unrecoverable; runs on a verified privacy request.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

const MIN_RETENTION_DAYS = 30;

export function PrivacyPanel({
  businessId,
  initialRetentionDays
}: {
  businessId: string;
  initialRetentionDays: number | null;
}) {
  const router = useRouter();

  // ── retention window ─────────────────────────────────────────────────
  const [retentionInput, setRetentionInput] = useState(
    initialRetentionDays === null ? "" : String(initialRetentionDays)
  );
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionMsg, setRetentionMsg] = useState<string | null>(null);
  const [retentionErr, setRetentionErr] = useState<string | null>(null);

  async function saveRetention() {
    const trimmed = retentionInput.trim();
    const days = trimmed === "" ? null : Number(trimmed);
    if (days !== null && (!Number.isInteger(days) || days < MIN_RETENTION_DAYS)) {
      setRetentionErr(`Enter a whole number of days (min ${MIN_RETENTION_DAYS}) or leave blank`);
      return;
    }
    setRetentionSaving(true);
    setRetentionErr(null);
    setRetentionMsg(null);
    try {
      const res = await fetch("/api/admin/data-retention", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, retentionDays: days })
      });
      const json = await res.json();
      if (!res.ok) {
        setRetentionErr(json.error?.message ?? "Update failed");
      } else {
        setRetentionMsg(json.data?.note ?? "Saved");
        router.refresh();
      }
    } catch {
      setRetentionErr("Network error");
    } finally {
      setRetentionSaving(false);
    }
  }

  // ── end-user erasure ─────────────────────────────────────────────────
  const [e164, setE164] = useState("");
  const [email, setEmail] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteMsg, setDeleteMsg] = useState<string | null>(null);
  const [deleteErr, setDeleteErr] = useState<string | null>(null);

  async function runDeletion() {
    setDeleting(true);
    setDeleteErr(null);
    setDeleteMsg(null);
    try {
      const res = await fetch("/api/admin/data-deletion", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          e164: e164.trim() || undefined,
          email: email.trim() || undefined,
          confirm: true
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setDeleteErr(json.error?.message ?? "Deletion failed");
      } else {
        const tables = (json.data?.tables ?? []) as Array<{
          table: string;
          central: number;
          box: number | null;
        }>;
        const total = tables.reduce((s, t) => s + t.central + (t.box ?? 0), 0);
        setDeleteMsg(
          `Deleted ${total} rows across ${tables.length} tables (audit fingerprint ${String(
            json.data?.identifierFingerprint ?? ""
          ).slice(0, 12)}…).`
        );
        setE164("");
        setEmail("");
      }
    } catch {
      setDeleteErr("Network error");
    } finally {
      setConfirming(false);
      setDeleting(false);
    }
  }

  const inputClass =
    "w-full rounded-lg border border-parchment/20 bg-transparent px-3 py-1.5 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h3 className="text-xs font-medium text-parchment/60">Content retention window</h3>
        <p className="text-xs text-parchment/50">
          Content history (messages, transcripts, email log) older than the window is pruned by
          the daily sweep — on the tenant box too for residency tenants. Contacts are never
          pruned. Blank = keep forever. Minimum {MIN_RETENTION_DAYS} days.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MIN_RETENTION_DAYS}
            placeholder="keep forever"
            value={retentionInput}
            onChange={(e) => {
              setRetentionInput(e.target.value);
              setRetentionMsg(null);
              setRetentionErr(null);
            }}
            className={`${inputClass} max-w-[10rem]`}
          />
          <span className="text-xs text-parchment/40">days</span>
          <Button size="sm" onClick={saveRetention} loading={retentionSaving}>
            Save
          </Button>
        </div>
        {retentionMsg && <p className="text-xs text-signal-teal">{retentionMsg}</p>}
        {retentionErr && <p className="text-xs text-spark-orange">{retentionErr}</p>}
      </div>

      <div className="space-y-2 border-t border-parchment/10 pt-4">
        <h3 className="text-xs font-medium text-parchment/60">End-user data deletion</h3>
        <p className="text-xs text-parchment/50">
          Erases one person&apos;s rows across contacts, SMS, voice transcripts, and email log —
          central and the tenant box. Unrecoverable. Use for verified privacy requests (PIPEDA /
          Law 25 / CCPA); the audit log stores a fingerprint, not the identifier.
        </p>
        <div className="flex flex-wrap gap-2">
          <input
            type="text"
            placeholder="+15551234567"
            value={e164}
            onChange={(e) => {
              setE164(e.target.value);
              setDeleteMsg(null);
              setDeleteErr(null);
              setConfirming(false);
            }}
            className={`${inputClass} max-w-[12rem]`}
          />
          <input
            type="email"
            placeholder="person@example.com"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              setDeleteMsg(null);
              setDeleteErr(null);
              setConfirming(false);
            }}
            className={`${inputClass} max-w-[16rem]`}
          />
        </div>
        {!confirming && (
          <Button
            size="sm"
            variant="secondary"
            disabled={!e164.trim() && !email.trim()}
            onClick={() => setConfirming(true)}
          >
            Delete this person&apos;s data…
          </Button>
        )}
        {confirming && (
          <div className="space-y-2 rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-3">
            <p className="text-xs text-parchment/70">
              This permanently deletes every row matching{" "}
              {[e164.trim(), email.trim()].filter(Boolean).join(" / ")} for this tenant — central
              and box. There is no undo.
            </p>
            <div className="flex gap-2">
              <Button size="sm" onClick={runDeletion} loading={deleting}>
                Confirm permanent deletion
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {deleteMsg && <p className="text-xs text-signal-teal">{deleteMsg}</p>}
        {deleteErr && <p className="text-xs text-spark-orange">{deleteErr}</p>}
      </div>
    </div>
  );
}

"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type Impact = {
  businessName: string;
  counts: {
    contacts: number;
    voiceTranscripts: number;
    smsInbound: number;
    smsOutbound: number;
    emails: number;
    aiflows: number;
    teamMembers: number;
  };
  hasVps: boolean;
  didE164: string | null;
};

type Eligibility =
  | { eligible: true }
  | {
      eligible: false;
      reason: "active_subscription" | "past_due_subscription" | "canceled_in_grace";
    };

const BLOCKED_COPY: Record<
  "active_subscription" | "past_due_subscription" | "canceled_in_grace",
  string
> = {
  active_subscription:
    "You have an active subscription. Cancel it first — cancellation takes a data backup and handles billing properly.",
  past_due_subscription:
    "Your subscription has a past-due balance. Settle or cancel it in Billing first — deletion is available once billing is resolved.",
  canceled_in_grace:
    "Your cancellation is still in its data-retention grace window. Your data (and the option to reactivate) is kept until the window ends, then everything is wiped automatically — no further action needed."
};

const CONFIRM_PHRASE = "DELETE";

/**
 * Danger-zone self-serve account deletion (BizBlasts-style): expanding the
 * card fetches a live impact preview (what data is removed, which number and
 * server are released), then requires the typed phrase + current password —
 * both re-verified server-side.
 */
export function DeleteAccountCard() {
  const [expanded, setExpanded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [impact, setImpact] = useState<Impact | null>(null);
  const [eligibility, setEligibility] = useState<Eligibility | null>(null);
  const [confirm, setConfirm] = useState("");
  const [password, setPassword] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function expand() {
    setExpanded(true);
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/account/deletion-impact", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { impact: Impact; eligibility: Eligibility };
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.ok || !body.data) {
        setError(body?.error?.message ?? "Could not load the deletion preview.");
        return;
      }
      setImpact(body.data.impact);
      setEligibility(body.data.eligibility);
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function doDelete() {
    setDeleting(true);
    setError(null);
    try {
      const res = await fetch("/api/account/delete", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password, confirm })
      });
      const body = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !body?.ok) {
        setError(body?.error?.message ?? "Account deletion failed. Please try again.");
        setDeleting(false);
        return;
      }
      // The auth user may be gone — leave via a hard redirect.
      window.location.href = "/";
    } catch {
      setError("Network error. Please try again.");
      setDeleting(false);
    }
  }

  const blocked = eligibility !== null && !eligibility.eligible;

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-2">Delete account</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Permanently removes your business, its data, and your login. This cannot be undone.
      </p>

      {!expanded ? (
        <button
          type="button"
          onClick={() => void expand()}
          className="text-sm text-spark-orange hover:underline"
          data-testid="delete-account-expand"
        >
          Delete my account…
        </button>
      ) : loading ? (
        <p className="text-xs text-parchment/40">Loading deletion preview…</p>
      ) : (
        <div className="space-y-4">
          {impact && (
            <div
              className="rounded-lg border border-spark-orange/30 bg-spark-orange/5 p-3 text-xs text-parchment/70 space-y-1"
              data-testid="deletion-impact"
            >
              <p className="font-medium text-parchment">
                Deleting {impact.businessName} permanently removes:
              </p>
              <ul className="list-disc list-inside space-y-0.5">
                <li>{impact.counts.contacts} contacts</li>
                <li>{impact.counts.voiceTranscripts} call transcripts</li>
                <li>{impact.counts.smsInbound + impact.counts.smsOutbound} text messages</li>
                <li>{impact.counts.emails} emails</li>
                <li>{impact.counts.aiflows} AiFlows</li>
                <li>{impact.counts.teamMembers} team members</li>
                {impact.didE164 && <li>Your coworker&apos;s number {impact.didE164} is released</li>}
                {impact.hasVps && <li>Your dedicated server is shut down</li>}
              </ul>
            </div>
          )}

          {blocked ? (
            <div className="text-xs text-parchment/60 space-y-2">
              <p>
                {eligibility !== null && !eligibility.eligible
                  ? BLOCKED_COPY[eligibility.reason]
                  : null}
              </p>
              {eligibility !== null &&
                !eligibility.eligible &&
                eligibility.reason !== "canceled_in_grace" && (
                  <a href="/dashboard/billing" className="text-signal-teal hover:underline">
                    Go to Billing →
                  </a>
                )}
            </div>
          ) : (
            <div className="space-y-3">
              <Input
                label={`Type ${CONFIRM_PHRASE} to confirm`}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder={CONFIRM_PHRASE}
                autoComplete="off"
              />
              <Input
                label="Current password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  size="sm"
                  variant="danger"
                  loading={deleting}
                  disabled={confirm !== CONFIRM_PHRASE || !password}
                  onClick={() => void doDelete()}
                  data-testid="delete-account-submit"
                >
                  Permanently delete
                </Button>
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="text-xs text-parchment/40 hover:text-parchment/70"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-spark-orange">{error}</p>}
        </div>
      )}
    </Card>
  );
}

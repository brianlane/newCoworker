"use client";

/**
 * Admin panel for white-glove intake questionnaires.
 *
 * The admin names the prospect's business (and optionally picks the
 * industry, which drives the questionnaire's suggested wording — those two
 * are supplied HERE, never asked of the prospect, because the onboarding
 * interview already collects them). The email is OPTIONAL: with one, the
 * public /intake/<token> link is emailed automatically (best-effort — the
 * copyable link is always shown); without one, the admin just gets the link
 * to share however they like. The list shows every intake's status;
 * completed ones link to the printable build document
 * (/admin/intake-doc/<id>) that their answers generated.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { INDUSTRY_OPTIONS } from "@/lib/white-glove/template";

export type IntakeView = {
  id: string;
  business_name: string;
  recipient_email: string | null;
  status: "sent" | "completed" | "revoked";
  created_at: string;
  completed_at: string | null;
  intakeUrl: string;
};

export function WhiteGloveIntakesPanel({ initialIntakes }: { initialIntakes: IntakeView[] }) {
  const [intakes, setIntakes] = useState<IntakeView[]>(initialIntakes);
  const [businessName, setBusinessName] = useState("");
  const [industry, setIndustry] = useState("other");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    // Best-effort: a failed refresh must never surface as an error for an
    // action that already succeeded (create shows the intake optimistically).
    try {
      const res = await fetch("/api/admin/white-glove-intakes");
      const json = await res.json();
      if (res.ok) setIntakes(json.data?.intakes ?? []);
    } catch {
      // Keep the current list.
    }
  }

  async function create() {
    if (!businessName.trim()) {
      setError("The prospect's business name is required");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/white-glove-intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: businessName.trim(),
          industry,
          ...(email.trim() ? { recipientEmail: email.trim() } : {})
        })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Creating the questionnaire failed");
      } else {
        const emailedTo: string | null = json.data?.emailedTo ?? null;
        setNotice(
          emailedTo
            ? `Questionnaire emailed to ${emailedTo}.`
            : email.trim()
              ? "Questionnaire created — the email couldn't be sent automatically, so copy the link below and send it yourself."
              : "Questionnaire created — copy the link below and share it with the prospect."
        );
        setBusinessName("");
        setIndustry("other");
        setEmail("");
        // Show the created intake (and its copyable link) IMMEDIATELY from
        // the POST response — the manual-send path must not depend on the
        // follow-up refresh succeeding.
        const created = json.data?.intake;
        const intakeUrl: string | undefined = json.data?.intakeUrl;
        if (created && intakeUrl) {
          const view: IntakeView = {
            id: created.id,
            business_name: created.business_name,
            recipient_email: created.recipient_email,
            status: created.status,
            created_at: created.created_at,
            completed_at: created.completed_at,
            intakeUrl
          };
          setIntakes((prev) => [view, ...prev.filter((i) => i.id !== view.id)]);
        }
        await refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function revoke(intakeId: string) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/white-glove-intakes", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ intakeId })
      });
      const json = await res.json();
      if (!res.ok) setError(json.error?.message ?? "Revoking the questionnaire failed");
      await refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  async function copyLink(intake: IntakeView) {
    try {
      await navigator.clipboard.writeText(intake.intakeUrl);
      setCopiedId(intake.id);
      setTimeout(() => setCopiedId(null), 2000);
    } catch {
      setError("Copy failed — the link is shown below the intake");
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-parchment/40">
        Create the setup questionnaire for a prospective white-glove client (about 5
        minutes, mostly multiple choice — no account needed). Add their email to send it
        automatically, or leave it blank to just get a shareable link. Their answers fill
        out the build document our team installs from.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Business / prospect name
          <input
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-56"
            value={businessName}
            onChange={(e) => setBusinessName(e.target.value)}
            placeholder="Acme Home Services"
            maxLength={200}
          />
        </label>
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Industry (suggested wording)
          <select
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-56"
            value={industry}
            onChange={(e) => setIndustry(e.target.value)}
          >
            {INDUSTRY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Email (optional)
          <input
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-56"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="prospect@example.com"
            type="email"
            maxLength={320}
          />
        </label>
        <Button onClick={create} disabled={loading} size="sm">
          {loading ? "Working…" : email.trim() ? "Send questionnaire" : "Create link"}
        </Button>
      </div>

      {error && <p className="text-xs text-clay-red">{error}</p>}
      {notice && <p className="text-xs text-claw-green">{notice}</p>}

      {intakes.length > 0 && (
        <ul className="space-y-1.5">
          {intakes.map((i) => (
            <li
              key={i.id}
              className="rounded-md border border-parchment/10 bg-deep-ink/30 px-3 py-2 space-y-1"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm text-parchment truncate">
                    {i.business_name || i.recipient_email}
                    {i.business_name && i.recipient_email && (
                      <span className="ml-2 text-xs text-parchment/40">
                        {i.recipient_email}
                      </span>
                    )}
                  </p>
                  <p className="text-xs text-parchment/40">
                    {i.status === "completed"
                      ? `Completed ${
                          i.completed_at ? new Date(i.completed_at).toLocaleDateString() : ""
                        }`
                      : i.status === "revoked"
                        ? "Revoked"
                        : `Created ${new Date(i.created_at).toLocaleDateString()} — waiting for answers`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {i.status === "completed" && (
                    <a
                      href={`/admin/intake-doc/${i.id}`}
                      className="text-sm text-signal-teal hover:underline"
                    >
                      View build document →
                    </a>
                  )}
                  {i.status === "sent" && (
                    <>
                      <Button
                        onClick={() => copyLink(i)}
                        disabled={loading}
                        size="sm"
                        variant="ghost"
                      >
                        {copiedId === i.id ? "Copied!" : "Copy link"}
                      </Button>
                      <Button
                        onClick={() => revoke(i.id)}
                        disabled={loading}
                        size="sm"
                        variant="ghost"
                      >
                        Revoke
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {i.status === "sent" && (
                <p className="break-all font-mono text-[10px] text-parchment/30">{i.intakeUrl}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

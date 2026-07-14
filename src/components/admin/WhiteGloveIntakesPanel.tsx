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

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { INDUSTRY_OPTIONS, type IntakeAnswers } from "@/lib/white-glove/template";
import { buildIntakeApplyPlan } from "@/lib/white-glove/apply";

export type IntakeView = {
  id: string;
  business_name: string;
  industry: string;
  recipient_email: string | null;
  business_id: string | null;
  answers: IntakeAnswers | null;
  status: "sent" | "completed" | "revoked";
  created_at: string;
  completed_at: string | null;
  applied_at: string | null;
  intakeUrl: string;
};

export type ApplyBusinessOption = {
  id: string;
  name: string;
  ownerEmail: string;
};

/**
 * Preview + confirm for applying a completed intake to a tenant. The preview
 * is computed CLIENT-SIDE from the same pure mapper the server apply uses
 * (`buildIntakeApplyPlan`), so what the admin reads is what gets written.
 */
function ApplyIntakeSection({
  intake,
  businesses,
  onApplied,
  onError
}: {
  intake: IntakeView;
  businesses: ApplyBusinessOption[];
  onApplied: (notice: string) => void;
  onError: (message: string) => void;
}) {
  const suggested = useMemo(() => {
    if (intake.business_id) return intake.business_id;
    const byName = businesses.find(
      (b) => b.name.trim().toLowerCase() === intake.business_name.trim().toLowerCase()
    );
    if (byName) return byName.id;
    const email = intake.recipient_email?.toLowerCase();
    const byEmail = email
      ? businesses.find((b) => b.ownerEmail.toLowerCase() === email)
      : undefined;
    return byEmail?.id ?? "";
  }, [intake, businesses]);

  const [businessId, setBusinessId] = useState(suggested);
  const [applying, setApplying] = useState(false);

  const plan = useMemo(() => {
    if (!intake.answers) return null;
    try {
      return buildIntakeApplyPlan(intake.answers, {
        businessName: intake.business_name,
        industry: intake.industry
      });
    } catch {
      // A malformed stored answer set can't be applied; the server would
      // reject it too — surface that instead of a broken preview.
      return null;
    }
  }, [intake]);

  async function apply() {
    if (!businessId) {
      onError("Pick the business to apply this build to");
      return;
    }
    setApplying(true);
    try {
      const res = await fetch(`/api/admin/white-glove-intakes/${intake.id}/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = await res.json();
      if (!res.ok) {
        onError(json.error?.message ?? "Applying the build failed");
      } else {
        const flowCreated: boolean = json.data?.flowCreated ?? false;
        const hoursApplied: boolean = json.data?.businessHoursApplied ?? false;
        onApplied(
          (flowCreated
            ? "Build applied — the follow-up flow was installed DISABLED; enable it after the owner approves the wording."
            : "Build re-applied — the existing follow-up flow was updated in place.") +
            (hoursApplied ? "" : " (Business hours couldn't be parsed; they were written to memory only.)")
        );
      }
    } catch {
      onError("Network error");
    } finally {
      setApplying(false);
    }
  }

  if (!plan) {
    return (
      <p className="text-xs text-clay-red">
        These answers can&apos;t be turned into a build plan — apply manually from the
        build document.
      </p>
    );
  }

  const flowSummary = `${plan.flow.name} — ${plan.flow.definition.steps.length} steps, installed disabled for review`;

  return (
    <div className="space-y-2 rounded-md border border-parchment/10 bg-deep-ink/50 p-2">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Apply to business
          <select
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-72"
            value={businessId}
            onChange={(e) => setBusinessId(e.target.value)}
            disabled={Boolean(intake.business_id)}
          >
            <option value="">Pick a business…</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name} ({b.ownerEmail})
              </option>
            ))}
          </select>
        </label>
        <Button onClick={apply} disabled={applying || !businessId} size="sm">
          {applying ? "Applying…" : intake.applied_at ? "Re-apply build" : "Apply build"}
        </Button>
      </div>
      {intake.applied_at && (
        <p className="text-xs text-parchment/40">
          Re-applying replaces the previous white-glove block and updates the installed
          flow in place — the owner&apos;s own edits outside the block are untouched.
        </p>
      )}
      <details className="text-xs text-parchment/60">
        <summary className="cursor-pointer select-none">
          Preview what will be written
        </summary>
        <div className="mt-2 space-y-2">
          <p className="text-parchment/40">Follow-up flow: {flowSummary}</p>
          <p className="text-parchment/40">
            Business hours:{" "}
            {plan.businessHours
              ? "parsed and applied to the business profile"
              : "couldn't be parsed — kept as text in memory only"}
          </p>
          <p className="text-parchment/40">soul.md block:</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-deep-ink/80 p-2 font-mono text-[10px] text-parchment/60">
            {plan.soulBlock}
          </pre>
          <p className="text-parchment/40">memory.md block:</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-deep-ink/80 p-2 font-mono text-[10px] text-parchment/60">
            {plan.memoryBlock}
          </pre>
        </div>
      </details>
    </div>
  );
}

export function WhiteGloveIntakesPanel({
  initialIntakes,
  businesses = []
}: {
  initialIntakes: IntakeView[];
  businesses?: ApplyBusinessOption[];
}) {
  const [intakes, setIntakes] = useState<IntakeView[]>(initialIntakes);
  const [businessName, setBusinessName] = useState("");
  const [industry, setIndustry] = useState("other");
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [applyOpenId, setApplyOpenId] = useState<string | null>(null);
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
            industry: created.industry ?? "other",
            recipient_email: created.recipient_email,
            business_id: created.business_id ?? null,
            answers: null,
            status: created.status,
            created_at: created.created_at,
            completed_at: created.completed_at,
            applied_at: null,
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
                        }${
                          i.applied_at
                            ? ` — applied ${new Date(i.applied_at).toLocaleDateString()}`
                            : ""
                        }`
                      : i.status === "revoked"
                        ? "Revoked"
                        : `Created ${new Date(i.created_at).toLocaleDateString()} — waiting for answers`}
                  </p>
                </div>
                <div className="flex shrink-0 gap-2">
                  {i.status === "completed" && (
                    <>
                      <Button
                        onClick={() =>
                          setApplyOpenId((prev) => (prev === i.id ? null : i.id))
                        }
                        disabled={loading}
                        size="sm"
                        variant="ghost"
                      >
                        {applyOpenId === i.id
                          ? "Close"
                          : i.applied_at
                            ? "Re-apply to business…"
                            : "Apply to business…"}
                      </Button>
                      <a
                        href={`/admin/intake-doc/${i.id}`}
                        className="text-sm text-signal-teal hover:underline"
                      >
                        View build document →
                      </a>
                    </>
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
              {i.status === "completed" && applyOpenId === i.id && (
                <ApplyIntakeSection
                  intake={i}
                  businesses={businesses}
                  onApplied={async (msg) => {
                    setError(null);
                    setNotice(msg);
                    setApplyOpenId(null);
                    await refresh();
                  }}
                  onError={(msg) => {
                    setNotice(null);
                    setError(msg);
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

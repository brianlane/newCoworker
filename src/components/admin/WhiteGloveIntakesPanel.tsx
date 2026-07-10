"use client";

/**
 * Admin panel for white-glove intake questionnaires.
 *
 * "Send questionnaire" emails a prospective white-glove client the public
 * /intake/<token> link (best-effort — the copyable link is always shown so
 * an email hiccup never blocks the workflow). The list shows every intake's
 * status; completed ones link to the printable build document
 * (/admin/intake-doc/<id>) that their answers generated.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";

export type IntakeView = {
  id: string;
  recipient_email: string;
  status: "sent" | "completed" | "revoked";
  created_at: string;
  completed_at: string | null;
  intakeUrl: string;
};

export function WhiteGloveIntakesPanel({ initialIntakes }: { initialIntakes: IntakeView[] }) {
  const [intakes, setIntakes] = useState<IntakeView[]>(initialIntakes);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function refresh() {
    const res = await fetch("/api/admin/white-glove-intakes");
    const json = await res.json();
    if (res.ok) setIntakes(json.data?.intakes ?? []);
  }

  async function send() {
    if (!email.trim()) {
      setError("The prospect's email is required");
      return;
    }
    setLoading(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/white-glove-intakes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recipientEmail: email.trim() })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Sending the questionnaire failed");
      } else {
        const emailedTo: string | null = json.data?.emailedTo ?? null;
        setNotice(
          emailedTo
            ? `Questionnaire emailed to ${emailedTo}.`
            : "Questionnaire created — the email couldn't be sent automatically, so copy the link below and send it yourself."
        );
        setEmail("");
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
        Send a prospective white-glove client the setup questionnaire (about 5 minutes,
        mostly multiple choice — no account needed). Their answers fill out the build
        document our team installs from.
      </p>

      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-xs text-parchment/60">
          Prospect email
          <input
            className="rounded-md bg-deep-ink/80 border border-parchment/20 text-parchment text-sm px-2 py-1.5 w-64"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="prospect@example.com"
            type="email"
            maxLength={320}
          />
        </label>
        <Button onClick={send} disabled={loading} size="sm">
          {loading ? "Working…" : "Send questionnaire"}
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
                  <p className="text-sm text-parchment truncate">{i.recipient_email}</p>
                  <p className="text-xs text-parchment/40">
                    {i.status === "completed"
                      ? `Completed ${
                          i.completed_at ? new Date(i.completed_at).toLocaleDateString() : ""
                        }`
                      : i.status === "revoked"
                        ? "Revoked"
                        : `Sent ${new Date(i.created_at).toLocaleDateString()} — waiting for answers`}
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

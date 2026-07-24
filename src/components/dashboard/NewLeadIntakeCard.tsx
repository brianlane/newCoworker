"use client";

/**
 * One-click installer for the "New Lead Intake" starter flow: the owner
 * texts (or types to) their coworker a new lead's info in plain words and
 * the flow parses it, files the contact, texts the lead an intro (with a
 * personal referral credit when a referrer was named), and offers the lead
 * to the team, pinned to the teammate the owner named ("I want Gabby to
 * have this") via the dynamic agentNameVar pin. Installed DISABLED so the
 * intro wording is personalized before anything fires.
 *
 * Rendered INSIDE AiFlowsManager's list view and driven by its `flows`
 * state, exactly like DocumentReceiptCard / ReviewRequestCard.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { newLeadIntakeTemplate } from "@/lib/ai-flows/templates";

type Props = {
  businessId: string;
  /** The already-installed starter flow, derived live from the flow list. */
  installedFlow: { id: string; enabled: boolean } | null;
  /** Refresh the owning list after a successful install. */
  onInstalled: () => Promise<void>;
  /** Open the installed flow in the editor (wording review). */
  onEdit: (flowId: string) => void;
};

export function NewLeadIntakeCard({ businessId, installedFlow, onInstalled, onEdit }: Props) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setError(null);
    setInstalling(true);
    try {
      const template = newLeadIntakeTemplate();
      const res = await fetch("/api/aiflows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: template.name,
          enabled: false,
          definition: template.definition
        })
      });
      const json = (await res.json()) as
        | { ok: true; data: { id: string } }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setError(json.error.message);
        return;
      }
      await onInstalled();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setInstalling(false);
    }
  };

  return (
    <Card>
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-parchment">
          Hand your coworker a new lead by text
        </h2>
        {installedFlow ? (
          <p className="text-sm text-parchment/60">
            The &ldquo;New Lead Intake&rdquo; flow is installed
            {installedFlow.enabled ? " and running" : " (disabled until you review it)"}.{" "}
            <button
              onClick={() => onEdit(installedFlow.id)}
              className="text-signal-teal hover:underline"
            >
              Review &amp; {installedFlow.enabled ? "edit" : "enable"} it &rarr;
            </button>
          </p>
        ) : (
          <>
            <p className="text-sm text-parchment/60">
              Text your coworker a lead&rsquo;s name and number in plain words and it takes
              it from there: the lead is filed, texted an intro (crediting whoever referred
              them), and offered to your team. Say &ldquo;I want Gabby to have this&rdquo;
              and it goes straight to Gabby. Installed disabled so you can personalize the
              wording first.
            </p>
            <div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={install}
                loading={installing}
              >
                Install New Lead Intake
              </Button>
            </div>
            {error && (
              <p className="text-xs text-spark-orange" role="alert">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

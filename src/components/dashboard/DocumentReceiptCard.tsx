"use client";

/**
 * One-click installer for the "Confirm document receipt" starter flow: when
 * the AI coworker's own mailbox receives an email with attachments, the
 * sender gets an automatic receipt confirmation naming the files and the
 * owner is briefed. No parameters — the install POSTs /api/aiflows with the
 * code-defined template (created DISABLED so the wording and the sending
 * mailbox are reviewed before anything fires).
 *
 * Rendered INSIDE AiFlowsManager's list view and driven by its `flows`
 * state, exactly like ReviewRequestCard.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { documentReceiptTemplate } from "@/lib/ai-flows/templates";

type Props = {
  businessId: string;
  /** The already-installed starter flow, derived live from the flow list. */
  installedFlow: { id: string; enabled: boolean } | null;
  /** Refresh the owning list after a successful install. */
  onInstalled: () => Promise<void>;
  /** Open the installed flow in the editor (wording review). */
  onEdit: (flowId: string) => void;
};

export function DocumentReceiptCard({ businessId, installedFlow, onInstalled, onEdit }: Props) {
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    setError(null);
    setInstalling(true);
    try {
      const template = documentReceiptTemplate();
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
          Confirm document receipt — automatically
        </h2>
        {installedFlow ? (
          <p className="text-sm text-parchment/60">
            The “Confirm document receipt” flow is installed
            {installedFlow.enabled ? " and running" : " (disabled until you review it)"}.{" "}
            <button
              onClick={() => onEdit(installedFlow.id)}
              className="text-signal-teal hover:underline"
            >
              Review &amp; {installedFlow.enabled ? "edit" : "enable"} it →
            </button>
          </p>
        ) : (
          <>
            <p className="text-sm text-parchment/60">
              When someone emails documents to your AI mailbox, your coworker replies
              confirming exactly which files arrived and briefs you. Installed disabled so
              you can review the wording first.
            </p>
            <div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={install}
                loading={installing}
              >
                Install receipt confirmations
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

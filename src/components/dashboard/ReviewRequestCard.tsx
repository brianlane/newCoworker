"use client";

/**
 * One-click installer for the "Ask for a review after appointments" starter
 * flow (the review-requests answer to GHL's Reviews AI). The owner pastes
 * their Google/Yelp/Facebook review link; the install POSTs /api/aiflows
 * with the code-defined template (created DISABLED so the wording is
 * reviewed before anything fires).
 *
 * Rendered INSIDE AiFlowsManager's list view and driven entirely by its
 * `flows` state: `installedFlow` derives from the live list and
 * `onInstalled` is the manager's reload — so installing here immediately
 * shows the flow in the list below, and deleting the flow in the list
 * immediately re-offers the installer (no page reload either way).
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  cleanReviewLink,
  reviewRequestTemplate,
  REVIEW_LINK_MAX_LENGTH
} from "@/lib/ai-flows/templates";

type Props = {
  businessId: string;
  /** The already-installed starter flow, derived live from the flow list. */
  installedFlow: { id: string; enabled: boolean } | null;
  /** Refresh the owning list after a successful install. */
  onInstalled: () => Promise<void>;
  /** Open the installed flow in the editor (wording review). */
  onEdit: (flowId: string) => void;
};

export function ReviewRequestCard({ businessId, installedFlow, onInstalled, onEdit }: Props) {
  const [link, setLink] = useState("");
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async () => {
    const cleaned = cleanReviewLink(link);
    if (!cleaned) {
      setError("Paste a full review link starting with https:// (e.g. your Google review URL).");
      return;
    }
    setError(null);
    setInstalling(true);
    try {
      const template = reviewRequestTemplate(cleaned);
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
      // Refresh the manager's list — installedFlow flips via props.
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
          Ask happy customers for reviews — automatically
        </h2>
        {installedFlow ? (
          <p className="text-sm text-parchment/60">
            The “Ask for a review after appointments” flow is installed
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
              An hour after a calendar appointment ends, your coworker texts the customer
              your review link and briefs you. Paste your Google review link (or any
              review URL) to install the starter — it&apos;s created disabled so you can
              tweak the wording first.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <input
                className="min-w-[16rem] flex-1 rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment"
                placeholder="https://g.page/r/…/review"
                value={link}
                maxLength={REVIEW_LINK_MAX_LENGTH}
                onChange={(ev) => setLink(ev.target.value)}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                onClick={install}
                loading={installing}
                disabled={link.trim().length === 0}
              >
                Install review requests
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

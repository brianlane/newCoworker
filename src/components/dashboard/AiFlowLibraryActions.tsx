"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Sparkles } from "lucide-react";

/**
 * Use / adapt CTA for a single library entry's detail page.
 *   - "Use this flow" duplicates with automatic substitution (phone/email/team)
 *     into a disabled flow and opens it in the editor.
 *   - "Adapt with AI" sends the template + the business's details to Gemini and
 *     opens the rewritten draft in the editor for review.
 */
export function AiFlowLibraryActions({
  businessId,
  libraryId
}: {
  businessId: string | null;
  libraryId: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"use" | "adapt" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showAdapt, setShowAdapt] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [draft, setDraft] = useState<unknown | null>(null);

  if (!businessId) {
    return (
      <p className="text-sm text-parchment/60">
        Provision your coworker first to use a library flow.
      </p>
    );
  }

  const use = async () => {
    setBusy("use");
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/library/${libraryId}/use`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { flowId: string };
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? "Could not use this flow");
        return;
      }
      router.push(`/dashboard/aiflows?edit=${json.data.flowId}`);
    } finally {
      setBusy(null);
    }
  };

  const adapt = async () => {
    setBusy("adapt");
    setError(null);
    try {
      const res = await fetch(`/api/aiflows/library/adapt`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, libraryId, instructions: instructions.trim() || undefined })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { definition: unknown };
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setError(json.error?.message ?? "AI adaptation failed");
        return;
      }
      // Stash the adapted draft for the builder to pick up, then open a fresh
      // editor pre-loaded from it.
      try {
        sessionStorage.setItem("aiflow_adapt_draft", JSON.stringify(json.data.definition));
      } catch {
        /* sessionStorage unavailable — fall through with the raw draft shown */
      }
      setDraft(json.data.definition);
      router.push(`/dashboard/aiflows?adapt=1`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      {error && (
        <p className="rounded-md border border-spark-orange/40 bg-spark-orange/5 px-3 py-2 text-sm text-spark-orange">
          {error}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <button
          onClick={use}
          disabled={busy !== null}
          className="rounded-md bg-signal-teal px-4 py-2 text-sm font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
        >
          {busy === "use" ? "Using…" : "Use this flow"}
        </button>
        <button
          onClick={() => setShowAdapt((v) => !v)}
          className="inline-flex items-center gap-1.5 text-sm text-signal-teal hover:underline"
        >
          <Sparkles className="h-4 w-4" /> Adapt with AI
        </button>
      </div>
      {showAdapt && (
        <div className="rounded-md border border-parchment/10 bg-deep-ink/20 p-4 space-y-3">
          <p className="text-[11px] text-parchment/40">
            We&apos;ll rewrite this flow for your business — your number, email, and team are
            filled in automatically. Add anything else to tweak (optional).
          </p>
          <textarea
            className="w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none"
            rows={2}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            placeholder="e.g. only text buyers, and route leads to my partner first"
          />
          <button
            onClick={adapt}
            disabled={busy !== null}
            className="rounded-md bg-signal-teal/20 px-3 py-1.5 text-sm text-signal-teal hover:bg-signal-teal/30 disabled:opacity-50"
          >
            {busy === "adapt" ? "Adapting…" : "Adapt with AI"}
          </button>
          {draft !== null && (
            <p className="text-[11px] text-parchment/40">Draft ready — opening the editor…</p>
          )}
        </div>
      )}
    </div>
  );
}

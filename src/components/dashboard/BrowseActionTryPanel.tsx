"use client";

/**
 * "Try these actions": run the step's action list against a real page and show
 * which ones found their control, before it ever meets a live lead.
 *
 * The gap this closes: "Test with a contact" simulates browse steps (it echoes
 * the action list and never opens a browser), so a selector's first real test
 * used to be production. Nothing is clicked, typed or chosen here; the sidecar
 * has a separate dry-run responder that only locates.
 *
 * The wizard limitation is stated in the UI rather than hidden, because it
 * produces a scary-looking result on a perfectly good sequence: the page is
 * judged AS LOADED, so an action that only exists after an earlier click reads
 * as "not found". An owner who is not told that will "fix" a working step.
 */
import { useState } from "react";
import { AlertTriangle, CheckCircle2, CircleDashed, PlayCircle, XCircle } from "lucide-react";
// The VIEW module, not action-check.ts: that one reaches the sidecar client,
// which reaches the URL guard, which reaches next/headers. Importing a value
// from it here fails the build.
import type { ActionCheck, CheckableAction } from "@/lib/ai-flows/action-check-view";
import { describeActionCheck, noActionResolved } from "@/lib/ai-flows/action-check-view";

type Props = {
  businessId: string;
  integrationLabel?: string;
  actions: CheckableAction[];
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment placeholder:text-parchment/30";

function StateIcon({ state }: { state: ActionCheck["state"] }) {
  if (state === "ready") return <CheckCircle2 className="h-4 w-4 shrink-0 text-claw-green" />;
  if (state === "blocked") return <CircleDashed className="h-4 w-4 shrink-0 text-parchment/50" />;
  if (state === "missing_option")
    return <AlertTriangle className="h-4 w-4 shrink-0 text-spark-orange" />;
  return <XCircle className="h-4 w-4 shrink-0 text-spark-orange" />;
}

export function BrowseActionTryPanel({ businessId, integrationLabel, actions }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checks, setChecks] = useState<ActionCheck[] | null>(null);
  const [shot, setShot] = useState<string | null>(null);

  const usable = actions.filter((a) => a.kind && a.target);

  const run = async () => {
    setLoading(true);
    setError(null);
    setChecks(null);
    setShot(null);
    try {
      const res = await fetch("/api/aiflows/check-actions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          url: url.trim(),
          actions: usable,
          ...(integrationLabel ? { integrationLabel } : {})
        })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { checks: ActionCheck[]; screenshotBase64?: string };
        error?: { message: string };
      };
      if (json.ok && json.data) {
        setChecks(json.data.checks);
        setShot(json.data.screenshotBase64 ?? null);
      } else {
        setError(json.error?.message ?? "The actions could not be tried.");
      }
    } catch {
      setError("The actions could not be tried.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 p-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold text-signal-teal hover:underline"
        aria-expanded={open}
      >
        <PlayCircle className="h-3.5 w-3.5" />
        {open ? "Hide the check" : "Try these actions on a real page"}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] leading-snug text-parchment/50">
            We open the page and look for each thing this step aims at. Nothing is clicked, typed
            or chosen, so this is safe to run against a real lead&apos;s page.
          </p>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={url}
              placeholder="https://..."
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && usable.length > 0 && url.trim()) void run();
              }}
            />
            <button
              onClick={() => void run()}
              disabled={loading || url.trim().length === 0 || usable.length === 0}
              className="shrink-0 rounded-md bg-signal-teal/90 px-2 py-1 text-xs font-semibold text-deep-ink disabled:opacity-40"
            >
              {loading ? "Checking..." : "Check"}
            </button>
          </div>
          {usable.length === 0 && (
            <p className="text-[11px] text-parchment/40">
              Fill in at least one action above before checking.
            </p>
          )}

          {error && <p className="text-[11px] text-spark-orange">{error}</p>}

          {checks && (
            <div className="space-y-2 border-t border-parchment/10 pt-2">
              {checks.map((check, i) => (
                <div key={`${check.kind}:${check.target}:${i}`} className="flex items-start gap-2">
                  <StateIcon state={check.state} />
                  <div className="min-w-0">
                    <p className="break-words font-mono text-[11px] text-parchment/70">
                      {i + 1}. {check.kind} {check.target}
                    </p>
                    <p className="text-[11px] leading-snug text-parchment/50">
                      {describeActionCheck(check)}
                    </p>
                  </div>
                </div>
              ))}

              {/* Stated once, under the results, where it explains what the
                  owner is looking at rather than pre-emptively excusing it. */}
              <p className="text-[11px] leading-snug text-parchment/40">
                This looks at the page as it first loads. An action that only exists after an
                earlier one has run (the next page of a wizard, a box inside a pop-up) will show as
                not found here even when it is correct.
              </p>

              {noActionResolved(checks) && (
                <p className="text-[11px] leading-snug text-spark-orange">
                  Nothing at all was found. That usually means the page did not really load: check
                  the address, and whether this step needs a login it does not have.
                </p>
              )}

              {shot && (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold text-parchment/70">
                    What the page looked like
                  </p>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a
                      data: URI from the tenant's own box; next/image would try
                      to optimize it through the loader. */}
                  <img
                    src={`data:image/jpeg;base64,${shot}`}
                    alt="The page as the browser service saw it"
                    className="max-h-64 w-full rounded-md border border-parchment/10 object-cover object-top"
                  />
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

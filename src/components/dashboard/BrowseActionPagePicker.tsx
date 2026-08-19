"use client";

/**
 * "Open this page": show a real page's buttons, dropdowns and fields, and let
 * the owner add one as a step action with a click.
 *
 * Without this, authoring a browse step means typing a CSS selector from
 * memory into a blank box and finding out whether it was right when a live
 * lead comes through. That is how a ReferralExchange update sequence sat
 * broken in production for weeks: the note field was
 * `textarea[name="message"]`, not the placeholder it had been written as.
 *
 * The page is opened through the tenant's own browser service with the
 * tenant's own saved login, so what is listed here is what the flow will see.
 * Nothing is clicked: the request never carries an actions array (see
 * src/lib/ai-flows/page-probe.ts), so opening a page cannot accept a referral
 * or send anything.
 */
import { useState } from "react";
import { ExternalLink, Eye, Plus } from "lucide-react";
import type { PageControl, PageDigest } from "@/lib/ai-flows/page-controls";
import { PAGE_CONTROL_GROUPS } from "@/lib/ai-flows/page-controls";

type Props = {
  businessId: string;
  /** The step's saved login label, when the page is behind the owner's account. */
  integrationLabel?: string;
  /** Append an action to the step being edited. */
  onAddAction: (action: { kind: string; target: string; valueTemplate?: string }) => void;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment placeholder:text-parchment/30";

export function BrowseActionPagePicker({ businessId, integrationLabel, onAddAction }: Props) {
  const [open, setOpen] = useState(false);
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [digest, setDigest] = useState<PageDigest | null>(null);
  const [finalUrl, setFinalUrl] = useState<string | null>(null);

  const probe = async (target: string) => {
    if (!target.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/aiflows/probe-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          url: target.trim(),
          ...(integrationLabel ? { integrationLabel } : {})
        })
      });
      const json = (await res.json()) as {
        ok: boolean;
        data?: { finalUrl: string; digest: PageDigest };
        error?: { message: string };
      };
      if (json.ok && json.data) {
        setDigest(json.data.digest);
        setFinalUrl(json.data.finalUrl);
      } else {
        setDigest(null);
        setError(json.error?.message ?? "The page could not be opened.");
      }
    } catch {
      setDigest(null);
      setError("The page could not be opened.");
    } finally {
      setLoading(false);
    }
  };

  const addControl = (control: PageControl, optionValue?: string) => {
    onAddAction({
      kind: control.kind,
      target: control.target,
      ...(optionValue ? { valueTemplate: optionValue } : {})
    });
  };

  return (
    <div className="rounded-lg border border-parchment/10 bg-deep-ink/40 p-2">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 text-xs font-semibold text-signal-teal hover:underline"
        aria-expanded={open}
      >
        <Eye className="h-3.5 w-3.5" />
        {open ? "Hide the page" : "Open this page and show me what is on it"}
      </button>

      {open && (
        <div className="mt-2 space-y-2">
          <p className="text-[11px] leading-snug text-parchment/50">
            Paste the address of a real page this flow works on (one example lead is enough). We
            open it in your business&apos;s own browser, signed in the same way this step will be,
            and list what is on it. Nothing is clicked and nothing is sent.
          </p>
          <div className="flex gap-2">
            <input
              className={inputClass}
              value={url}
              placeholder="https://..."
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void probe(url);
              }}
            />
            <button
              onClick={() => void probe(url)}
              disabled={loading || url.trim().length === 0}
              className="shrink-0 rounded-md bg-signal-teal/90 px-2 py-1 text-xs font-semibold text-deep-ink disabled:opacity-40"
            >
              {loading ? "Opening..." : "Open"}
            </button>
          </div>
          {integrationLabel ? (
            <p className="text-[11px] text-parchment/40">
              Signing in with your saved &quot;{integrationLabel}&quot; login.
            </p>
          ) : (
            <p className="text-[11px] text-parchment/40">
              No login set on this step, so the page is opened as a signed-out visitor. If the real
              page needs an account, fill in the login box above first.
            </p>
          )}

          {error && <p className="text-[11px] text-spark-orange">{error}</p>}

          {digest && (
            <div className="space-y-3 border-t border-parchment/10 pt-2">
              {finalUrl && finalUrl !== url.trim() && (
                <p className="break-all text-[11px] text-parchment/40">
                  Ended up on {finalUrl}
                </p>
              )}
              {digest.headings.length > 0 && (
                <p className="text-[11px] text-parchment/50">
                  This page says: {digest.headings.slice(0, 4).join(" · ")}
                </p>
              )}

              {digest.controls.length === 0 && (
                <p className="text-[11px] text-parchment/50">
                  Nothing clickable was found. The page may still have been loading, or it may need
                  a login this step does not have yet.
                </p>
              )}

              {PAGE_CONTROL_GROUPS.map((group) => {
                const rows = digest.controls.filter((c) => c.group === group);
                if (rows.length === 0) return null;
                return (
                  <div key={group} className="space-y-1">
                    <p className="text-[11px] font-semibold text-parchment/70">{group}</p>
                    {rows.map((control) => (
                      <div key={`${control.kind}:${control.target}`} className="space-y-1">
                        <div className="flex items-start gap-2">
                          <button
                            onClick={() => addControl(control)}
                            className="mt-0.5 shrink-0 text-signal-teal hover:text-parchment"
                            aria-label={`Add ${control.label} as an action`}
                          >
                            <Plus className="h-3 w-3" />
                          </button>
                          <span className="min-w-0 break-words font-mono text-[11px] text-parchment/70">
                            {control.label}
                          </span>
                        </div>
                        {/* A dropdown is only useful with the choice named, so
                            its options are the thing you actually click. */}
                        {control.options && control.options.length > 0 && (
                          <div className="flex flex-wrap gap-1 pl-5">
                            {control.options.map((option) => (
                              <button
                                key={option}
                                onClick={() => addControl(control, option)}
                                className="rounded-full border border-parchment/15 px-2 py-0.5 text-[10px] text-parchment/60 hover:border-signal-teal hover:text-parchment"
                              >
                                choose &quot;{option}&quot;
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}

              {digest.links.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[11px] font-semibold text-parchment/70">
                    Links on this page
                  </p>
                  <p className="text-[11px] text-parchment/40">
                    On a list page, open one of these to see the controls on a single record.
                  </p>
                  {digest.links.slice(0, 15).map((link) => (
                    <button
                      key={link.href}
                      onClick={() => {
                        const next = new URL(link.href, finalUrl ?? url).toString();
                        setUrl(next);
                        void probe(next);
                      }}
                      className="flex w-full items-start gap-2 text-left text-[11px] text-parchment/60 hover:text-parchment"
                    >
                      <ExternalLink className="mt-0.5 h-3 w-3 shrink-0 text-signal-teal" />
                      <span className="min-w-0 break-all">{link.label || link.href}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

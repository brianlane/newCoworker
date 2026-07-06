"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";

type MergeCandidate = {
  customerE164: string;
  displayName: string | null;
};

type Props = {
  businessId: string;
  customerE164: string;
  /** Other customers of this business (merge targets), recency-ordered. */
  candidates: MergeCandidate[];
};

/**
 * "Merge into another customer" — folds THIS profile into a selected one
 * (this number becomes an alias of the target). Collapsed behind a single
 * button because merging is rare and irreversible.
 */
export function CustomerMergeAction(props: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [intoE164, setIntoE164] = useState("");
  const [merging, setMerging] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const selected = props.candidates.find((c) => c.customerE164 === intoE164) ?? null;

  async function merge() {
    if (!selected) return;
    const targetLabel = selected.displayName
      ? `${selected.displayName} (${selected.customerE164})`
      : selected.customerE164;
    const ok = window.confirm(
      `Merge this customer into ${targetLabel}?\n\nNotes, summary, and interaction counts are combined onto ${targetLabel}, and ${props.customerE164} becomes an alias of that profile; future texts or calls from it update the merged profile. This cannot be undone.`
    );
    if (!ok) return;
    setMerging(true);
    setErrorMsg(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(
          props.customerE164
        )}/merge?businessId=${encodeURIComponent(props.businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intoE164 })
        }
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(json?.error?.message || `HTTP ${res.status}`);
      }
      router.push(`/dashboard/customers/${encodeURIComponent(intoE164)}`);
      router.refresh();
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setMerging(false);
    }
  }

  if (props.candidates.length === 0) return null;

  return (
    <Card>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-parchment">Merge profiles</h2>
          <p className="text-xs text-parchment/50 mt-0.5">
            Same person under two numbers (landline call + cell text)? Fold this
            profile into the other one.
          </p>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-lg border border-parchment/20 text-parchment/80 px-3 py-1.5 text-xs hover:bg-parchment/5 transition-colors shrink-0"
          >
            Merge into another customer…
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 space-y-3">
          <select
            value={intoE164}
            onChange={(e) => setIntoE164(e.target.value)}
            className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment focus:outline-none focus:border-claw-green/60"
          >
            <option value="">Choose the customer to keep…</option>
            {props.candidates.map((c) => (
              <option key={c.customerE164} value={c.customerE164}>
                {c.displayName
                  ? `${c.displayName}: ${c.customerE164}`
                  : c.customerE164}
              </option>
            ))}
          </select>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={merge}
              disabled={!selected || merging}
              className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {merging ? "Merging…" : "Merge"}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setIntoE164("");
                setErrorMsg(null);
              }}
              disabled={merging}
              className="rounded-lg border border-parchment/20 text-parchment/70 px-4 py-2 text-sm hover:bg-parchment/5 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
            {errorMsg && <span className="text-xs text-red-300">{errorMsg}</span>}
          </div>
          <p className="text-[10px] text-parchment/40">
            This profile&apos;s notes and history counters move onto the customer
            you keep; this number becomes an alias so future texts and calls
            from it land on the merged profile.
          </p>
        </div>
      )}
    </Card>
  );
}

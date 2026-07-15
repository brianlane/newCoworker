"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Generic confirm-then-DELETE affordance for dashboard items rendered by
 * server components (call transcripts, SMS conversations, …). Issues a
 * `DELETE` to `url`, then either navigates to `redirectTo` (detail pages —
 * the item is gone, so the page 404s) or refreshes the server rows in place
 * (list rows).
 */
export function DeleteItemButton({
  url,
  confirmMessage,
  redirectTo,
  label = "Delete",
  compact = false
}: {
  url: string;
  confirmMessage: string;
  /** Navigate here after a successful delete; omitted = router.refresh(). */
  redirectTo?: string;
  label?: string;
  /** Text-link styling for tight list rows instead of the bordered pill. */
  compact?: boolean;
}) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "deleting" | "error">("idle");

  async function run() {
    if (!window.confirm(confirmMessage)) return;
    setState("deleting");
    try {
      const res = await fetch(url, { method: "DELETE" });
      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        setState("error");
        return;
      }
      if (redirectTo) {
        router.push(redirectTo);
        router.refresh();
      } else {
        setState("idle");
        router.refresh();
      }
    } catch {
      setState("error");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        data-testid="delete-item"
        onClick={() => void run()}
        disabled={state === "deleting"}
        className={
          compact
            ? "text-xs font-medium text-spark-orange/70 hover:text-spark-orange disabled:opacity-50 cursor-pointer"
            : "rounded-lg border border-spark-orange/40 px-3 py-1 text-xs font-semibold text-spark-orange transition-colors hover:bg-spark-orange/10 disabled:opacity-50"
        }
      >
        {state === "deleting" ? "Deleting…" : label}
      </button>
      {state === "error" && (
        <span className="text-xs text-spark-orange">Couldn&apos;t delete — try again.</span>
      )}
    </span>
  );
}

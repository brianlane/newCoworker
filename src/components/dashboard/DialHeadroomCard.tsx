"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { DIAL_HEADROOM_DEFAULT, describeDialHeadroom } from "./dial-headroom";

/**
 * Settings -> Business: how many of the business's concurrent-call lines
 * stay reserved for live transfers and teammate rings (the AI stops dialing
 * new outbound calls once in-flight calls reach cap minus this). Lives next
 * to the owner phone editor because that is the number those reserved lines
 * ring; the dashboard phone card links here.
 */
export function DialHeadroomCard({
  businessId,
  initialHeadroom
}: {
  businessId: string;
  initialHeadroom: number | null;
}) {
  const [headroom, setHeadroom] = useState<number>(initialHeadroom ?? DIAL_HEADROOM_DEFAULT);
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  async function save(next: number) {
    const previous = headroom;
    setHeadroom(next);
    setState("saving");
    try {
      const res = await fetch("/api/business/dial-headroom", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, headroom: next })
      });
      if (!res.ok) throw new Error(String(res.status));
      setState("saved");
      setTimeout(() => setState("idle"), 1500);
    } catch {
      setHeadroom(previous);
      setState("error");
      setTimeout(() => setState("idle"), 2500);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Lines held for live transfers</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Your plan includes a set number of simultaneous calls. This many of them stay
        reserved for handing a live caller to a human, so the AI&rsquo;s own outbound
        calls can never fill every line.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={headroom}
          onChange={(event) => void save(Number(event.target.value))}
          disabled={state === "saving"}
          aria-label="Lines held for live transfers"
          className="rounded-md border border-parchment/20 bg-transparent px-2 py-1 text-sm text-parchment"
        >
          {Array.from({ length: 10 }, (_, n) => (
            <option key={n} value={n} className="bg-ink">
              {n}
              {n === DIAL_HEADROOM_DEFAULT ? " (default)" : ""}
            </option>
          ))}
        </select>
        {state === "saved" && <span className="text-xs text-claw-green">Saved ✓</span>}
        {state === "error" && (
          <span className="text-xs text-spark-orange">Could not save; try again.</span>
        )}
      </div>
      <p className="mt-2 text-xs text-parchment/50">{describeDialHeadroom(headroom)}</p>
    </Card>
  );
}

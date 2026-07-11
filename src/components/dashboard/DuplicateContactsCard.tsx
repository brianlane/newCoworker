"use client";

/**
 * "Possible duplicates" suggestions for /dashboard/customers.
 *
 * Server-side detection (src/lib/customer-memory/dedup.ts) pairs customer
 * profiles that share an email and recommends a merge direction by data
 * completeness (BizBlasts CustomerLinker port). Nothing merges without the
 * owner clicking — the button drives the existing merge endpoint, which
 * folds the duplicate's notes/counters into the survivor and records its
 * number as an alias so future texts/calls resolve correctly.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export type DuplicatePairView = {
  email: string;
  intoE164: string;
  intoName: string | null;
  fromE164: string;
  fromName: string | null;
};

type Props = {
  businessId: string;
  pairs: DuplicatePairView[];
};

function label(name: string | null, e164: string): string {
  return name ? `${name} (${e164})` : e164;
}

export function DuplicateContactsCard({ businessId, pairs }: Props) {
  const router = useRouter();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [banner, setBanner] = useState<string | null>(null);

  const visible = pairs.filter((p) => !dismissed.has(p.fromE164));
  if (visible.length === 0) return null;

  async function merge(pair: DuplicatePairView) {
    setBanner(null);
    setBusyKey(pair.fromE164);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(pair.fromE164)}/merge?businessId=${businessId}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ intoE164: pair.intoE164 })
        }
      );
      if (!res.ok) {
        const json = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setBanner(json?.error?.message ?? "Merge failed — try again from the contact page.");
        return;
      }
      setDismissed((prev) => new Set(prev).add(pair.fromE164));
      router.refresh();
    } finally {
      setBusyKey(null);
    }
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-parchment">Possible duplicates</h3>
      <p className="text-xs text-parchment/50 mt-1">
        These customers share an email address — likely the same person reached on two
        numbers. Merging keeps the more complete profile and makes the other number an
        alias of it.
      </p>
      {banner ? <p className="text-xs text-spark-orange mt-3">{banner}</p> : null}
      <ul className="mt-4 space-y-3">
        {visible.map((pair) => (
          <li
            key={pair.fromE164}
            className="flex flex-wrap items-center justify-between gap-3 text-sm"
          >
            <div className="text-parchment/80">
              <span className="text-parchment/90">{label(pair.fromName, pair.fromE164)}</span>
              <span className="text-parchment/40"> → </span>
              <span className="text-parchment/90">{label(pair.intoName, pair.intoE164)}</span>
              <span className="block text-[11px] text-parchment/40">{pair.email}</span>
            </div>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                loading={busyKey === pair.fromE164}
                onClick={() => void merge(pair)}
              >
                Merge
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  setDismissed((prev) => new Set(prev).add(pair.fromE164))
                }
              >
                Not the same person
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </Card>
  );
}

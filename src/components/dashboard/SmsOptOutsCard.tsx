"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type OptOutEntry = { e164: string; name: string | null; setAt: string };

/**
 * Settings → Channels: compliance visibility into the SMS STOP list, plus
 * proactive suppression ("never text this number"). Deliberately no
 * owner-side removal — a customer's STOP holds until they text START.
 */
export function SmsOptOutsCard({ businessId }: { businessId: string }) {
  const [entries, setEntries] = useState<OptOutEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [newNumber, setNewNumber] = useState("");
  const [adding, setAdding] = useState(false);
  const [addMessage, setAddMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/dashboard/sms-optouts?businessId=${encodeURIComponent(businessId)}`,
          { cache: "no-store" }
        );
        const json = (await res.json().catch(() => null)) as {
          ok?: boolean;
          data?: { optOuts: OptOutEntry[] };
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!res.ok || !json?.ok || !json.data) {
          setError(json?.error?.message ?? "Could not load the opt-out list.");
          return;
        }
        setEntries(json.data.optOuts);
      } catch {
        if (!cancelled) setError("Network error loading the opt-out list.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [businessId]);

  async function addOptOut(e: FormEvent) {
    e.preventDefault();
    if (!newNumber.trim()) return;
    setAdding(true);
    setAddMessage(null);
    try {
      const res = await fetch("/api/dashboard/sms-optouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, e164: newNumber.trim() })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        data?: { e164: string; isNew: boolean };
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok || !json.data) {
        setAddMessage(json?.error?.message ?? "Could not add the number.");
        return;
      }
      const added = json.data;
      setNewNumber("");
      setAddMessage(added.isNew ? "Number suppressed." : "That number was already opted out.");
      setEntries((prev) =>
        added.isNew && prev
          ? [{ e164: added.e164, name: null, setAt: new Date().toISOString() }, ...prev]
          : prev
      );
    } catch {
      setAddMessage("Network error. Please try again.");
    } finally {
      setAdding(false);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Text opt-outs</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Numbers that replied STOP (or that you suppressed) never receive texts from your
        coworker — including AiFlows and manual sends. A customer can text START to opt back
        in; you can&apos;t re-enable them yourself.
      </p>

      {error ? (
        <p className="text-xs text-spark-orange">{error}</p>
      ) : entries === null ? (
        <p className="text-xs text-parchment/40">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-parchment/40" data-testid="optouts-empty">
          No opted-out numbers.
        </p>
      ) : (
        <ul className="divide-y divide-parchment/10 mb-4" data-testid="optouts-list">
          {entries.map((entry) => (
            <li key={entry.e164} className="flex items-center justify-between py-2 text-sm">
              <span className="text-parchment">
                {entry.name ? (
                  <>
                    {entry.name}{" "}
                    <span className="text-parchment/40 font-mono text-xs">{entry.e164}</span>
                  </>
                ) : (
                  <span className="font-mono">{entry.e164}</span>
                )}
              </span>
              <span className="text-xs text-parchment/40">
                since {new Date(entry.setAt).toLocaleDateString()}
              </span>
            </li>
          ))}
        </ul>
      )}

      <form onSubmit={addOptOut} className="mt-4 flex items-end gap-2">
        <div className="flex-1">
          <Input
            label="Suppress a number"
            value={newNumber}
            onChange={(e) => setNewNumber(e.target.value)}
            placeholder="+1 602 555 0147"
          />
        </div>
        <Button type="submit" size="sm" variant="ghost" loading={adding} disabled={!newNumber.trim()}>
          Add
        </Button>
      </form>
      {addMessage && <p className="mt-2 text-xs text-parchment/60">{addMessage}</p>}
    </Card>
  );
}

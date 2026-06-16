"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type Status = { kind: "idle" | "saving" | "success" | "error"; message?: string };

type Availability =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "ok" }
  | { state: "bad"; message: string };

async function readApiError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: { message?: string } };
    return body.error?.message ?? "Something went wrong. Please try again.";
  } catch {
    return "Something went wrong. Please try again.";
  }
}

const REASON_COPY: Record<string, string> = {
  invalid_format: "Use 3-64 letters, numbers, dot, dash or underscore.",
  reserved: "That handle is reserved.",
  taken: "That handle is already taken."
};

export function MailboxSettings({
  businessId,
  domain,
  initialLocalPart,
  initialPersonalized,
  canPersonalize
}: {
  businessId: string;
  domain: string;
  initialLocalPart: string;
  initialPersonalized: boolean;
  canPersonalize: boolean;
}) {
  const router = useRouter();
  const [localPart, setLocalPart] = useState(initialLocalPart);
  const [savedLocalPart, setSavedLocalPart] = useState(initialLocalPart);
  const [personalized, setPersonalized] = useState(initialPersonalized);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [availability, setAvailability] = useState<Availability>({ state: "idle" });

  const trimmed = localPart.trim().toLowerCase();
  const unchanged = trimmed === savedLocalPart;

  // Debounced live availability check as the owner types a new handle.
  // setState is deferred to a microtask/timeout (never called synchronously in
  // the effect body) to satisfy react-hooks/set-state-in-effect.
  useEffect(() => {
    let cancelled = false;
    if (!canPersonalize || unchanged || trimmed.length === 0) {
      queueMicrotask(() => {
        if (!cancelled) setAvailability({ state: "idle" });
      });
      return () => {
        cancelled = true;
      };
    }
    queueMicrotask(() => {
      if (!cancelled) setAvailability({ state: "checking" });
    });
    const t = setTimeout(async () => {
      try {
        const res = await fetch(
          `/api/dashboard/mailbox?businessId=${encodeURIComponent(businessId)}&check=${encodeURIComponent(trimmed)}`
        );
        if (cancelled) return;
        if (!res.ok) {
          setAvailability({ state: "bad", message: await readApiError(res) });
          return;
        }
        const body = (await res.json()) as {
          data?: { available?: boolean; reason?: string };
        };
        if (body.data?.available) {
          setAvailability({ state: "ok" });
        } else {
          const reason = body.data?.reason ?? "taken";
          setAvailability({ state: "bad", message: REASON_COPY[reason] ?? "That handle isn't available." });
        }
      } catch {
        if (!cancelled) setAvailability({ state: "idle" });
      }
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [businessId, trimmed, unchanged, canPersonalize]);

  async function save(e: FormEvent) {
    e.preventDefault();
    if (unchanged || trimmed.length === 0) return;
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/dashboard/mailbox", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, localPart: trimmed })
      });
      if (!res.ok) {
        setStatus({ kind: "error", message: await readApiError(res) });
        return;
      }
      const body = (await res.json()) as {
        data?: { localPart?: string; personalized?: boolean };
      };
      const next = body.data?.localPart ?? trimmed;
      setLocalPart(next);
      setSavedLocalPart(next);
      setPersonalized(body.data?.personalized ?? true);
      setAvailability({ state: "idle" });
      setStatus({ kind: "success", message: "Mailbox address updated." });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  const currentAddress = `${savedLocalPart}@${domain}`;

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">AI coworker mailbox</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Your coworker has its own email address. Mail sent here is read by the AI and can trigger
        workflows, and emails your coworker sends come from this address.
      </p>

      <div className="mb-4">
        <span className="block text-xs font-medium text-parchment/60 mb-1">Current address</span>
        <code className="block break-all rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-[13px] text-parchment">
          {currentAddress}
        </code>
        {!personalized && (
          <p className="mt-1 text-[11px] text-parchment/40">
            This is your default address. {canPersonalize
              ? "Personalize it below."
              : "Personalizing the address is available on the Standard plan and above."}
          </p>
        )}
      </div>

      {canPersonalize && (
        <form onSubmit={save} className="space-y-3">
          <label className="block">
            <span className="block text-xs font-medium text-parchment/60 mb-1">Personalized handle</span>
            <div className="flex items-stretch">
              <input
                value={localPart}
                onChange={(e) => setLocalPart(e.target.value)}
                maxLength={64}
                placeholder="your-name"
                className="w-full rounded-l-md border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment focus:border-signal-teal focus:outline-none"
              />
              <span className="inline-flex items-center rounded-r-md border border-l-0 border-parchment/20 bg-deep-ink/60 px-3 text-sm text-parchment/50">
                @{domain}
              </span>
            </div>
          </label>
          {availability.state === "checking" && (
            <p className="text-xs text-parchment/40">Checking availability…</p>
          )}
          {availability.state === "ok" && (
            <p className="text-xs text-claw-green">Available</p>
          )}
          {availability.state === "bad" && (
            <p className="text-xs text-spark-orange">{availability.message}</p>
          )}
          <div className="flex items-center gap-3">
            <Button
              type="submit"
              size="sm"
              loading={status.kind === "saving"}
              disabled={unchanged || trimmed.length === 0 || availability.state === "bad"}
            >
              Save
            </Button>
            {status.kind === "success" && <p className="text-xs text-claw-green">{status.message}</p>}
            {status.kind === "error" && <p className="text-xs text-spark-orange">{status.message}</p>}
          </div>
        </form>
      )}
    </Card>
  );
}

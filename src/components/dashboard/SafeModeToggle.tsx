"use client";

/**
 * Safe Mode control + forwarding phone setup.
 *
 * Safe Mode forwards inbound customer SMS/voice to `forward_to_e164` instead
 * of running the AI. The number is a precondition — the toggle stays disabled
 * until it's saved, so there is never a state where Safe Mode is on with no
 * destination. Turning it off is always permitted.
 */

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Badge } from "@/components/ui/Badge";

type ApiEnvelope<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

type Props = {
  businessId: string;
  initiallyEnabled: boolean;
  initialForwardToE164: string | null;
  /** Shorter copy for the admin page. */
  compact?: boolean;
};

const E164_REGEX = /^\+[1-9][0-9]{7,14}$/;

async function parseEnvelope<T>(res: Response): Promise<ApiEnvelope<T>> {
  try {
    return (await res.json()) as ApiEnvelope<T>;
  } catch {
    return {
      ok: false,
      error: { code: "INTERNAL_SERVER_ERROR", message: "Unexpected server response" }
    };
  }
}

export function SafeModeToggle({
  businessId,
  initiallyEnabled,
  initialForwardToE164,
  compact
}: Props) {
  const router = useRouter();
  const [safeMode, setSafeMode] = useState(initiallyEnabled);
  const [forwardTo, setForwardTo] = useState(initialForwardToE164 ?? "");
  const [forwardDraft, setForwardDraft] = useState(initialForwardToE164 ?? "");
  const [editingForward, setEditingForward] = useState(!initialForwardToE164);
  const [savingForward, setSavingForward] = useState(false);
  const [togglingMode, setTogglingMode] = useState(false);
  const [forwardError, setForwardError] = useState<string | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  const phoneInputRef = useRef<HTMLInputElement | null>(null);

  const hasForward = forwardTo.trim().length > 0;

  async function saveForwarding() {
    setForwardError(null);
    const trimmed = forwardDraft.trim();
    if (trimmed && !E164_REGEX.test(trimmed)) {
      setForwardError("Use E.164 format, e.g. +15555550123");
      return;
    }
    setSavingForward(true);
    try {
      const res = await fetch("/api/business/forwarding-phone", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, phone: trimmed })
      });
      const env = await parseEnvelope<{
        phone: string | null;
        safeModeDisabled: boolean;
      }>(res);
      if (!env.ok) {
        setForwardError(env.error.message);
        return;
      }
      const newPhone = env.data.phone ?? "";
      setForwardTo(newPhone);
      setForwardDraft(newPhone);
      setEditingForward(false);
      if (env.data.safeModeDisabled) {
        setSafeMode(false);
      }
      router.refresh();
    } catch {
      setForwardError("Network error");
    } finally {
      setSavingForward(false);
    }
  }

  async function toggleSafeMode(next: boolean) {
    setModeError(null);

    if (next) {
      if (!hasForward) {
        setModeError("Set a forwarding phone number first.");
        phoneInputRef.current?.focus();
        return;
      }
      if (
        !window.confirm(
          `Turn on Safe Mode? Customer SMS and voice calls will be forwarded to ${forwardTo}. Your AI coworker will not reply.`
        )
      ) {
        return;
      }
    }

    setTogglingMode(true);
    try {
      const res = await fetch("/api/business/safe-mode", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, enabled: next })
      });
      const env = await parseEnvelope<{ safeMode: boolean }>(res);
      if (!env.ok) {
        setModeError(env.error.message);
        if (env.error.code === "VALIDATION_ERROR") {
          phoneInputRef.current?.focus();
        }
        return;
      }
      setSafeMode(env.data.safeMode);
      router.refresh();
    } catch {
      setModeError("Network error");
    } finally {
      setTogglingMode(false);
    }
  }

  return (
    <Card className={safeMode ? "border-signal-teal/40 bg-signal-teal/5" : undefined}>
      <div className="flex flex-col gap-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-parchment mb-1">
              {compact ? "Safe mode" : "Safe mode (forward to your phone)"}
            </h2>
            <p className="text-xs text-parchment/50 max-w-xl">
              {compact
                ? "Forward customer SMS and calls to the owner's cell instead of letting the AI reply."
                : "Going on vacation or need a break? Safe mode forwards customer SMS and voice calls to your phone so you can handle them personally. Your dashboard chat stays on."}
            </p>
          </div>
          {safeMode && <Badge variant="pending">On</Badge>}
        </div>

        {/* Forwarding phone */}
        <div className="border-t border-parchment/10 pt-4">
          <div className="flex items-end justify-between gap-3 flex-wrap">
            <div className="flex-1 min-w-[220px]">
              <label className="text-xs font-medium text-parchment/60 uppercase tracking-wider">
                Forwarding phone (E.164)
              </label>
              {editingForward ? (
                <Input
                  ref={phoneInputRef}
                  type="tel"
                  placeholder="+15555550123"
                  value={forwardDraft}
                  onChange={(e) => setForwardDraft(e.target.value)}
                  className="mt-1"
                  error={forwardError ?? undefined}
                />
              ) : (
                <p className="mt-1 text-sm text-parchment font-mono">
                  {forwardTo || <span className="text-parchment/40 font-sans italic">Not set</span>}
                </p>
              )}
            </div>
            {editingForward ? (
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setForwardDraft(forwardTo);
                    setEditingForward(false);
                    setForwardError(null);
                  }}
                  disabled={savingForward}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="primary"
                  onClick={saveForwarding}
                  loading={savingForward}
                >
                  Save
                </Button>
              </div>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => setEditingForward(true)}
              >
                {hasForward ? "Edit" : "Set"}
              </Button>
            )}
          </div>
          {!editingForward && forwardError && (
            <p className="text-xs text-spark-orange mt-2">{forwardError}</p>
          )}
        </div>

        {/* Toggle row */}
        <div className="border-t border-parchment/10 pt-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <p className="text-sm font-medium text-parchment">
              {safeMode ? "Customer channels are forwarding" : "Customer channels use AI"}
            </p>
            <p className="text-xs text-parchment/50 mt-0.5">
              {safeMode
                ? `Inbound SMS and voice calls are forwarded to ${forwardTo}.`
                : "Your AI coworker answers customer SMS and voice calls normally."}
            </p>
            {modeError && <p className="text-xs text-spark-orange mt-2">{modeError}</p>}
          </div>
          <div className="shrink-0">
            {safeMode ? (
              <Button
                type="button"
                size="sm"
                variant="primary"
                loading={togglingMode}
                onClick={() => toggleSafeMode(false)}
              >
                Turn off Safe mode
              </Button>
            ) : (
              <Button
                type="button"
                size="sm"
                variant="secondary"
                loading={togglingMode}
                disabled={!hasForward}
                onClick={() => toggleSafeMode(true)}
                title={hasForward ? undefined : "Set a forwarding phone first."}
              >
                Turn on Safe mode
              </Button>
            )}
          </div>
        </div>
      </div>
    </Card>
  );
}

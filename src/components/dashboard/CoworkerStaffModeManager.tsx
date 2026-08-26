"use client";

/**
 * Settings → Coworker → Staff access.
 *
 * One row per coworker surface: when YOU or a team member reach your
 * coworker there, does it answer you as staff instead of running the
 * customer lead-intake script?
 *
 * The rows are generated from the owner-surface registry, labels and all,
 * so registering a surface renders its switch here without touching this
 * file. Each flip PUTs /api/dashboard/staff-mode, updating optimistically
 * and rolling back on failure, the same shape as CoworkerToolsManager.
 *
 * Off does NOT mean "treat me as a customer". It means the coworker stays
 * quiet on that surface, which is what the SMS flag has always meant.
 */

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { parseEnvelope } from "@/lib/client/api-envelope";
import { OWNER_SURFACES, type OwnerSurfaceKey } from "@/lib/owner-surfaces/registry";

type Props = {
  businessId: string;
  initialModes: Record<OwnerSurfaceKey, boolean>;
};

export function CoworkerStaffModeManager({ businessId, initialModes }: Props) {
  const [modes, setModes] = useState(initialModes);
  const [pendingKey, setPendingKey] = useState<OwnerSurfaceKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleToggle(surfaceKey: OwnerSurfaceKey, next: boolean) {
    const previous = modes[surfaceKey];
    setError(null);
    setPendingKey(surfaceKey);
    setModes((prev) => ({ ...prev, [surfaceKey]: next }));
    try {
      const res = await fetch("/api/dashboard/staff-mode", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, surfaceKey, enabled: next })
      });
      const env = await parseEnvelope<{ enabled: boolean }>(res);
      if (!env.ok) {
        setModes((prev) => ({ ...prev, [surfaceKey]: previous }));
        setError(env.error.message);
        return;
      }
      setModes((prev) => ({ ...prev, [surfaceKey]: env.data.enabled }));
    } catch {
      setModes((prev) => ({ ...prev, [surfaceKey]: previous }));
      setError("Network error saving the staff setting.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-parchment">Staff access</h2>
        <p className="text-xs text-parchment/50 mt-1 max-w-xl">
          When you or a team member reaches your coworker on one of these, it treats you as
          staff, not a customer, so it never runs the lead-intake script. Turn one off and
          your coworker simply stays quiet there; it will never answer you as a customer
          instead.
        </p>
      </div>

      {error && (
        <p
          className="mb-3 rounded-md border border-spark-orange/40 bg-spark-orange/10 px-3 py-2 text-xs text-spark-orange"
          role="alert"
        >
          {error}
        </p>
      )}

      <ul className="divide-y divide-parchment/10">
        {OWNER_SURFACES.map((surface) => {
          const enabled = modes[surface.key] ?? true;
          const busy = pendingKey === surface.key;
          return (
            <li
              key={surface.key}
              className="py-3 flex items-start justify-between gap-4"
            >
              <div className="min-w-0">
                <p className="text-sm text-parchment">{surface.label}</p>
                <p className="text-xs text-parchment/50 mt-0.5">{surface.description}</p>
              </div>
              <div className="shrink-0 pt-0.5">
                <button
                  type="button"
                  role="switch"
                  aria-checked={enabled}
                  aria-label={`${surface.label}: staff access ${enabled ? "enabled" : "disabled"}`}
                  disabled={busy}
                  onClick={() => handleToggle(surface.key, !enabled)}
                  className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                    enabled ? "bg-claw-green" : "bg-parchment/20"
                  }`}
                >
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-deep-ink transition-transform ${
                      enabled ? "translate-x-6" : "translate-x-1"
                    }`}
                  />
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

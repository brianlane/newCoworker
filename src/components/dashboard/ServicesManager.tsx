"use client";

/**
 * Structured services catalog editor (Settings → Business → Services).
 *
 * BizBlasts-inspired: name / duration / price / active per service. The
 * catalog renders into the coworker's grounding (profile_md), so the agent
 * quotes exact prices and books calendar slots with the real appointment
 * length instead of a guessed 30 minutes.
 */

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

type ServiceItem = {
  id: string;
  name: string;
  description: string;
  duration_minutes: number | null;
  price_text: string;
  active: boolean;
};

const inputClass =
  "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none";
const labelClass = "block text-xs font-medium text-parchment/60 mb-1";

export function ServicesManager() {
  const [services, setServices] = useState<ServiceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");
  const [duration, setDuration] = useState("");
  const [price, setPrice] = useState("");
  const [description, setDescription] = useState("");

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/account/services", { cache: "no-store" });
      const json = (await res.json()) as { ok: boolean; data?: { services?: ServiceItem[] } };
      if (json.ok && json.data?.services) setServices(json.data.services);
    } catch {
      /* keep the last list */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function addService() {
    if (!name.trim()) {
      setError("Give the service a name.");
      return;
    }
    const durationMinutes = duration.trim() ? Number(duration) : null;
    if (durationMinutes !== null && (!Number.isInteger(durationMinutes) || durationMinutes < 5)) {
      setError("Duration must be a whole number of minutes (5 or more).");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const res = await fetch("/api/account/services", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() || undefined,
          durationMinutes,
          priceText: price.trim() || undefined
        })
      });
      const json = (await res.json()) as { ok: boolean; error?: { message?: string } };
      if (!json.ok) {
        setError(json.error?.message ?? "Could not add the service");
        return;
      }
      setName("");
      setDuration("");
      setPrice("");
      setDescription("");
      await refresh();
    } catch {
      setError("Could not add the service — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function toggleActive(service: ServiceItem) {
    try {
      await fetch("/api/account/services", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: service.id, active: !service.active })
      });
      await refresh();
    } catch {
      /* stays as-is */
    }
  }

  async function removeService(service: ServiceItem) {
    if (!window.confirm(`Remove "${service.name}" from your services?`)) return;
    try {
      await fetch("/api/account/services", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: service.id })
      });
      await refresh();
    } catch {
      /* stays as-is */
    }
  }

  return (
    <Card>
      <h2 className="text-lg font-semibold text-parchment">Services</h2>
      <p className="mt-1 text-sm text-parchment/50">
        List what you offer with duration and price. Your coworker quotes these exact prices and
        books appointments with the right length on every channel.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-4">
        <div className="sm:col-span-2">
          <label className={labelClass}>Service name</label>
          <input
            className={inputClass}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="60-minute massage"
          />
        </div>
        <div>
          <label className={labelClass}>Duration (minutes, optional)</label>
          <input
            className={inputClass}
            inputMode="numeric"
            value={duration}
            onChange={(e) => setDuration(e.target.value)}
            placeholder="60"
          />
        </div>
        <div>
          <label className={labelClass}>Price (optional)</label>
          <input
            className={inputClass}
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            placeholder="$99 / from $80"
          />
        </div>
        <div className="sm:col-span-3">
          <label className={labelClass}>Description (optional)</label>
          <input
            className={inputClass}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Deep-tissue massage with hot towels"
          />
        </div>
        <div className="flex items-end">
          <Button type="button" variant="primary" size="sm" onClick={addService} loading={saving}>
            Add service
          </Button>
        </div>
      </div>
      {error ? (
        <p className="mt-2 text-xs text-spark-orange" role="alert">
          {error}
        </p>
      ) : null}

      <div className="mt-5 space-y-2">
        {loading ? (
          <p className="text-sm text-parchment/40">Loading services…</p>
        ) : services.length === 0 ? (
          <p className="text-sm text-parchment/40">No services yet.</p>
        ) : (
          services.map((s) => (
            <div
              key={s.id}
              className="flex flex-wrap items-center gap-2 rounded-md border border-parchment/10 p-3"
            >
              <span className={`text-sm font-medium ${s.active ? "text-parchment" : "text-parchment/40 line-through"}`}>
                {s.name}
              </span>
              {s.duration_minutes ? (
                <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                  {s.duration_minutes} min
                </span>
              ) : null}
              {s.price_text ? (
                <span className="rounded border border-parchment/20 px-1.5 py-0.5 text-[11px] text-parchment/50">
                  {s.price_text}
                </span>
              ) : null}
              {s.description ? (
                <span className="text-xs text-parchment/45">{s.description}</span>
              ) : null}
              <span className="ml-auto flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => void toggleActive(s)}
                  className="text-[11px] text-signal-teal hover:underline"
                >
                  {s.active ? "Deactivate" : "Activate"}
                </button>
                <button
                  type="button"
                  onClick={() => void removeService(s)}
                  className="text-[11px] text-spark-orange/80 hover:text-spark-orange"
                >
                  Remove
                </button>
              </span>
            </div>
          ))
        )}
      </div>
    </Card>
  );
}

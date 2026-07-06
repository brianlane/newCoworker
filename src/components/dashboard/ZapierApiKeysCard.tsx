"use client";

/**
 * "Zapier & API access" card for /dashboard/integrations.
 *
 * Owners mint the `nck_…` API key here and paste it into Zapier (or any
 * other client of the public REST API). The plaintext is shown EXACTLY
 * once — the server stores only a SHA-256 hash — so the card keeps the
 * fresh key on screen with a copy button until the owner dismisses it.
 *
 * Also renders a read-only list of active webhook subscriptions (the REST
 * hooks Zapier creates when a Zap is switched on) so an owner can see
 * which Zaps are listening without leaving the dashboard.
 *
 * API contract:
 *   - GET    /api/dashboard/api-keys?businessId=…  (list)
 *   - POST   /api/dashboard/api-keys               (mint; returns plaintext once)
 *   - DELETE /api/dashboard/api-keys/[id]          (revoke)
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type ApiKeyItem = {
  id: string;
  name: string;
  key_prefix: string;
  created_at: string;
  last_used_at: string | null;
};

type HookItem = {
  id: string;
  event: string;
  target_url: string;
  created_at: string;
};

type Props = {
  businessId: string;
  initialKeys: ApiKeyItem[];
  activeHooks: HookItem[];
};

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric"
  });
}

export function ZapierApiKeysCard({ businessId, initialKeys, activeHooks }: Props) {
  const [keys, setKeys] = useState<ApiKeyItem[]>(initialKeys);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);
  const [newKeyName, setNewKeyName] = useState("");
  const [freshKey, setFreshKey] = useState<{ plaintext: string; name: string } | null>(null);
  const [copied, setCopied] = useState(false);

  async function mint() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/dashboard/api-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          name: newKeyName.trim() || "Zapier"
        })
      });
      const json = (await res.json()) as
        | {
            ok: true;
            data: ApiKeyItem & { plaintext: string };
          }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setError(json.error.message);
        return;
      }
      const { plaintext, ...row } = json.data;
      setKeys((prev) => [{ ...row, last_used_at: null }, ...prev]);
      setFreshKey({ plaintext, name: row.name });
      setCopied(false);
      setNewKeyName("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setError(null);
    setRevokingId(id);
    try {
      const res = await fetch(`/api/dashboard/api-keys/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error: { message: string } }
        | null;
      if (!json || json.ok === false) {
        setError(json?.ok === false ? json.error.message : "Could not revoke");
        return;
      }
      setKeys((prev) => prev.filter((k) => k.id !== id));
    } finally {
      setRevokingId(null);
    }
  }

  async function copyFreshKey() {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey.plaintext);
      setCopied(true);
    } catch {
      // Clipboard API can be denied; the key is selectable text either way.
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-parchment">Zapier &amp; API access</h3>
          <p className="text-xs text-parchment/50 mt-1">
            Create an API key and paste it into Zapier to connect your coworker
            to 7,000+ apps: trigger Zaps on new texts, calls, and emails, or
            send texts from other tools.
          </p>
        </div>
      </div>

      {freshKey ? (
        <div className="mt-3 rounded-md border border-signal-teal/40 bg-signal-teal/5 p-3 space-y-2">
          <p className="text-xs text-parchment/80">
            Your new key <span className="font-medium">{freshKey.name}</span> is ready; copy it
            now, it won&apos;t be shown again:
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 break-all text-xs text-signal-teal bg-deep-ink/60 rounded px-2 py-1.5 font-mono select-all">
              {freshKey.plaintext}
            </code>
            <Button type="button" variant="secondary" size="sm" onClick={copyFreshKey}>
              {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setFreshKey(null)}
            >
              Done
            </Button>
          </div>
        </div>
      ) : null}

      {keys.length > 0 ? (
        <ul className="divide-y divide-parchment/10 mt-3">
          {keys.map((k) => (
            <li key={k.id} className="py-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-parchment/90 font-medium">{k.name}</span>
                  <code className="text-[11px] text-parchment/50 font-mono">
                    {k.key_prefix}…
                  </code>
                </div>
                <p className="text-xs text-parchment/45 mt-0.5">
                  Created {formatDate(k.created_at)}
                  {k.last_used_at
                    ? ` · last used ${formatDate(k.last_used_at)}`
                    : " · never used"}
                </p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => revoke(k.id)}
                loading={revokingId === k.id}
              >
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-parchment/45 mt-3">
          No API keys yet. Create one below to connect Zapier.
        </p>
      )}

      <div className="mt-4 flex items-end gap-2 border-t border-parchment/10 pt-4">
        <label className="flex flex-col gap-1 flex-1 min-w-0">
          <span className="text-xs text-parchment/70">Key name</span>
          <input
            type="text"
            maxLength={80}
            placeholder="Zapier"
            value={newKeyName}
            onChange={(e) => setNewKeyName(e.target.value)}
            className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
          />
        </label>
        <Button type="button" variant="primary" size="sm" onClick={mint} loading={busy}>
          Create key
        </Button>
      </div>

      {error ? (
        <p className="text-xs text-spark-orange mt-2" role="alert">
          {error}
        </p>
      ) : null}

      {activeHooks.length > 0 ? (
        <div className="mt-4 border-t border-parchment/10 pt-4">
          <h4 className="text-xs font-semibold text-parchment/60 uppercase tracking-wider">
            Active Zap triggers
          </h4>
          <ul className="mt-2 space-y-1.5">
            {activeHooks.map((h) => (
              <li key={h.id} className="text-xs text-parchment/60 flex items-center gap-2">
                <span className="text-[10px] uppercase tracking-wider text-parchment/45 border border-parchment/15 rounded px-1 py-0.5 shrink-0">
                  {h.event}
                </span>
                <span className="truncate">{h.target_url}</span>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-parchment/40 mt-2">
            These are managed automatically by Zapier when you turn Zaps on or off.
          </p>
        </div>
      ) : null}
    </Card>
  );
}

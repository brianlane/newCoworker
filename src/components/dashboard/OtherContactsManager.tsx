"use client";

import { useState } from "react";
import { Card } from "@/components/ui/Card";

export type ContactRow = {
  e164: string;
  name: string;
  email: string | null;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialContacts: ContactRow[];
};

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

/**
 * Manage "other contacts" — people/businesses we work with who aren't an
 * employee or a customer (a Clever rep, a title company, a vendor). Backed by
 * contact_overrides: a number + a display name (+ optional email to link their
 * address), which also relabels that number anywhere it shows in the dashboard.
 */
export function OtherContactsManager({ businessId, initialContacts }: Props) {
  const [contacts, setContacts] = useState<ContactRow[]>(initialContacts);
  const [addOpen, setAddOpen] = useState(false);
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const qs = `businessId=${encodeURIComponent(businessId)}`;

  async function refresh() {
    const res = await fetch(`/api/dashboard/contacts?${qs}`, { cache: "no-store" });
    if (!res.ok) return;
    const json = (await res.json()) as { ok: boolean; data?: { contacts: ContactRow[] } };
    if (json.ok && json.data) setContacts(json.data.contacts);
  }

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/contacts?${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          e164: number.trim(),
          name: name.trim(),
          ...(email.trim() ? { email: email.trim() } : {})
        })
      });
      if (!res.ok) throw new Error(await readError(res));
      setName("");
      setNumber("");
      setEmail("");
      setAddOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(e164: string) {
    if (!window.confirm(`Remove this contact?\n\n${e164}`)) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/dashboard/contacts?${qs}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ e164 })
      });
      if (!res.ok) throw new Error(await readError(res));
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-sm font-semibold text-parchment">
            Other contacts ({contacts.length})
          </h2>
          <p className="text-xs text-parchment/50 mt-0.5">
            People and businesses you work with who aren&apos;t employees or
            customers — they show by name wherever their number appears.
          </p>
        </div>
        {!addOpen && (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="rounded-lg border border-parchment/20 text-parchment/80 px-3 py-1.5 text-sm hover:bg-parchment/5 transition-colors shrink-0"
          >
            Add contact
          </button>
        )}
      </div>

      {error && <p className="text-xs text-red-300">{error}</p>}

      {addOpen && (
        <Card>
          <h3 className="text-sm font-semibold text-parchment mb-3">New contact</h3>
          <div className="grid gap-3 sm:grid-cols-3">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value.slice(0, 120))}
              placeholder="Name (e.g. Clever — Jane)"
              className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
            />
            <input
              type="tel"
              value={number}
              onChange={(e) => setNumber(e.target.value.slice(0, 16))}
              placeholder="+16025551234 or short code"
              className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60 font-mono"
            />
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value.slice(0, 254))}
              placeholder="Email (optional)"
              className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
            />
          </div>
          <div className="flex items-center gap-3 mt-3">
            <button
              type="button"
              onClick={add}
              disabled={busy || !name.trim() || !number.trim()}
              className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {busy ? "Saving…" : "Add"}
            </button>
            <button
              type="button"
              onClick={() => {
                setName("");
                setNumber("");
                setEmail("");
                setAddOpen(false);
              }}
              disabled={busy}
              className="rounded-lg border border-parchment/20 text-parchment/70 px-4 py-2 text-sm hover:bg-parchment/5 transition-colors disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </Card>
      )}

      {contacts.length === 0 ? (
        !addOpen && (
          <Card>
            <p className="text-xs text-parchment/50 text-center py-4">
              No other contacts yet.
            </p>
          </Card>
        )
      ) : (
        <Card padding="sm">
          <ul className="divide-y divide-parchment/10">
            {contacts.map((c) => (
              <li
                key={c.e164}
                className="flex items-center justify-between gap-4 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-parchment truncate">
                      {c.name}
                    </span>
                    <span className="text-xs text-parchment/50 font-mono">{c.e164}</span>
                  </div>
                  {c.email && (
                    <p className="text-xs text-parchment/50 mt-0.5 truncate">{c.email}</p>
                  )}
                </div>
                <button
                  type="button"
                  onClick={() => remove(c.e164)}
                  disabled={busy}
                  className="text-red-300/80 hover:text-red-300 transition-colors disabled:opacity-40 text-xs shrink-0"
                  title="Remove contact"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";

type Props = { businessId: string };

type ApiError = { error?: { message?: string } };

async function readError(res: Response): Promise<string> {
  const json = (await res.json().catch(() => null)) as ApiError | null;
  return json?.error?.message || `HTTP ${res.status}`;
}

/** Owner-settable contact types (owner/employee are derived from their own
 * tables, so they aren't offered here). */
const ADDABLE_TYPES = ["customer", "tester", "company", "other"] as const;

/**
 * Manual "Add contact" form for the unified contacts index. Customers are
 * normally auto-created on the first SMS/voice interaction; this lets the owner
 * seed any contact ahead of time with a type (customer, tester, company, other),
 * optionally linking an email so the profile spans channels. On success it
 * refreshes the server-rendered list.
 */
export function AddCustomerForm({ businessId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [note, setNote] = useState("");
  const [type, setType] = useState<(typeof ADDABLE_TYPES)[number]>("customer");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function reset() {
    setName("");
    setPhone("");
    setEmail("");
    setNote("");
    setType("customer");
    setError(null);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            customerE164: phone.trim(),
            type,
            ...(name.trim() ? { displayName: name.trim() } : {}),
            ...(email.trim() ? { email: email.trim() } : {}),
            ...(note.trim() ? { pinnedMd: note.trim() } : {})
          })
        }
      );
      if (!res.ok) throw new Error(await readError(res));
      reset();
      setOpen(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  if (!open) {
    return (
      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors"
        >
          Add contact
        </button>
      </div>
    );
  }

  return (
    <Card>
      <h3 className="text-sm font-semibold text-parchment mb-3">New contact</h3>
      {error && <p className="text-xs text-red-300 mb-3">{error}</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 120))}
          placeholder="Name"
          className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
        />
        <input
          type="tel"
          value={phone}
          onChange={(e) => setPhone(e.target.value.slice(0, 24))}
          placeholder="(305) 613-3412 or short code"
          className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60 font-mono"
        />
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value.slice(0, 254))}
          placeholder="Email (optional)"
          className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
        />
        <select
          value={type}
          onChange={(e) => setType(e.target.value as (typeof ADDABLE_TYPES)[number])}
          className="bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment focus:outline-none focus:border-claw-green/60"
          aria-label="Contact type"
        >
          {ADDABLE_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value.slice(0, 4000))}
        placeholder="Pinned note (optional) — sticks across every future SMS or call"
        rows={2}
        className="mt-3 w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
      />
      <div className="flex items-center gap-3 mt-3">
        <button
          type="button"
          onClick={save}
          disabled={saving || !phone.trim()}
          className="rounded-lg bg-claw-green text-deep-ink px-4 py-2 text-sm font-semibold hover:bg-opacity-90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {saving ? "Saving…" : "Add"}
        </button>
        <button
          type="button"
          onClick={() => {
            reset();
            setOpen(false);
          }}
          disabled={saving}
          className="rounded-lg border border-parchment/20 text-parchment/70 px-4 py-2 text-sm hover:bg-parchment/5 transition-colors disabled:opacity-40"
        >
          Cancel
        </button>
      </div>
    </Card>
  );
}

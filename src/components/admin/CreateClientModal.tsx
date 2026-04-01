"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

type Tier = "starter" | "standard" | "enterprise";

export function CreateClientModal() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [ownerEmail, setOwnerEmail] = useState("");
  const [tier, setTier] = useState<Tier>("starter");
  const [ownerName, setOwnerName] = useState("");
  const [phone, setPhone] = useState("");
  const [businessType, setBusinessType] = useState("");

  function reset() {
    setName("");
    setOwnerEmail("");
    setTier("starter");
    setOwnerName("");
    setPhone("");
    setBusinessType("");
    setError(null);
  }

  function handleClose() {
    setOpen(false);
    reset();
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch("/api/admin/create-client", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, ownerEmail, tier, ownerName, phone, businessType })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Failed to create client");
        return;
      }
      handleClose();
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>+ New Client</Button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-deep-ink/80 backdrop-blur-sm"
            onClick={handleClose}
          />
          <div className="relative z-10 w-full max-w-md bg-deep-ink border border-parchment/15 rounded-xl shadow-2xl p-6">
            <div className="flex items-center justify-between mb-5">
              <h2 className="text-lg font-bold text-parchment">New Client</h2>
              <button
                onClick={handleClose}
                className="text-parchment/40 hover:text-parchment text-xl leading-none"
              >
                ×
              </button>
            </div>

            <form onSubmit={handleSubmit} className="space-y-4">
              <Input
                label="Business Name"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Acme Roofing"
                autoComplete="off"
              />
              <Input
                label="Owner Email"
                type="email"
                required
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="owner@example.com"
                autoComplete="off"
              />

              <div className="flex flex-col gap-1">
                <label className="text-sm font-medium text-parchment/80">Plan</label>
                <div className="flex gap-2">
                  {(["starter", "standard", "enterprise"] as Tier[]).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setTier(t)}
                      className={[
                        "flex-1 rounded-lg border px-3 py-2 text-xs font-medium capitalize transition-colors",
                        tier === t
                          ? "border-signal-teal bg-signal-teal/15 text-signal-teal"
                          : "border-parchment/20 text-parchment/50 hover:border-parchment/40"
                      ].join(" ")}
                    >
                      {t}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <Input
                  label="Owner Name"
                  value={ownerName}
                  onChange={(e) => setOwnerName(e.target.value)}
                  placeholder="Jane Smith"
                  autoComplete="off"
                />
                <Input
                  label="Phone"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+1 555 000 0000"
                  autoComplete="off"
                />
              </div>

              <Input
                label="Business Type"
                value={businessType}
                onChange={(e) => setBusinessType(e.target.value)}
                placeholder="Roofing, HVAC, Plumbing…"
                autoComplete="off"
              />

              {error && <p className="text-xs text-spark-orange">{error}</p>}

              <div className="flex gap-3 pt-1">
                <Button
                  type="button"
                  variant="secondary"
                  className="flex-1"
                  onClick={handleClose}
                >
                  Cancel
                </Button>
                <Button type="submit" className="flex-1" loading={loading}>
                  Create Client
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}

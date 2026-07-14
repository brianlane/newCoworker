"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import {
  BUSINESS_TYPE_OPTIONS,
  BUSINESS_TYPE_OTHER_VALUE,
  deriveBusinessTypeSelection,
  serializeBusinessTypeSelection
} from "@/lib/onboarding/businessTypes";

type Tier = "starter" | "standard" | "enterprise";
type VpsSize = "kvm1" | "kvm2" | "kvm4" | "kvm8";

const VPS_SIZE_OPTIONS: Array<{ value: VpsSize | ""; label: string }> = [
  { value: "", label: "Default (KVM 8)" },
  { value: "kvm2", label: "KVM 2: 2 vCPU / 8GB" },
  { value: "kvm4", label: "KVM 4: 4 vCPU / 16GB" },
  { value: "kvm8", label: "KVM 8: 8 vCPU / 32GB" }
];

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
  const [vpsSize, setVpsSize] = useState<VpsSize | "">("");

  function reset() {
    setName("");
    setOwnerEmail("");
    setTier("starter");
    setOwnerName("");
    setPhone("");
    setBusinessType("");
    setVpsSize("");
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
        body: JSON.stringify({
          name,
          ownerEmail,
          tier,
          ownerName,
          phone,
          businessType,
          // Hardware pin is an enterprise-deal knob; other tiers always
          // provision on the tier default.
          ...(tier === "enterprise" && vpsSize ? { vpsSize } : {})
        })
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-deep-ink/80 backdrop-blur-sm"
            onClick={handleClose}
          />
          <div className="relative z-10 w-full max-w-md max-h-[90vh] overflow-y-auto bg-deep-ink border border-parchment/15 rounded-xl shadow-2xl p-5 sm:p-6">
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

              {tier === "enterprise" && (
                <div className="flex flex-col gap-1">
                  <label
                    htmlFor="create-client-vps-size"
                    className="text-sm font-medium text-parchment/80"
                  >
                    VPS Size
                  </label>
                  <select
                    id="create-client-vps-size"
                    value={vpsSize}
                    onChange={(e) => setVpsSize(e.target.value as VpsSize | "")}
                    className="rounded-lg border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment focus:border-signal-teal focus:outline-none"
                  >
                    {VPS_SIZE_OPTIONS.map((opt) => (
                      <option key={opt.value || "default"} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-parchment/40">
                    Hardware pin for the enterprise box; leave on Default for KVM 8.
                  </p>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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

              <div className="flex flex-col gap-1">
                <label
                  htmlFor="create-client-business-type"
                  className="text-sm font-medium text-parchment/80"
                >
                  Business Type
                </label>
                <select
                  id="create-client-business-type"
                  value={deriveBusinessTypeSelection(businessType).selection}
                  onChange={(e) => {
                    const { otherText } = deriveBusinessTypeSelection(businessType);
                    setBusinessType(serializeBusinessTypeSelection(e.target.value, otherText));
                  }}
                  className="rounded-lg border border-parchment/20 bg-deep-ink px-3 py-2 text-sm text-parchment focus:border-signal-teal focus:outline-none"
                >
                  <option value="">Select an industry…</option>
                  {BUSINESS_TYPE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
              {deriveBusinessTypeSelection(businessType).selection === BUSINESS_TYPE_OTHER_VALUE && (
                <Input
                  label="What kind of business?"
                  value={deriveBusinessTypeSelection(businessType).otherText}
                  onChange={(e) =>
                    setBusinessType(
                      serializeBusinessTypeSelection(BUSINESS_TYPE_OTHER_VALUE, e.target.value)
                    )
                  }
                  maxLength={120}
                  placeholder="e.g. Drone Photography, Notary Services"
                  autoComplete="off"
                />
              )}

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

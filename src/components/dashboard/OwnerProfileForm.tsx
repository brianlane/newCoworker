"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { Button } from "@/components/ui/Button";

type Status = { kind: "idle" | "saving" | "success" | "error"; message?: string };

/**
 * Settings → Your profile: the owner's display name and contact phone.
 * Both already seed notification contacts and provisioning; this surfaces
 * them for editing (previously capture-once at onboarding).
 */
export function OwnerProfileForm({
  initialOwnerName,
  initialPhone
}: {
  initialOwnerName: string | null;
  initialPhone: string | null;
}) {
  const router = useRouter();
  const [ownerName, setOwnerName] = useState(initialOwnerName ?? "");
  const [phone, setPhone] = useState(initialPhone ?? "");
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/account/owner-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ownerName: ownerName.trim(), phone: phone.trim() })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        setStatus({
          kind: "error",
          message: body?.error?.message ?? "Something went wrong. Please try again."
        });
        return;
      }
      setStatus({ kind: "success", message: "Profile updated." });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Your profile</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Your name and phone number — used for alerts and as the human callback line your
        coworker can hand off to.
      </p>
      <form onSubmit={save} className="space-y-3">
        <Input
          label="Your name"
          value={ownerName}
          onChange={(e) => setOwnerName(e.target.value)}
          maxLength={120}
          placeholder="Alex Rivera"
        />
        <Input
          label="Phone"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          maxLength={40}
          placeholder="+1 602 555 0147"
        />
        <div className="flex items-center gap-3">
          <Button type="submit" size="sm" loading={status.kind === "saving"}>
            Save
          </Button>
          {status.kind === "success" && (
            <p className="text-xs text-claw-green">{status.message}</p>
          )}
          {status.kind === "error" && (
            <p className="text-xs text-spark-orange">{status.message}</p>
          )}
        </div>
      </form>
    </Card>
  );
}

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
 *
 * The owner phone lives in three columns edited on three different pages
 * (this card, the Notifications alert phone, the Safe Mode forwarding
 * cell); the "also update" checkbox asks the API to move the other two
 * with this save when they still hold the old number, so a phone change
 * can never half-apply. The save response may carry a deliverability
 * warning (number outside the account's texting-line coverage), shown
 * inline without blocking the save.
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
  const [syncLinked, setSyncLinked] = useState(true);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [warning, setWarning] = useState<string | null>(null);

  async function save(e: FormEvent) {
    e.preventDefault();
    setStatus({ kind: "saving" });
    setWarning(null);
    try {
      const res = await fetch("/api/account/owner-profile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ownerName: ownerName.trim(),
          phone: phone.trim(),
          syncLinkedNumbers: syncLinked
        })
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
      const body = (await res.json().catch(() => null)) as {
        data?: {
          phone?: string | null;
          syncedAlertPhone?: boolean;
          syncedForwardingPhone?: boolean;
          warning?: string | null;
        };
      } | null;
      const data = body?.data;
      // Reflect the server's canonical E.164 so the field shows what was
      // actually stored (e.g. "602 555 0147" became "+16025550147").
      if (typeof data?.phone === "string") setPhone(data.phone);
      const syncedBits = [
        data?.syncedAlertPhone ? "alert phone" : null,
        data?.syncedForwardingPhone ? "forwarding number" : null
      ].filter(Boolean);
      setStatus({
        kind: "success",
        message:
          syncedBits.length > 0
            ? `Profile updated; ${syncedBits.join(" and ")} updated to match.`
            : "Profile updated."
      });
      setWarning(data?.warning ?? null);
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
        <label className="flex items-start gap-2 text-xs text-parchment/60">
          <input
            type="checkbox"
            checked={syncLinked}
            onChange={(e) => setSyncLinked(e.target.checked)}
            className="mt-0.5 accent-claw-green"
          />
          <span>
            Also update my alert phone and call-forwarding number if they still match the
            old one, so nothing keeps texting or forwarding to a number I no longer use.
          </span>
        </label>
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
        {warning && (
          <p className="text-xs text-spark-orange" role="alert">
            {warning}
          </p>
        )}
      </form>
    </Card>
  );
}

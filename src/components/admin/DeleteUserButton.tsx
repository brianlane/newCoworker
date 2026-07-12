"use client";

/**
 * Admin "delete account completely" button (the BizBlasts users-admin
 * delete). Two-step confirm with a typed-email gate — this hard-deletes the
 * auth user, every owned business (content cascades with the rows), and the
 * email's membership grants. The API refuses accounts with live Stripe
 * billing, so a paying tenant can't be nuked this way by accident.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";

export function DeleteUserButton({
  email,
  ownedBusinessCount
}: {
  email: string;
  ownedBusinessCount: number;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/delete-user", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error?.message ?? "Delete failed");
      } else {
        router.push("/admin/engagement");
        router.refresh();
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }

  if (!confirming) {
    return (
      <Button size="sm" variant="danger" onClick={() => setConfirming(true)}>
        Delete account completely
      </Button>
    );
  }

  return (
    <div className="space-y-2 max-w-md">
      <p className="text-xs text-spark-orange">
        Permanently delete <strong>{email}</strong>
        {ownedBusinessCount > 0 && (
          <>
            {" "}
            and {ownedBusinessCount === 1 ? "its business" : `all ${ownedBusinessCount} of its businesses`}
          </>
        )}
        ? The login, business rows, and all tenant data are removed with no backup and no grace
        period. This cannot be undone. Type the email to confirm.
      </p>
      <input
        type="text"
        value={typed}
        onChange={(e) => setTyped(e.target.value)}
        placeholder={email}
        aria-label="Type the email to confirm deletion"
        className="w-full rounded-md border border-parchment/20 bg-deep-ink px-2.5 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:outline-none focus:ring-1 focus:ring-spark-orange"
      />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          onClick={handleDelete}
          loading={loading}
          disabled={typed.trim().toLowerCase() !== email.toLowerCase()}
        >
          Confirm permanent delete
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => {
            setConfirming(false);
            setTyped("");
            setError(null);
          }}
        >
          Back
        </Button>
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

/**
 * Settings -> Account, shown ONLY while an admin is viewing as a tenant: the
 * two support actions that act on the TENANT's login.
 *
 * It exists as its own card precisely because the neighbouring password and
 * passkey cards are session-scoped and act on the OPERATOR (they carry an
 * OwnLoginNotice saying so). Splitting "yours" from "theirs" into separate
 * cards is what keeps the page honest; a single card with a mode toggle is how
 * an operator resets the wrong account.
 *
 * Two asymmetries worth knowing before editing this:
 *
 *   * Password is a RESET, never a set. The tenant chooses the new password
 *     from their own inbox, so it is never spoken aloud on a support call and
 *     the operator never holds a live customer credential.
 *   * Passkeys can be listed and removed but NEVER added. A passkey is minted
 *     by the tenant's own authenticator and the private half never leaves
 *     their device, so there is no admin API to create one and there could not
 *     be. The card says so rather than leaving an operator hunting for a
 *     missing button.
 */

type TenantPasskey = {
  id: string;
  friendlyName: string | null;
  createdAt: string;
  lastUsedAt: string | null;
};

type Status = { kind: "idle" | "busy" | "ok" | "error"; message?: string };

export function TenantCredentialsCard({ tenantEmail }: { tenantEmail: string }) {
  const t = useTranslations("dashboard.settings");
  const [resetStatus, setResetStatus] = useState<Status>({ kind: "idle" });
  const [passkeys, setPasskeys] = useState<TenantPasskey[] | null>(null);
  const [passkeyStatus, setPasskeyStatus] = useState<Status>({ kind: "idle" });
  const [removingId, setRemovingId] = useState<string | null>(null);

  const loadPasskeys = useCallback(async () => {
    try {
      const res = await fetch("/api/account/passkeys");
      if (!res.ok) {
        // A tenant with no login (pending owner_email) 404s here. Render the
        // empty state rather than an error: there is nothing wrong, there is
        // just nothing to show.
        setPasskeys([]);
        return;
      }
      const body = (await res.json()) as { data?: { passkeys?: TenantPasskey[] } };
      setPasskeys(body.data?.passkeys ?? []);
    } catch {
      setPasskeys([]);
    }
  }, []);

  useEffect(() => {
    void loadPasskeys();
  }, [loadPasskeys]);

  async function sendReset() {
    setResetStatus({ kind: "busy" });
    try {
      const res = await fetch("/api/account/password-reset", { method: "POST" });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setResetStatus({ kind: "error", message: body.error?.message ?? t("tenantActionFailed") });
        return;
      }
      setResetStatus({ kind: "ok", message: t("tenantResetSent", { email: tenantEmail }) });
    } catch {
      setResetStatus({ kind: "error", message: t("tenantActionFailed") });
    }
  }

  async function removePasskey(passkeyId: string) {
    setRemovingId(passkeyId);
    setPasskeyStatus({ kind: "busy" });
    try {
      const res = await fetch("/api/account/passkeys", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ passkeyId })
      });
      const body = (await res.json()) as { error?: { message?: string } };
      if (!res.ok) {
        setPasskeyStatus({
          kind: "error",
          message: body.error?.message ?? t("tenantActionFailed")
        });
        return;
      }
      setPasskeys((prev) => (prev ?? []).filter((p) => p.id !== passkeyId));
      setPasskeyStatus({ kind: "ok", message: t("tenantPasskeyRemoved") });
    } catch {
      setPasskeyStatus({ kind: "error", message: t("tenantActionFailed") });
    } finally {
      setRemovingId(null);
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">{t("tenantCredentialsTitle")}</h2>
      <p className="text-xs text-parchment/40 mb-4">{t("tenantCredentialsBlurb")}</p>

      <div className="space-y-2 border-t border-parchment/10 pt-4">
        <p className="text-xs text-parchment/50">{t("tenantResetBlurb")}</p>
        <div className="flex items-center gap-3">
          <Button
            type="button"
            size="sm"
            loading={resetStatus.kind === "busy"}
            onClick={sendReset}
          >
            {t("tenantResetButton")}
          </Button>
          {resetStatus.kind === "ok" && (
            <p className="text-xs text-claw-green">{resetStatus.message}</p>
          )}
          {resetStatus.kind === "error" && (
            <p className="text-xs text-spark-orange">{resetStatus.message}</p>
          )}
        </div>
      </div>

      <div className="mt-6 space-y-2 border-t border-parchment/10 pt-4">
        <h3 className="text-xs font-semibold text-parchment/80">{t("tenantPasskeysTitle")}</h3>
        <p className="text-xs text-parchment/50">{t("tenantPasskeysCannotAdd")}</p>

        {passkeys !== null && passkeys.length === 0 && (
          <p className="text-xs text-parchment/40">{t("tenantPasskeysEmpty")}</p>
        )}

        {passkeys !== null && passkeys.length > 0 && (
          <ul className="space-y-2">
            {passkeys.map((p) => (
              <li
                key={p.id}
                className="flex items-center justify-between gap-3 rounded-lg border border-parchment/10 px-3 py-2"
              >
                <span className="text-xs text-parchment/70">
                  {p.friendlyName || p.id.slice(0, 8)}
                  <span className="text-parchment/40">
                    {" "}
                    ({p.lastUsedAt ? new Date(p.lastUsedAt).toLocaleDateString() : t("tenantPasskeyNeverUsed")})
                  </span>
                </span>
                <button
                  type="button"
                  className="text-xs text-spark-orange hover:underline disabled:opacity-50"
                  disabled={removingId === p.id}
                  onClick={() => removePasskey(p.id)}
                >
                  {t("tenantPasskeyRemove")}
                </button>
              </li>
            ))}
          </ul>
        )}

        {passkeyStatus.kind === "ok" && (
          <p className="text-xs text-claw-green">{passkeyStatus.message}</p>
        )}
        {passkeyStatus.kind === "error" && (
          <p className="text-xs text-spark-orange">{passkeyStatus.message}</p>
        )}
      </div>
    </Card>
  );
}

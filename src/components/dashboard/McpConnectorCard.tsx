"use client";

/**
 * The connector card on /dashboard/integrations, for any MCP client.
 *
 * One card serves Claude and ChatGPT because the story is identical: the
 * assistant authenticates as a New Coworker login through OAuth (no key to
 * mint), and once it has made an authorized call ON THIS BUSINESS the card
 * shows Connected with the last-used time and who it belongs to.
 *
 * The stamp is call-time, not consent-time, so a green badge means the WHOLE
 * path works. That distinction was earned: OAuth can succeed while the
 * assistant's tool calls are still being blocked at the edge, and a
 * consent-time badge would have called that connected. The cost is that a
 * connector nobody has used yet reads as not connected, which `notYetHint`
 * exists to explain.
 *
 * State is per business, from any teammate's login. It used to be per login,
 * which showed an admin their own connector on every tenant's dashboard.
 *
 * Generalised from the Claude-only version rather than copied. Copying would
 * have doubled that card's half-finished internationalization, so the strings
 * moved into the catalog on the way through.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

export type McpConnectorCardStatus = {
  firstConnectedAt: string;
  lastSeenAt: string;
  /** No call in MCP_STALE_MS: the only hint we get that it was removed. */
  stale: boolean;
  /** Which teammate's login the assistant is signed in as, when resolved. */
  connectedByEmail: string | null;
};

type Props = {
  /** Which assistant this card is for; picks the copy. */
  client: "claude" | "chatgpt";
  /** The business whose status this card shows and can clear. */
  businessId: string;
  /** Absolute MCP endpoint, e.g. "https://app.example.com/api/mcp". */
  mcpUrl: string;
  /** This business's status for this assistant; null = never used here. */
  status?: McpConnectorCardStatus | null;
};

export function McpConnectorCard({ client, businessId, mcpUrl, status = null }: Props) {
  const t = useTranslations("dashboard.integrationsMcp");
  const router = useRouter();
  const [copied, setCopied] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [banner, setBanner] = useState<string | null>(null);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
    } catch {
      // Clipboard API can be denied; the URL is selectable text either way.
    }
  }

  async function disconnect() {
    setBanner(null);
    setRemoving(true);
    try {
      const res = await fetch("/api/integrations/mcp", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, client })
      });
      const json = (await res.json().catch(() => null)) as {
        data?: { revoked?: number };
        error?: { message?: string };
      } | null;
      if (!res.ok) {
        setBanner(json?.error?.message ?? t("disconnectFailed"));
        return;
      }
      // Say which of the two things happened. Clearing the row always lands;
      // revoking only works on the caller's own grant, so a teammate's
      // assistant keeps its access and will re-light this card on its next
      // call. Claiming a clean disconnect there would be a lie.
      setBanner(
        (json?.data?.revoked ?? 0) > 0
          ? t("disconnectedRevoked", { assistant: t(`${client}.name`) })
          : t("disconnectedClearedOnly", { assistant: t(`${client}.name`) })
      );
      router.refresh();
    } finally {
      setRemoving(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-parchment">{t(`${client}.title`)}</h3>
        {status &&
          (status.stale ? (
            <span className="rounded-full border border-spark-orange/40 bg-spark-orange/10 px-3 py-0.5 text-xs font-medium text-spark-orange">
              {t("quietBadge")}
            </span>
          ) : (
            <span className="rounded-full border border-signal-teal/40 bg-signal-teal/10 px-3 py-0.5 text-xs font-medium text-signal-teal">
              {t("connectedBadge")}
            </span>
          ))}
      </div>
      <p className="text-xs text-parchment/50 mt-1">{t(`${client}.blurb`)}</p>

      {status && (
        <p className="mt-2 text-xs text-parchment/60">
          {t(`${client}.lastUsed`)} <LocalDateTime iso={status.lastSeenAt} />
          {" · "}
          {t("firstConnected")} <LocalDateTime iso={status.firstConnectedAt} />
          {status.connectedByEmail
            ? ` · ${t("connectedBy", { email: status.connectedByEmail })}`
            : ""}
        </p>
      )}

      {status?.stale && <p className="mt-2 text-xs text-spark-orange">{t("quietHint")}</p>}

      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all text-xs text-signal-teal bg-deep-ink/60 rounded px-2 py-1.5 font-mono select-all">
          {mcpUrl}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copyUrl}>
          {copied ? t("copied") : t("copy")}
        </Button>
      </div>

      <ol className="mt-3 space-y-1 text-xs text-parchment/60 list-decimal list-inside">
        <li>{t(`${client}.step1`)}</li>
        <li>{t(`${client}.step2`)}</li>
        <li>{t(`${client}.step3`)}</li>
      </ol>

      {!status && <p className="mt-2 text-xs text-parchment/50">{t("notYetHint")}</p>}

      {status && (
        <div className="mt-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={disconnect}
            loading={removing}
          >
            {t("disconnect")}
          </Button>
        </div>
      )}

      {banner && <p className="mt-2 text-xs text-parchment/70">{banner}</p>}

      <p className="text-[11px] text-parchment/40 mt-2">{t(`${client}.footer`)}</p>
    </Card>
  );
}

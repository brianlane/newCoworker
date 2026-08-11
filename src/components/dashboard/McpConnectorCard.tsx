"use client";

/**
 * The connector card on /dashboard/integrations, for any MCP client.
 *
 * One card serves Claude and ChatGPT because the story is identical: the
 * assistant authenticates as the owner's own New Coworker login through OAuth
 * (no key to mint), and once it has made an authenticated request the card
 * shows Connected with the last-used time.
 *
 * The stamp is request-time, not consent-time, so a green badge means the
 * WHOLE path works. That distinction was earned: OAuth can succeed while the
 * assistant's tool calls are still being blocked at the edge, and a
 * consent-time badge would have called that connected.
 *
 * Generalised from the Claude-only version rather than copied. Copying would
 * have doubled that card's half-finished internationalization, so the strings
 * moved into the catalog on the way through.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

type Props = {
  /** Which assistant this card is for; picks the copy. */
  client: "claude" | "chatgpt";
  /** Absolute MCP endpoint, e.g. "https://app.example.com/api/mcp". */
  mcpUrl: string;
  /** The signed-in user's connection status; null = never connected. */
  status?: { firstConnectedAt: string; lastSeenAt: string } | null;
};

export function McpConnectorCard({ client, mcpUrl, status = null }: Props) {
  const t = useTranslations("dashboard.integrationsMcp");
  const [copied, setCopied] = useState(false);

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(mcpUrl);
      setCopied(true);
    } catch {
      // Clipboard API can be denied; the URL is selectable text either way.
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold text-parchment">{t(`${client}.title`)}</h3>
        {status && (
          <span className="rounded-full border border-signal-teal/40 bg-signal-teal/10 px-3 py-0.5 text-xs font-medium text-signal-teal">
            {t("connectedBadge")}
          </span>
        )}
      </div>
      <p className="text-xs text-parchment/50 mt-1">{t(`${client}.blurb`)}</p>

      {status && (
        <p className="mt-2 text-xs text-parchment/60">
          {t(`${client}.lastUsed`)} <LocalDateTime iso={status.lastSeenAt} />
          {" · "}
          {t("firstConnected")} <LocalDateTime iso={status.firstConnectedAt} />
        </p>
      )}

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
      <p className="text-[11px] text-parchment/40 mt-2">{t(`${client}.footer`)}</p>
    </Card>
  );
}

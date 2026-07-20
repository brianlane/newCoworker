"use client";

/**
 * "Claude connector" card for /dashboard/integrations.
 *
 * The connector authenticates with the owner's own New Coworker login
 * through OAuth (no key to mint here). The card shows the MCP server URL,
 * the add-a-custom-connector steps for claude.ai / Claude Desktop, and —
 * once the signed-in user's Claude has made an authenticated request
 * (`mcp_connector_status`) — a Connected badge with the last-used time.
 * The stamp is request-time, not consent-time, so a green badge means the
 * whole path (OAuth + the WAF allowlist for Anthropic's POSTs) works.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";

type Props = {
  /** Absolute MCP endpoint, e.g. "https://app.example.com/api/mcp". */
  mcpUrl: string;
  /** The signed-in user's connection status; null = never connected. */
  status?: { firstConnectedAt: string; lastSeenAt: string } | null;
};

export function ClaudeConnectorCard({ mcpUrl, status = null }: Props) {
  const t = useTranslations("dashboard.integrationsClaude");
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
        <h3 className="text-sm font-semibold text-parchment">Claude connector</h3>
        {status && (
          <span className="rounded-full border border-signal-teal/40 bg-signal-teal/10 px-3 py-0.5 text-xs font-medium text-signal-teal">
            {t("connectedBadge")}
          </span>
        )}
      </div>
      <p className="text-xs text-parchment/50 mt-1">
        Let Claude work with your coworker: look up contacts, read texts and call
        summaries, send messages, book appointments, and build AiFlows — signed in as you,
        limited to your role.
      </p>

      {status && (
        <p className="mt-2 text-xs text-parchment/60">
          {t("lastUsed")} <LocalDateTime iso={status.lastSeenAt} />
          {" · "}
          {t("firstConnected")} <LocalDateTime iso={status.firstConnectedAt} />
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <code className="flex-1 min-w-0 break-all text-xs text-signal-teal bg-deep-ink/60 rounded px-2 py-1.5 font-mono select-all">
          {mcpUrl}
        </code>
        <Button type="button" variant="secondary" size="sm" onClick={copyUrl}>
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>

      <ol className="mt-3 space-y-1 text-xs text-parchment/60 list-decimal list-inside">
        <li>
          In Claude (claude.ai or the desktop app), open{" "}
          <span className="text-parchment/80">Settings → Connectors → Add custom connector</span>.
        </li>
        <li>Paste the URL above and add the connector.</li>
        <li>
          Click <span className="text-parchment/80">Connect</span> — you&apos;ll sign in with
          your New Coworker account and approve access once.
        </li>
      </ol>
      <p className="text-[11px] text-parchment/40 mt-2">
        Disconnect anytime from Claude&apos;s connector settings; access follows your team
        role, so a staff login can&apos;t manage automations through Claude either.
      </p>
    </Card>
  );
}

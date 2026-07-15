"use client";

/**
 * "Claude connector" card for /dashboard/integrations.
 *
 * Purely informational: the connector authenticates with the owner's own
 * New Coworker login through OAuth (no key to mint here). The card shows
 * the MCP server URL and the add-a-custom-connector steps for claude.ai /
 * Claude Desktop.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type Props = {
  /** Absolute MCP endpoint, e.g. "https://app.example.com/api/mcp". */
  mcpUrl: string;
};

export function ClaudeConnectorCard({ mcpUrl }: Props) {
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
      <h3 className="text-sm font-semibold text-parchment">Claude connector</h3>
      <p className="text-xs text-parchment/50 mt-1">
        Let Claude work with your coworker: look up contacts, read texts and call
        summaries, send messages, book appointments, and build AiFlows — signed in as you,
        limited to your role.
      </p>

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

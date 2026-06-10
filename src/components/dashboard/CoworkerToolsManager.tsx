"use client";

/**
 * Settings → Coworker tools.
 *
 * One card per coworker surface (dashboard chat / phone / texting) listing
 * the tools it can use, with a toggle per configurable tool. State is
 * server-rendered (resolveAgentTools) and each flip PUTs
 * /api/dashboard/agent-tools, updating optimistically and rolling back on
 * failure. Non-configurable tools render a read-only badge — they're
 * declared inside the per-tenant agent runtime and have no platform
 * enforcement point, so pretending they're toggleable would be a lie.
 */

import { useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { parseEnvelope } from "@/lib/client/api-envelope";
import type { ResolvedAgent } from "@/lib/db/agent-tool-settings";

type Props = {
  businessId: string;
  initialAgents: ResolvedAgent[];
};

export function CoworkerToolsManager({ businessId, initialAgents }: Props) {
  const [agents, setAgents] = useState(initialAgents);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function setToolEnabled(agentKey: string, toolKey: string, enabled: boolean) {
    setAgents((prev) =>
      prev.map((agent) =>
        agent.key !== agentKey
          ? agent
          : {
              ...agent,
              tools: agent.tools.map((tool) =>
                tool.toolKey === toolKey ? { ...tool, enabled } : tool
              )
            }
      )
    );
  }

  async function handleToggle(agentKey: string, toolKey: string, next: boolean) {
    const key = `${agentKey}:${toolKey}`;
    setError(null);
    setPendingKey(key);
    setToolEnabled(agentKey, toolKey, next);
    try {
      const res = await fetch("/api/dashboard/agent-tools", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, agentKey, toolKey, enabled: next })
      });
      const env = await parseEnvelope<{ enabled: boolean }>(res);
      if (!env.ok) {
        setToolEnabled(agentKey, toolKey, !next);
        setError(env.error.message);
        return;
      }
      setToolEnabled(agentKey, toolKey, env.data.enabled);
    } catch {
      setToolEnabled(agentKey, toolKey, !next);
      setError("Network error saving the tool setting.");
    } finally {
      setPendingKey(null);
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-parchment">Coworker tools</h2>
        <p className="text-sm text-parchment/50 mt-1">
          What each of your coworker&apos;s surfaces is allowed to do. Changes apply to the next
          conversation turn.
        </p>
      </div>

      {error && (
        <p className="rounded-md border border-spark-orange/40 bg-spark-orange/10 px-3 py-2 text-xs text-spark-orange" role="alert">
          {error}
        </p>
      )}

      {agents.map((agent) => (
        <Card key={agent.key}>
          <div className="mb-3">
            <h3 className="text-sm font-semibold text-parchment">{agent.label}</h3>
            <p className="text-xs text-parchment/50 mt-0.5">{agent.description}</p>
          </div>
          <ul className="divide-y divide-parchment/10">
            {agent.tools.map((tool) => {
              const key = `${agent.key}:${tool.toolKey}`;
              const busy = pendingKey === key;
              return (
                <li key={tool.toolKey} className="py-3 flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <p className="text-sm text-parchment">{tool.label}</p>
                    <p className="text-xs text-parchment/50 mt-0.5">{tool.description}</p>
                  </div>
                  <div className="shrink-0 pt-0.5">
                    {tool.configurable ? (
                      <button
                        type="button"
                        role="switch"
                        aria-checked={tool.enabled}
                        aria-label={`${tool.label} — ${tool.enabled ? "enabled" : "disabled"}`}
                        disabled={busy}
                        onClick={() => handleToggle(agent.key, tool.toolKey, !tool.enabled)}
                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                          tool.enabled ? "bg-claw-green" : "bg-parchment/20"
                        }`}
                      >
                        <span
                          className={`inline-block h-4 w-4 transform rounded-full bg-deep-ink transition-transform ${
                            tool.enabled ? "translate-x-6" : "translate-x-1"
                          }`}
                        />
                      </button>
                    ) : (
                      <Badge variant={tool.enabled ? "online" : "neutral"}>
                        {tool.enabled ? "Always on" : "Off"}
                      </Badge>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Card>
      ))}
    </div>
  );
}

/**
 * Find tools an owner turned OFF on one channel that are still ON elsewhere.
 *
 * `agent_tool_settings` is keyed `(business_id, agent_key, tool_key)`, and a
 * MISSING row means "use the registry default", not "off". So a policy set on
 * one surface reaches only that surface, and nothing in the product says so.
 *
 * Amy Laidlaw Real Estate, Jul 29 to Aug 3 2026, is the case this exists for.
 * `patch-amy-sms-handoff-and-emoji.ts` decided the account nurtures and hands
 * off rather than books, and enforced it by disabling the five calendar tools
 * for `agent_key = 'sms'`. Voice never got those rows, so it kept the registry
 * default (enabled) and the phone coworker went on booking for five more days
 * until a customer call surfaced it.
 *
 * Direction matters. We report explicitly-OFF-somewhere / still-ON-elsewhere
 * and not the reverse, because those are not symmetric risks: a tool left off
 * does nothing, while a tool left on keeps taking real actions the owner
 * believes they stopped. And we key on an EXPLICIT off rather than an
 * effective one, because a tool that merely defaults off on one surface and on
 * for another is a product design choice, not an owner decision that failed to
 * propagate.
 */
import { AGENT_TOOL_REGISTRY, type AgentKey } from "./registry";

/**
 * Surfaces the OWNER drives, as opposed to ones where the AI faces a customer
 * on its own.
 *
 * These are a different trust class, and conflating them makes the audit
 * useless. Amy Laidlaw is the worked example: after her calendar tools were
 * disabled on voice, sms, webchat and email, `dashboard` stayed deliberately
 * on, because that surface is Amy asking her own assistant to book something,
 * not the AI booking at a customer unprompted. Counting that as a divergence
 * put her on every run of the audit forever, which is how a report earns its
 * way into being ignored.
 *
 * So they are excluded by default and `includeOwnerOperated` brings them back
 * for the rarer question "where is this tool live at all?".
 */
export const OWNER_OPERATED_AGENT_KEYS: readonly AgentKey[] = ["dashboard"];

export type DivergenceOptions = {
  /** Include owner-driven surfaces (dashboard). Default false. */
  includeOwnerOperated?: boolean;
};

/** One `agent_tool_settings` row, as read from the database. */
export type AgentToolOverrideRow = {
  agent_key: string;
  tool_key: string;
  enabled: boolean;
};

export type ChannelToolState = {
  agentKey: AgentKey;
  /** Effective state: the explicit row when present, else the registry default. */
  enabled: boolean;
  /** True when an `agent_tool_settings` row exists for this pair. */
  explicit: boolean;
};

export type ToolChannelDivergence = {
  toolKey: string;
  /** Channels where the owner explicitly turned this tool off. */
  disabledOn: ChannelToolState[];
  /** Channels that offer the same tool and still have it on. */
  stillEnabledOn: ChannelToolState[];
};

/**
 * Effective state of every channel that offers `toolKey`, in registry order.
 * Channels whose registry entry lacks the tool are absent, so a tool that only
 * exists on one surface can never look divergent.
 */
export function channelStatesForTool(
  toolKey: string,
  overrides: readonly AgentToolOverrideRow[],
  options: DivergenceOptions = {}
): ChannelToolState[] {
  const states: ChannelToolState[] = [];
  for (const agent of AGENT_TOOL_REGISTRY) {
    if (!options.includeOwnerOperated && OWNER_OPERATED_AGENT_KEYS.includes(agent.key)) {
      continue;
    }
    const tool = agent.tools.find((t) => t.toolKey === toolKey);
    // `configurable: false` tools have no platform chokepoint, so their
    // stored value is not enforced and a mismatch means nothing.
    if (!tool || !tool.configurable) continue;
    const row = overrides.find(
      (o) => o.agent_key === agent.key && o.tool_key === toolKey
    );
    states.push({
      agentKey: agent.key,
      enabled: row ? row.enabled : tool.defaultEnabled,
      explicit: Boolean(row)
    });
  }
  return states;
}

/**
 * Every tool for one business where an explicit "off" on one channel has not
 * reached another channel that offers the same tool. Empty means consistent.
 */
export function findChannelDivergences(
  overrides: readonly AgentToolOverrideRow[],
  options: DivergenceOptions = {}
): ToolChannelDivergence[] {
  // Only tools the owner has touched somewhere can diverge in the sense we
  // care about: an untouched tool is at its registry defaults everywhere.
  const touchedToolKeys = [...new Set(overrides.map((o) => o.tool_key))].sort();

  const divergences: ToolChannelDivergence[] = [];
  for (const toolKey of touchedToolKeys) {
    const states = channelStatesForTool(toolKey, overrides, options);
    const disabledOn = states.filter((s) => s.explicit && !s.enabled);
    if (disabledOn.length === 0) continue;
    const stillEnabledOn = states.filter((s) => s.enabled);
    if (stillEnabledOn.length === 0) continue;
    divergences.push({ toolKey, disabledOn, stillEnabledOn });
  }
  return divergences;
}

/** One-line human summary of a divergence, for the audit script's output. */
export function describeDivergence(divergence: ToolChannelDivergence): string {
  const off = divergence.disabledOn.map((s) => s.agentKey).join(", ");
  const on = divergence.stillEnabledOn
    .map((s) => (s.explicit ? s.agentKey : `${s.agentKey} (registry default)`))
    .join(", ");
  return `${divergence.toolKey}: OFF on ${off}, still ON for ${on}`;
}

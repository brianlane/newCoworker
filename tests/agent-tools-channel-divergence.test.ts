import { describe, expect, it } from "vitest";
import {
  channelStatesForTool,
  describeDivergence,
  findChannelDivergences,
  OWNER_OPERATED_AGENT_KEYS,
  type AgentToolOverrideRow
} from "@/lib/agent-tools/channel-divergence";
import { AGENT_TOOL_REGISTRY } from "@/lib/agent-tools/registry";

/**
 * The case this exists for: Amy Laidlaw Real Estate, Jul 29 to Aug 3 2026.
 * The five calendar tools were disabled for `sms`; `voice` never got the same
 * rows, kept the registry default (enabled), and the phone coworker went on
 * booking appointments for five more days.
 */
const AMY_CALENDAR_TOOLS = [
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist"
];

const amySmsOnly: AgentToolOverrideRow[] = AMY_CALENDAR_TOOLS.map((tool_key) => ({
  agent_key: "sms",
  tool_key,
  enabled: false
}));

/** A tool key that genuinely exists on both sms and voice in the registry. */
function toolOnBothSmsAndVoice(): string {
  const sms = AGENT_TOOL_REGISTRY.find((a) => a.key === "sms");
  const voice = AGENT_TOOL_REGISTRY.find((a) => a.key === "voice");
  const shared = sms?.tools.find(
    (t) => t.configurable && voice?.tools.some((v) => v.toolKey === t.toolKey && v.configurable)
  );
  if (!shared) throw new Error("registry has no configurable tool shared by sms and voice");
  return shared.toolKey;
}

describe("findChannelDivergences", () => {
  it("flags Amy's exact shape: calendar off for sms, still on elsewhere", () => {
    const divergences = findChannelDivergences(amySmsOnly);

    expect(divergences.map((d) => d.toolKey).sort()).toEqual([...AMY_CALENDAR_TOOLS].sort());
    for (const d of divergences) {
      expect(d.disabledOn.map((s) => s.agentKey)).toEqual(["sms"]);
      // The heart of the bug: no row at all, so the registry default applies.
      expect(d.stillEnabledOn.length).toBeGreaterThan(0);
      for (const s of d.stillEnabledOn) {
        expect(s.explicit).toBe(false);
        expect(s.enabled).toBe(true);
      }
    }

    // Voice carries only three of the five. Booking is the one that matters,
    // and it must be flagged.
    const booking = divergences.find((d) => d.toolKey === "calendar_book_appointment");
    expect(booking?.stillEnabledOn.map((s) => s.agentKey)).toContain("voice");
  });

  // Running this against the registry is what surfaced that Amy's policy was
  // still incomplete after disable-amy-voice-booking.ts: the calendar tools
  // are ALSO default-on for webchat and email, both customer-facing.
  it("keeps flagging after sms and voice are fixed, because other channels remain", () => {
    const smsAndVoice: AgentToolOverrideRow[] = [
      ...amySmsOnly,
      ...AMY_CALENDAR_TOOLS.map((tool_key) => ({
        agent_key: "voice",
        tool_key,
        enabled: false
      }))
    ];
    const remaining = findChannelDivergences(smsAndVoice);
    expect(remaining.length).toBeGreaterThan(0);
    const channels = new Set(remaining.flatMap((d) => d.stillEnabledOn.map((s) => s.agentKey)));
    expect(channels.has("sms")).toBe(false);
    expect(channels.has("voice")).toBe(false);
    // The two that disable-amy-customer-booking.ts then closed.
    expect(channels.has("webchat") || channels.has("email")).toBe(true);
  });

  it("goes quiet once every CUSTOMER channel offering the tool is disabled", () => {
    // Amy's real end state: the four customer surfaces closed, dashboard left
    // deliberately on. The audit must be silent here, or she appears on every
    // future run and the report earns its way into being ignored.
    const customerChannelsClosed: AgentToolOverrideRow[] = [];
    for (const tool_key of AMY_CALENDAR_TOOLS) {
      for (const agent of AGENT_TOOL_REGISTRY) {
        if (OWNER_OPERATED_AGENT_KEYS.includes(agent.key)) continue;
        if (!agent.tools.some((t) => t.toolKey === tool_key)) continue;
        customerChannelsClosed.push({ agent_key: agent.key, tool_key, enabled: false });
      }
    }
    customerChannelsClosed.push({
      agent_key: "dashboard",
      tool_key: "calendar_book_appointment",
      enabled: true
    });
    expect(findChannelDivergences(customerChannelsClosed)).toEqual([]);
  });

  it("--include-dashboard surfaces the owner surface that the default hides", () => {
    const customerChannelsClosed: AgentToolOverrideRow[] = [];
    for (const tool_key of AMY_CALENDAR_TOOLS) {
      for (const agent of AGENT_TOOL_REGISTRY) {
        if (OWNER_OPERATED_AGENT_KEYS.includes(agent.key)) continue;
        if (!agent.tools.some((t) => t.toolKey === tool_key)) continue;
        customerChannelsClosed.push({ agent_key: agent.key, tool_key, enabled: false });
      }
    }
    const widened = findChannelDivergences(customerChannelsClosed, {
      includeOwnerOperated: true
    });
    expect(widened.length).toBeGreaterThan(0);
    const channels = new Set(widened.flatMap((d) => d.stillEnabledOn.map((s) => s.agentKey)));
    expect([...channels]).toEqual(["dashboard"]);
  });

  it("never treats dashboard as a customer-facing gap by default", () => {
    // A tool live ONLY on the owner's own assistant is not a divergence.
    const onlyDashboardOn: AgentToolOverrideRow[] = [
      { agent_key: "sms", tool_key: "calendar_book_appointment", enabled: false },
      { agent_key: "voice", tool_key: "calendar_book_appointment", enabled: false },
      { agent_key: "webchat", tool_key: "calendar_book_appointment", enabled: false },
      { agent_key: "email", tool_key: "calendar_book_appointment", enabled: false },
      { agent_key: "dashboard", tool_key: "calendar_book_appointment", enabled: true }
    ];
    expect(findChannelDivergences(onlyDashboardOn)).toEqual([]);
  });

  it("reports nothing for a business with no overrides at all", () => {
    // Untouched tools sit at registry defaults everywhere, which is consistent
    // by construction, not a divergence.
    expect(findChannelDivergences([])).toEqual([]);
  });

  it("reports nothing when every channel is explicitly on", () => {
    const tool = toolOnBothSmsAndVoice();
    expect(
      findChannelDivergences([
        { agent_key: "sms", tool_key: tool, enabled: true },
        { agent_key: "voice", tool_key: tool, enabled: true }
      ])
    ).toEqual([]);
  });

  it("reports nothing when the only channel offering the tool is the disabled one", () => {
    // A voice-only tool turned off on voice cannot be on anywhere else.
    const voice = AGENT_TOOL_REGISTRY.find((a) => a.key === "voice");
    const voiceOnly = voice?.tools.find(
      (t) =>
        t.configurable &&
        !AGENT_TOOL_REGISTRY.some(
          (a) => a.key !== "voice" && a.tools.some((o) => o.toolKey === t.toolKey)
        )
    );
    if (voiceOnly) {
      expect(
        findChannelDivergences([
          { agent_key: "voice", tool_key: voiceOnly.toolKey, enabled: false }
        ])
      ).toEqual([]);
    }
  });

  it("ignores an unknown tool_key rather than throwing", () => {
    // A stale row for a tool since removed from the registry.
    expect(
      findChannelDivergences([
        { agent_key: "sms", tool_key: "tool_that_no_longer_exists", enabled: false }
      ])
    ).toEqual([]);
  });

  it("ignores an unknown agent_key", () => {
    expect(
      findChannelDivergences([
        { agent_key: "carrier_pigeon", tool_key: toolOnBothSmsAndVoice(), enabled: false }
      ])
    ).toEqual([]);
  });

  // Not symmetric on purpose: a tool left off does nothing, while a tool left
  // on keeps taking real actions the owner believes they stopped.
  it("does not flag the reverse direction (explicitly ON somewhere, off elsewhere)", () => {
    const tool = toolOnBothSmsAndVoice();
    const divergences = findChannelDivergences([
      { agent_key: "sms", tool_key: tool, enabled: true }
    ]);
    expect(divergences).toEqual([]);
  });

  it("sorts by tool key so runs are diffable", () => {
    const keys = findChannelDivergences(amySmsOnly).map((d) => d.toolKey);
    expect(keys).toEqual([...keys].sort());
  });
});

describe("channelStatesForTool", () => {
  it("omits channels whose registry entry lacks the tool", () => {
    const tool = toolOnBothSmsAndVoice();
    const states = channelStatesForTool(tool, []);
    for (const state of states) {
      const agent = AGENT_TOOL_REGISTRY.find((a) => a.key === state.agentKey);
      expect(agent?.tools.some((t) => t.toolKey === tool)).toBe(true);
    }
  });

  it("marks an explicit row as explicit and an absent one as default", () => {
    const tool = toolOnBothSmsAndVoice();
    const states = channelStatesForTool(tool, [
      { agent_key: "sms", tool_key: tool, enabled: false }
    ]);
    expect(states.find((s) => s.agentKey === "sms")).toMatchObject({
      enabled: false,
      explicit: true
    });
    expect(states.find((s) => s.agentKey === "voice")?.explicit).toBe(false);
  });

  it("skips non-configurable tools, whose stored value is not enforced", () => {
    const displayOnly = AGENT_TOOL_REGISTRY.flatMap((a) =>
      a.tools.filter((t) => !t.configurable).map((t) => ({ agent: a.key, tool: t.toolKey }))
    )[0];
    if (displayOnly) {
      const states = channelStatesForTool(displayOnly.tool, []);
      expect(states.some((s) => s.agentKey === displayOnly.agent)).toBe(false);
    }
  });

  it("returns nothing for a tool no agent offers", () => {
    expect(channelStatesForTool("not_a_real_tool", [])).toEqual([]);
  });
});

describe("describeDivergence", () => {
  it("names the channels and marks which are on by default", () => {
    const [first] = findChannelDivergences(amySmsOnly);
    const line = describeDivergence(first);
    expect(line).toContain(first.toolKey);
    expect(line).toContain("OFF on sms");
    expect(line).toContain("voice (registry default)");
  });

  it("does not label an explicitly-on channel as a default", () => {
    const tool = toolOnBothSmsAndVoice();
    const [d] = findChannelDivergences([
      { agent_key: "sms", tool_key: tool, enabled: false },
      { agent_key: "voice", tool_key: tool, enabled: true }
    ]);
    const line = describeDivergence(d);
    // Bare "voice" in the ON list; every default-on channel is annotated.
    expect(line).toMatch(/still ON for .*\bvoice\b/);
    expect(line).not.toContain("voice (registry default)");
  });
});

import { describe, expect, it } from "vitest";
import {
  calendarPairsForCustomerChannels,
  pairsNeedingDisable,
  type ToolPair
} from "../scripts/oneshot/disable-amy-customer-booking";
import { AGENT_TOOL_REGISTRY } from "../src/lib/agent-tools/registry";
import { findChannelDivergences } from "../src/lib/agent-tools/channel-divergence";

describe("calendarPairsForCustomerChannels", () => {
  it("covers the four customer-facing channels and never dashboard", () => {
    const channels = new Set(calendarPairsForCustomerChannels().map((p) => p.agentKey));
    expect([...channels].sort()).toEqual(["email", "sms", "voice", "webchat"]);
    // Amy asking her own assistant to book is not the AI acting at a customer.
    expect(channels.has("dashboard")).toBe(false);
  });

  it("only names pairs the registry actually defines", () => {
    for (const { agentKey, toolKey } of calendarPairsForCustomerChannels()) {
      const agent = AGENT_TOOL_REGISTRY.find((a) => a.key === agentKey);
      const tool = agent?.tools.find((t) => t.toolKey === toolKey);
      expect(tool).toBeDefined();
      expect(tool?.configurable).toBe(true);
    }
  });

  // The earlier voice one-shot hardcoded all five and wrote two rows for tools
  // voice does not have. Driving off the registry is what prevents that.
  it("gives each channel only the calendar tools it has", () => {
    const pairs = calendarPairsForCustomerChannels();
    const countFor = (agentKey: string) => pairs.filter((p) => p.agentKey === agentKey).length;
    expect(countFor("webchat")).toBeLessThan(countFor("email"));
    expect(countFor("voice")).toBeLessThan(countFor("sms"));
    expect(pairs).not.toContainEqual({
      agentKey: "webchat",
      toolKey: "calendar_cancel_appointment"
    });
  });
});

describe("pairsNeedingDisable", () => {
  const pairs: ToolPair[] = [
    { agentKey: "webchat", toolKey: "calendar_book_appointment" },
    { agentKey: "email", toolKey: "calendar_book_appointment" }
  ];

  // The trap this whole sequence of one-shots exists to close.
  it("treats a MISSING row as outstanding, not as off", () => {
    expect(pairsNeedingDisable(pairs, [])).toEqual(pairs);
  });

  it("treats an explicitly enabled row as outstanding, same as a missing one", () => {
    // enabled:true is a row that says "on", so it still needs flipping.
    expect(
      pairsNeedingDisable(pairs, [
        { agent_key: "webchat", tool_key: "calendar_book_appointment", enabled: true }
      ])
    ).toEqual(pairs);
  });

  it("skips a pair already explicitly disabled", () => {
    expect(
      pairsNeedingDisable(pairs, [
        { agent_key: "webchat", tool_key: "calendar_book_appointment", enabled: false }
      ])
    ).toEqual([{ agentKey: "email", toolKey: "calendar_book_appointment" }]);
  });

  it("is idempotent: nothing left once every pair is disabled", () => {
    const allDisabled = pairs.map((p) => ({
      agent_key: p.agentKey,
      tool_key: p.toolKey,
      enabled: false
    }));
    expect(pairsNeedingDisable(pairs, allDisabled)).toEqual([]);
  });

  it("ignores rows for other channels and other tools", () => {
    expect(
      pairsNeedingDisable(pairs, [
        { agent_key: "dashboard", tool_key: "calendar_book_appointment", enabled: false },
        { agent_key: "webchat", tool_key: "send_follow_up_sms", enabled: false }
      ])
    ).toEqual(pairs);
  });
});

/**
 * The whole point: after this one-shot, `debug/audit-agent-tool-channels.ts`
 * must go quiet for this tenant.
 */
describe("end state satisfies the fleet audit", () => {
  it("leaves no divergence once every customer-channel pair is disabled", () => {
    const overrides = calendarPairsForCustomerChannels().map((p) => ({
      agent_key: p.agentKey,
      tool_key: p.toolKey,
      enabled: false
    }));
    // Dashboard stays on, explicitly, exactly as Amy set it.
    overrides.push({
      agent_key: "dashboard",
      tool_key: "calendar_book_appointment",
      enabled: true
    });

    const divergences = findChannelDivergences(overrides);
    const stillOn = divergences.flatMap((d) => d.stillEnabledOn.map((s) => s.agentKey));
    // Dashboard may still surface, since it is genuinely still enabled; what
    // must NOT remain is any customer-facing channel.
    for (const channel of ["voice", "sms", "webchat", "email"]) {
      expect(stillOn).not.toContain(channel);
    }
  });
});

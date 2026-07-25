import { describe, expect, it, vi } from "vitest";
import { isBridgeToolEnabled } from "../vps/voice-bridge/src/tool-settings";

/**
 * Settings → Coworker tools enforcement for BRIDGE-LOCAL voice tools.
 *
 * HTTP-proxied voice tools are gated app-side by `agentToolDisabledResponse`; a
 * tool handled on the box has no such chokepoint, so this read is the only thing
 * standing between the Settings page and a switch that changes nothing.
 *
 * Semantics must mirror `isAgentToolEnabled` (src/lib/db/agent-tool-settings.ts):
 * missing row and read error both resolve to the registry default, so a
 * transient DB blip never flips behavior mid-call.
 */
const BIZ = "00000000-0000-0000-0000-000000000001";

function clientReturning(result: { data: unknown; error?: { message: string } | null }) {
  const calls: { eq: Array<[string, unknown]>; table?: string } = { eq: [] };
  const chain = {
    select: () => chain,
    eq(col: string, val: unknown) {
      calls.eq.push([col, val]);
      return chain;
    },
    maybeSingle: async () => ({ data: result.data, error: result.error ?? null })
  };
  return {
    client: {
      from(table: string) {
        calls.table = table;
        return chain;
      }
    },
    calls
  };
}

const args = {
  businessId: BIZ,
  agentKey: "voice",
  toolKey: "start_translator_mode",
  defaultEnabled: true
};

describe("isBridgeToolEnabled", () => {
  it("returns the owner's explicit false", async () => {
    const { client, calls } = clientReturning({ data: { enabled: false } });
    await expect(isBridgeToolEnabled(client, args)).resolves.toBe(false);
    expect(calls.table).toBe("agent_tool_settings");
    expect(calls.eq).toEqual([
      ["business_id", BIZ],
      ["agent_key", "voice"],
      ["tool_key", "start_translator_mode"]
    ]);
  });

  it("returns the owner's explicit true", async () => {
    const { client } = clientReturning({ data: { enabled: true } });
    await expect(isBridgeToolEnabled(client, args)).resolves.toBe(true);
  });

  it("falls back to the registry default when no row exists", async () => {
    const { client } = clientReturning({ data: null });
    await expect(isBridgeToolEnabled(client, args)).resolves.toBe(true);
    await expect(
      isBridgeToolEnabled(client, { ...args, defaultEnabled: false })
    ).resolves.toBe(false);
  });

  it("falls back to the registry default when the row has no usable value", async () => {
    const { client } = clientReturning({ data: { enabled: null } });
    await expect(isBridgeToolEnabled(client, args)).resolves.toBe(true);
  });

  it("resolves a read error to the registry default rather than breaking a live call", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = clientReturning({ data: null, error: { message: "boom" } });
    await expect(isBridgeToolEnabled(client, args)).resolves.toBe(true);
    await expect(
      isBridgeToolEnabled(client, { ...args, defaultEnabled: false })
    ).resolves.toBe(false);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("resolves a thrown client error to the registry default", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const thrower = {
      from() {
        throw new Error("network");
      }
    };
    await expect(isBridgeToolEnabled(thrower, args)).resolves.toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

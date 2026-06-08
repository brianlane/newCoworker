import { describe, expect, it, vi } from "vitest";
import {
  STOP_SUFFIX,
  ensureStopLanguage,
  isRecipientOptedOut,
  type ComplianceRpcClient
} from "../supabase/functions/_shared/ai_flows/compliance";

describe("ensureStopLanguage", () => {
  it("leaves a body that already mentions STOP unchanged", () => {
    const body = "Hi! Reply STOP to opt out anytime.";
    expect(ensureStopLanguage(body)).toBe(body);
  });
  it("appends the suffix to a normal body", () => {
    expect(ensureStopLanguage("  Are you still selling?  ")).toBe(
      `Are you still selling? ${STOP_SUFFIX}`
    );
  });
  it("returns just the suffix for an empty body", () => {
    expect(ensureStopLanguage("   ")).toBe(STOP_SUFFIX);
  });
  it("supports a custom suffix", () => {
    expect(ensureStopLanguage("Yo", "Txt STOP to end.")).toBe("Yo Txt STOP to end.");
  });
});

describe("isRecipientOptedOut", () => {
  function client(data: unknown, error: { message: string } | null = null): ComplianceRpcClient {
    return { rpc: vi.fn().mockResolvedValue({ data, error }) };
  }
  it("returns true when the RPC says opted out", async () => {
    expect(await isRecipientOptedOut(client(true), "biz", "+16026866672")).toBe(true);
  });
  it("returns false otherwise", async () => {
    expect(await isRecipientOptedOut(client(false), "biz", "+16026866672")).toBe(false);
    expect(await isRecipientOptedOut(client(null), "biz", "+16026866672")).toBe(false);
  });
  it("throws on RPC error", async () => {
    await expect(
      isRecipientOptedOut(client(null, { message: "db down" }), "biz", "+1")
    ).rejects.toThrow("sms_is_opted_out: db down");
  });
});

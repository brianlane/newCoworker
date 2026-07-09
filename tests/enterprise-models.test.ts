import { describe, expect, it } from "vitest";

import {
  enterpriseModelsSchema,
  parseEnterpriseModels,
  GEMINI_LIVE_VOICES
} from "@/lib/plans/enterprise-models";

describe("enterpriseModelsSchema", () => {
  it("accepts a full valid config", () => {
    const parsed = enterpriseModelsSchema.parse({
      ownerChatModel: "gemini-2.5-flash-lite",
      smsChatModel: "gemini-3.1-flash",
      geminiLiveModel: "gemini-3.1-flash-live-preview",
      voiceName: "Puck"
    });
    expect(parsed.voiceName).toBe("Puck");
  });

  it("accepts partial configs and strips unknown keys", () => {
    expect(enterpriseModelsSchema.parse({ voiceName: "Kore", extra: 1 })).toEqual({
      voiceName: "Kore"
    });
  });

  it("rejects live models in chat slots (AI-budget metering bypass)", () => {
    expect(
      enterpriseModelsSchema.safeParse({ ownerChatModel: "gemini-3.1-flash-live-preview" }).success
    ).toBe(false);
    expect(
      enterpriseModelsSchema.safeParse({ smsChatModel: "gemini-2.5-flash-live" }).success
    ).toBe(false);
  });

  it("rejects non-live models in the voice slot and non-gemini ids everywhere", () => {
    expect(enterpriseModelsSchema.safeParse({ geminiLiveModel: "gemini-3.1-flash" }).success).toBe(
      false
    );
    expect(enterpriseModelsSchema.safeParse({ ownerChatModel: "gpt-4o" }).success).toBe(false);
    expect(
      enterpriseModelsSchema.safeParse({ ownerChatModel: "gemini-$(rm -rf /)" }).success
    ).toBe(false);
    expect(enterpriseModelsSchema.safeParse({ voiceName: "NotAVoice" }).success).toBe(false);
  });

  it("exposes the prebuilt voice allow-list for the picker UI", () => {
    expect(GEMINI_LIVE_VOICES).toContain("Puck");
    expect(GEMINI_LIVE_VOICES).toContain("Aoede");
    expect(GEMINI_LIVE_VOICES.length).toBeGreaterThanOrEqual(8);
  });
});

describe("parseEnterpriseModels", () => {
  it("returns null for null/garbage/empty input", () => {
    expect(parseEnterpriseModels(null)).toBeNull();
    expect(parseEnterpriseModels(undefined)).toBeNull();
    expect(parseEnterpriseModels("junk")).toBeNull();
    expect(parseEnterpriseModels({ ownerChatModel: "not-gemini" })).toBeNull();
    expect(parseEnterpriseModels({})).toBeNull();
  });

  it("returns the parsed config for valid input", () => {
    expect(parseEnterpriseModels({ voiceName: "Charon" })).toEqual({ voiceName: "Charon" });
  });
});

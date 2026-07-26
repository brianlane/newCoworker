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
      geminiLiveModel: "gemini-3.1-flash-live-preview"
    });
    expect(parsed.geminiLiveModel).toBe("gemini-3.1-flash-live-preview");
  });

  it("accepts partial configs and strips unknown keys", () => {
    expect(enterpriseModelsSchema.parse({ smsChatModel: "gemini-3.5-flash", extra: 1 })).toEqual({
      smsChatModel: "gemini-3.5-flash"
    });
    // The voice moved to business_telnyx_settings.voice_name, so it is now an
    // unknown key here and must be stripped rather than stored in two places.
    expect(enterpriseModelsSchema.parse({ voiceName: "Kore" })).toEqual({});
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
    // Translate-flavored live models pass the "contains live" check but support
    // no tools or instructions, so they cannot run the phone coworker.
    expect(
      enterpriseModelsSchema.safeParse({ geminiLiveModel: "gemini-3.5-live-translate-preview" })
        .success
    ).toBe(false);
  });

  it("exposes the prebuilt voice allow-list for the picker UI", () => {
    // Widened from the original 8-voice subset to Google's full published set;
    // tests/voice-name-lockstep.test.ts pins it against the bridge and the DB.
    expect(GEMINI_LIVE_VOICES).toContain("Puck");
    expect(GEMINI_LIVE_VOICES).toContain("Aoede");
    expect(GEMINI_LIVE_VOICES).toContain("Sulafat");
    expect(GEMINI_LIVE_VOICES.length).toBe(30);
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
    expect(parseEnterpriseModels({ geminiLiveModel: "gemini-3.1-flash-live-preview" })).toEqual({
      geminiLiveModel: "gemini-3.1-flash-live-preview"
    });
    // A voice-only blob now parses to nothing, so it reads as "no overrides".
    expect(parseEnterpriseModels({ voiceName: "Charon" })).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { readLiveUsage } from "../vps/voice-bridge/src/live-usage";

describe("voice-bridge readLiveUsage", () => {
  it("returns null when the message carries no usageMetadata", () => {
    expect(readLiveUsage(null)).toBeNull();
    expect(readLiveUsage({})).toBeNull();
    expect(readLiveUsage({ serverContent: {} })).toBeNull();
  });

  it("reads cumulative totals and splits the AUDIO modality from prompt/response details", () => {
    const usage = readLiveUsage({
      usageMetadata: {
        promptTokenCount: 10_000,
        responseTokenCount: 20_000,
        totalTokenCount: 30_000,
        promptTokensDetails: [
          { modality: "AUDIO", tokenCount: 9_000 },
          { modality: "TEXT", tokenCount: 1_000 }
        ],
        responseTokensDetails: [
          { modality: "AUDIO", tokenCount: 19_500 },
          { modality: "TEXT", tokenCount: 500 }
        ]
      }
    });
    expect(usage).toEqual({
      promptTokens: 10_000,
      outputTokens: 20_000,
      promptAudioTokens: 9_000,
      outputAudioTokens: 19_500,
      totalTokens: 30_000
    });
  });

  it("is case-insensitive on the modality label and ignores non-numeric token counts", () => {
    const usage = readLiveUsage({
      usageMetadata: {
        promptTokenCount: 100,
        responseTokenCount: 50,
        totalTokenCount: 150,
        promptTokensDetails: [
          { modality: "audio", tokenCount: 40 },
          { modality: "AUDIO", tokenCount: "oops" },
          { modality: "TEXT", tokenCount: 60 }
        ],
        responseTokensDetails: [{ modality: "Audio", tokenCount: 50 }]
      }
    });
    expect(usage).toEqual({
      promptTokens: 100,
      outputTokens: 50,
      promptAudioTokens: 40,
      outputAudioTokens: 50,
      totalTokens: 150
    });
  });

  it("defaults missing totals and details to 0 (usage present but sparse)", () => {
    const usage = readLiveUsage({ usageMetadata: { promptTokenCount: 12 } });
    expect(usage).toEqual({
      promptTokens: 12,
      outputTokens: 0,
      promptAudioTokens: 0,
      outputAudioTokens: 0,
      totalTokens: 0
    });
  });
});

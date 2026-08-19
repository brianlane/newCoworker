import { describe, expect, it } from "vitest";
import {
  asrLanguageHintCodes,
  inputAudioTranscriptionConfig
} from "../vps/voice-bridge/src/asr-language-hints";

/**
 * Aug 3 2026: the bridge sent `inputAudioTranscription: {}`, no hint at all,
 * so the Live API auto-detected across every language it knows. Chris
 * Bartelot spoke English for four minutes and two of his turns landed in the
 * transcript as Portuguese and Korean.
 *
 * The fix must narrow the space WITHOUT pinning English, because Spanish
 * callers are a supported case on this platform.
 */
describe("asrLanguageHintCodes", () => {
  it("never returns an empty list, even knowing nothing about the caller", () => {
    // An empty hint list would be the bug all over again: the API falls back
    // to unbounded auto-detection.
    expect(asrLanguageHintCodes()).toEqual(["en-US", "es-US"]);
    expect(asrLanguageHintCodes({})).toEqual(["en-US", "es-US"]);
  });

  it("excludes every language the platform does not serve", () => {
    // The specific failure: pt and ko were never plausible callers here.
    const codes = asrLanguageHintCodes({ defaultLang: "en" });
    expect(codes.some((c) => c.startsWith("pt"))).toBe(false);
    expect(codes.some((c) => c.startsWith("ko"))).toBe(false);
  });

  it("leads with the caller's established language", () => {
    expect(asrLanguageHintCodes({ established: "es", defaultLang: "en" })).toEqual([
      "es-US",
      "en-US"
    ]);
  });

  it("leads with the tenant default when the caller has no stored preference", () => {
    // Amy's shape exactly: default en, Chris's contact preferred_language null.
    expect(asrLanguageHintCodes({ established: null, defaultLang: "en" })).toEqual([
      "en-US",
      "es-US"
    ]);
  });

  it("keeps Spanish reachable for an English-default tenant", () => {
    // The reason this is a hint list and not a pin.
    expect(asrLanguageHintCodes({ defaultLang: "en" })).toContain("es-US");
  });

  it("keeps English reachable for a Spanish-default tenant", () => {
    expect(asrLanguageHintCodes({ defaultLang: "es" })).toEqual(["es-US", "en-US"]);
  });

  it("does not duplicate when the established language is the tenant default", () => {
    expect(asrLanguageHintCodes({ established: "en", defaultLang: "en" })).toEqual([
      "en-US",
      "es-US"
    ]);
  });

  it("emits BCP-47 tags, not the bare two-letter codes", () => {
    for (const code of asrLanguageHintCodes()) {
      expect(code).toMatch(/^[a-z]{2}-[A-Z]{2}$/);
    }
  });
});

describe("inputAudioTranscriptionConfig", () => {
  it("produces the languageHints shape the Live API expects", () => {
    expect(inputAudioTranscriptionConfig({ defaultLang: "en" })).toEqual({
      languageHints: { languageCodes: ["en-US", "es-US"] }
    });
  });

  // languageHints and languageAuto are mutually exclusive in the SDK
  // ("Do not use together"), and languageCodes at the top level is deprecated.
  it("sets neither languageAuto nor the deprecated top-level languageCodes", () => {
    const config = inputAudioTranscriptionConfig();
    expect(config).not.toHaveProperty("languageAuto");
    expect(config).not.toHaveProperty("languageCodes");
  });

  it("is never the empty object that caused the bug", () => {
    expect(Object.keys(inputAudioTranscriptionConfig())).not.toHaveLength(0);
  });
});

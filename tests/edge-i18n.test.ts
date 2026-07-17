import { describe, expect, it } from "vitest";
import edgeEn from "../messages/edge-en.json";
import edgeEs from "../messages/edge-es.json";
import { edgeMessage, telnyxTtsLanguage } from "../supabase/functions/_shared/edge_messages";
import { voiceMessageForLocale } from "../supabase/functions/_shared/voice_messages";
import {
  STOP_SUFFIX,
  STOP_SUFFIX_ES,
  ensureStopLanguage,
  stopSuffixForLocale
} from "../supabase/functions/_shared/ai_flows/compliance";

describe("edge message bundles", () => {
  it("edge-en.json and edge-es.json have identical keys", () => {
    expect(Object.keys(edgeEs).sort()).toEqual(Object.keys(edgeEn).sort());
  });

  it("edgeMessage returns the localized string with en default", () => {
    expect(edgeMessage("SMS_STOP_SUFFIX")).toBe(edgeEn.SMS_STOP_SUFFIX);
    expect(edgeMessage("SMS_STOP_SUFFIX", "es")).toBe(edgeEs.SMS_STOP_SUFFIX);
  });

  it("telnyxTtsLanguage maps locales to Telnyx language tags", () => {
    expect(telnyxTtsLanguage("en")).toBe("en-US");
    expect(telnyxTtsLanguage("es")).toBe("es-US");
  });
});

describe("voiceMessageForLocale", () => {
  it("returns English by default and Spanish when asked", () => {
    expect(voiceMessageForLocale("VOICE_MSG_SYSTEM_ERROR")).toBe(edgeEn.VOICE_MSG_SYSTEM_ERROR);
    expect(voiceMessageForLocale("VOICE_MSG_SYSTEM_ERROR", "es")).toBe(
      edgeEs.VOICE_MSG_SYSTEM_ERROR
    );
  });
});

describe("stop suffix locale", () => {
  it("stopSuffixForLocale returns es suffix only for es", () => {
    expect(stopSuffixForLocale("es")).toBe(STOP_SUFFIX_ES);
    expect(stopSuffixForLocale("en")).toBe(STOP_SUFFIX);
    expect(stopSuffixForLocale(null)).toBe(STOP_SUFFIX);
    expect(stopSuffixForLocale()).toBe(STOP_SUFFIX);
  });

  it("ensureStopLanguage treats ALTO as existing opt-out language", () => {
    const body = "Hola, responde ALTO para cancelar.";
    expect(ensureStopLanguage(body, STOP_SUFFIX_ES)).toBe(body);
  });
});

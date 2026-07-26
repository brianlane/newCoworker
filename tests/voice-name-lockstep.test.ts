import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_GEMINI_LIVE_VOICE,
  GEMINI_LIVE_VOICES,
  GEMINI_LIVE_VOICE_LABELS,
  enterpriseModelsSchema,
  normalizeGeminiLiveVoice
} from "@/lib/plans/enterprise-models";
import {
  DEFAULT_VOICE_NAME,
  GEMINI_LIVE_VOICES as BRIDGE_VOICES,
  normalizeVoiceName,
  resolveVoiceName
} from "../vps/voice-bridge/src/voice-name";

/**
 * The voice allow-list exists in four places that must agree: the app module,
 * the voice bridge's standalone mirror (it is rsynced to the VPS and cannot
 * import from the app), the DB CHECK constraint, and the admin dropdown's label
 * map. A one-sided edit means either a voice the UI offers but the DB rejects,
 * or a voice stored but never rendered, so these pin them together.
 */
const ROOT = join(__dirname, "..");
const MIGRATION = join(
  ROOT,
  "supabase/migrations/20260821007000_per_tenant_voice_name.sql"
);

describe("voice allow-list lockstep", () => {
  it("the bridge mirror matches the app list exactly, including order", () => {
    expect([...BRIDGE_VOICES]).toEqual([...GEMINI_LIVE_VOICES]);
  });

  it("the platform default matches on both sides", () => {
    expect(DEFAULT_VOICE_NAME).toBe(DEFAULT_GEMINI_LIVE_VOICE);
    expect(DEFAULT_GEMINI_LIVE_VOICE).toBe("Kore");
  });

  it("the default is itself a member of the allow-list", () => {
    expect(GEMINI_LIVE_VOICES).toContain(DEFAULT_GEMINI_LIVE_VOICE);
  });

  it("every voice has a dropdown label and there are no orphan labels", () => {
    expect(Object.keys(GEMINI_LIVE_VOICE_LABELS).sort()).toEqual(
      [...GEMINI_LIVE_VOICES].sort()
    );
    for (const v of GEMINI_LIVE_VOICES) {
      expect(GEMINI_LIVE_VOICE_LABELS[v].length).toBeGreaterThan(0);
    }
  });

  it("the DB CHECK constraint lists exactly the same voices", () => {
    const sql = readFileSync(MIGRATION, "utf8");
    const inList = /voice_name in \(([\s\S]*?)\)\s*\)/.exec(sql);
    expect(inList, "could not find the voice_name IN (...) list").toBeTruthy();
    const fromSql = [...inList![1].matchAll(/'([A-Za-z]+)'/g)].map((m) => m[1]).sort();
    expect(fromSql).toEqual([...GEMINI_LIVE_VOICES].sort());
  });

  it("the list is alphabetical, so additions land somewhere predictable", () => {
    expect([...GEMINI_LIVE_VOICES]).toEqual([...GEMINI_LIVE_VOICES].sort());
  });
});

describe("normalizeVoiceName / normalizeGeminiLiveVoice", () => {
  it("accepts a known voice and trims it", () => {
    expect(normalizeVoiceName("Kore")).toBe("Kore");
    expect(normalizeVoiceName("  Sulafat  ")).toBe("Sulafat");
    expect(normalizeGeminiLiveVoice(" Leda ")).toBe("Leda");
  });

  it("rejects unknown values, wrong case, and non-strings", () => {
    // Case-sensitive on purpose: Gemini expects the exact name, and silently
    // accepting "kore" would send something the API may not honor.
    for (const v of ["kore", "KORE", "Nonexistent", "", "   ", null, undefined, 7, {}]) {
      expect(normalizeVoiceName(v)).toBeNull();
      expect(normalizeGeminiLiveVoice(v)).toBeNull();
    }
  });
});

describe("resolveVoiceName precedence", () => {
  it("prefers the tenant's own choice", () => {
    expect(
      resolveVoiceName({ tenantVoiceName: "Sulafat", envVoiceName: "Puck" })
    ).toBe("Sulafat");
  });

  it("falls back to the box env when the tenant has none", () => {
    expect(resolveVoiceName({ tenantVoiceName: null, envVoiceName: "Puck" })).toBe("Puck");
  });

  it("falls back to the platform default when neither is set", () => {
    expect(resolveVoiceName({})).toBe("Kore");
    expect(resolveVoiceName({ tenantVoiceName: null, envVoiceName: "" })).toBe("Kore");
  });

  it("ignores an unusable stored value rather than sending it to Gemini", () => {
    // A junk value must not reach the API: an unknown voice name would break
    // audio on every call for that tenant.
    expect(resolveVoiceName({ tenantVoiceName: "Bogus", envVoiceName: "Leda" })).toBe(
      "Leda"
    );
    expect(resolveVoiceName({ tenantVoiceName: "Bogus", envVoiceName: "alsoBogus" })).toBe(
      "Kore"
    );
  });
});

describe("the bridge always asks for a voice", () => {
  it("sends speechConfig unconditionally", () => {
    // Regression: it used to send speechConfig ONLY when VOICE_NAME was set,
    // which left the voice to Gemini's undocumented per-model default. Google
    // warns that default can change, and two identically configured boxes were
    // observed answering in different voices.
    const src = readFileSync(
      join(ROOT, "vps/voice-bridge/src/gemini-telnyx-bridge.ts"),
      "utf8"
    );
    expect(src).toContain("const voiceName = resolveVoiceName({");
    expect(src).not.toContain('const voiceName = (process.env.VOICE_NAME ?? "").trim()');
    expect(src).toContain(
      "speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName } } }"
    );
  });

  it("reads the tenant column in the per-call settings query", () => {
    const idx = readFileSync(join(ROOT, "vps/voice-bridge/src/index.ts"), "utf8");
    expect(idx).toContain("translator_mode_enabled, voice_name");
    expect(idx).toContain("tenantVoiceName: tenantSettings.voiceName");
  });
});

describe("enterprise_models no longer owns the voice", () => {
  it("rejects a voiceName key so there is one source of truth", () => {
    const parsed = enterpriseModelsSchema.safeParse({ voiceName: "Kore" });
    // Zod strips unknown keys rather than failing, so assert it does not survive.
    expect(parsed.success).toBe(true);
    expect(parsed.success && "voiceName" in parsed.data).toBe(false);
  });

  it("still accepts the three model ids", () => {
    const parsed = enterpriseModelsSchema.safeParse({
      ownerChatModel: "gemini-3.5-flash",
      smsChatModel: "gemini-3.5-flash-lite",
      geminiLiveModel: "gemini-3.1-flash-live-preview"
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a translate-flavored model in the receptionist voice slot", () => {
    // gemini-3.5-live-translate-preview passes the "must contain live" check but
    // supports NO tools and NO system instructions, so it would silently strip
    // the entire persona and every tool from a tenant's phone coworker.
    const parsed = enterpriseModelsSchema.safeParse({
      geminiLiveModel: "gemini-3.5-live-translate-preview"
    });
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]?.message).toContain(
      "no tools or instructions"
    );
  });

  it("still refuses a non-live model in the voice slot", () => {
    expect(
      enterpriseModelsSchema.safeParse({ geminiLiveModel: "gemini-3.5-flash" }).success
    ).toBe(false);
  });
});

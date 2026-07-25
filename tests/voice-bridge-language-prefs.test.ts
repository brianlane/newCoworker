import { describe, expect, it } from "vitest";
import { customerLanguageLine as sharedLanguageLine } from "../shared/i18n/customer-language-line";
import { customerLanguageLine as voiceLanguageLine } from "../vps/voice-bridge/src/customer-language-line";
import {
  normalizeVoiceLanguage,
  resolveVoiceLanguagePrefs
} from "../vps/voice-bridge/src/language-prefs";
import { systemInstructionForBusiness } from "../vps/voice-bridge/src/system-instruction";
import { intakeSystemInstruction } from "../vps/voice-bridge/src/intake";

/**
 * The voice bridge is rsynced to the VPS standalone, so it vendors a mirror of
 * shared/i18n/customer-language-line.ts instead of importing it. The RETURNED
 * STRING must stay byte-identical for the same inputs; these tests pin the two
 * implementations against each other so a one-sided edit is loud (same pattern
 * as tests/voice-bridge-contact-context.test.ts).
 */
describe("customerLanguageLine parity with the shared module", () => {
  const cases = [
    {},
    { defaultLang: "en" as const },
    { defaultLang: "es" as const },
    { established: "es" as const },
    { established: "en" as const },
    { established: "es" as const, defaultLang: "es" as const },
    { established: "en" as const, defaultLang: "es" as const },
    { detected: "es" as const },
    { detected: "en" as const, established: "es" as const },
    { established: null, defaultLang: "en" as const },
    { supported: ["en"] as const },
    { supported: ["en", "es"] as const, established: "es" as const }
  ];

  it("returns byte-identical strings for every input shape", () => {
    for (const c of cases) {
      const opts = c as Parameters<typeof sharedLanguageLine>[0];
      expect(voiceLanguageLine(opts as Parameters<typeof voiceLanguageLine>[0])).toBe(
        sharedLanguageLine(opts)
      );
    }
  });

  it("carries no em dash (repo writing rule) on either side", () => {
    expect(voiceLanguageLine({}).includes("\u2014")).toBe(false);
    expect(sharedLanguageLine({}).includes("\u2014")).toBe(false);
  });

  it("names the established language only when it differs from the default", () => {
    expect(voiceLanguageLine({ established: "es", defaultLang: "en" })).toContain(
      "Current conversation language: es."
    );
    expect(voiceLanguageLine({ established: "en", defaultLang: "en" })).not.toContain(
      "Current conversation language"
    );
  });

  it("English-only support suppresses the line entirely", () => {
    expect(voiceLanguageLine({ supported: ["en"] })).toBe("");
  });
});

describe("normalizeVoiceLanguage", () => {
  it("accepts the two supported codes, case and whitespace insensitively", () => {
    expect(normalizeVoiceLanguage("es")).toBe("es");
    expect(normalizeVoiceLanguage(" ES ")).toBe("es");
    expect(normalizeVoiceLanguage("En")).toBe("en");
  });

  it("rejects anything else, including unsupported locales and non-strings", () => {
    for (const v of ["fr", "es-MX", "", "   ", null, undefined, 7, {}, ["es"]]) {
      expect(normalizeVoiceLanguage(v)).toBeNull();
    }
  });
});

describe("resolveVoiceLanguagePrefs precedence", () => {
  it("falls back to English when the tenant has no default", () => {
    expect(resolveVoiceLanguagePrefs({})).toEqual({ established: null, defaultLang: "en" });
  });

  it("uses the tenant default when the caller is unknown", () => {
    expect(
      resolveVoiceLanguagePrefs({ businessDefaultLanguage: "es" })
    ).toEqual({ established: null, defaultLang: "es" });
  });

  it("prefers the contact's own language over the tenant default", () => {
    expect(
      resolveVoiceLanguagePrefs({
        contactPreferredLanguage: "es",
        businessDefaultLanguage: "en"
      })
    ).toEqual({ established: "es", defaultLang: "en" });
  });

  it("lets a known English contact override a Spanish-default tenant", () => {
    expect(
      resolveVoiceLanguagePrefs({
        contactPreferredLanguage: "en",
        businessDefaultLanguage: "es"
      })
    ).toEqual({ established: "en", defaultLang: "es" });
  });

  it("ignores an unusable stored value instead of failing the call", () => {
    expect(
      resolveVoiceLanguagePrefs({
        contactPreferredLanguage: "pt-BR",
        businessDefaultLanguage: "bogus"
      })
    ).toEqual({ established: null, defaultLang: "en" });
  });
});

describe("the receptionist persona honors the resolved language", () => {
  const build = (prefs?: Parameters<typeof systemInstructionForBusiness>[11]) =>
    systemInstructionForBusiness(
      "Acme",
      false,
      false,
      undefined,
      undefined,
      null,
      undefined,
      false,
      undefined,
      undefined,
      undefined,
      prefs
    );

  it("keeps the pre-feature English default when no prefs are passed", () => {
    expect(build()).toContain("Default to en when unclear.");
    expect(build()).not.toContain("Current conversation language");
  });

  it("opens in Spanish for a known Spanish-speaking caller", () => {
    const out = build({ established: "es", defaultLang: "en" });
    expect(out).toContain("Current conversation language: es.");
  });

  it("takes the tenant default for an unknown caller", () => {
    expect(build({ established: null, defaultLang: "es" })).toContain(
      "Default to es when unclear."
    );
  });

  it("never renders the language line for a staff caller", () => {
    const staff = systemInstructionForBusiness(
      "Acme",
      false,
      false,
      undefined,
      undefined,
      null,
      { kind: "owner", name: "Amy" },
      false,
      undefined,
      undefined,
      undefined,
      { established: "es", defaultLang: "es" }
    );
    expect(staff).not.toContain("Language: reply in the same language");
  });
});

describe("the intake takeover persona handles Spanish sellers", () => {
  const build = (prefs?: Parameters<typeof intakeSystemInstruction>[8]) =>
    intakeSystemInstruction(
      "Acme",
      undefined,
      null,
      ["name", "phone"],
      false,
      undefined,
      false,
      undefined,
      prefs
    );

  it("carries the bilingual instruction (it previously had none)", () => {
    expect(build()).toContain("Language: reply in the same language the customer uses");
  });

  it("carries the no-em-dash instruction (it previously had none)", () => {
    expect(build()).toContain("never use an em dash in anything you write");
  });

  it("requires the owner-facing captured fields in English regardless of call language", () => {
    const out = build({ established: "es", defaultLang: "en" });
    expect(out).toContain("Current conversation language: es.");
    expect(out).toContain("always write the values you pass to `capture_lead` in ENGLISH");
  });

  it("runs Spanish-first for a Spanish-default tenant with an unknown seller", () => {
    const out = build({ established: null, defaultLang: "es" });
    expect(out).toContain("Default to es when unclear.");
    expect(out).toContain("always write the values you pass to `capture_lead` in ENGLISH");
  });

  it("speaks the owner-authored opener as written rather than translating it", () => {
    expect(build({ established: "es", defaultLang: "en" })).toContain(
      "Speak your opening line exactly as written above"
    );
  });
});

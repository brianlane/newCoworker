/**
 * Mexican (+52) phone handling in AiFlow extraction, sanitization, and
 * dialing, plus the incident-pinned NANP behaviors that must survive it.
 *
 * The corruption class this guards against: PHONE_RE's 3-3-4 shape matches
 * the trailing 10 digits of "+52 55 1234 5678" and normalizeNanpToE164 mints
 * +15512345678, a REAL US number the extraction fallback could text. Every
 * prior phone incident (tracking numbers, the Privyr support line, the KYP
 * "+492046781" hallucination, the 13-digit "+1613..." paste, the
 * phone_lead_type gate-field blanking) is re-pinned here under BOTH country
 * defaults so the MX arms cannot regress them.
 */
import { describe, expect, it } from "vitest";
import {
  coerceDialableE164,
  extractLabeledPhones,
  extractPhones,
  normalizeMxToE164,
  postProcessExtractedField,
  sanitizeExtractedPhone
} from "../supabase/functions/_shared/ai_flows/engine";
import {
  businessDefaultPhoneCountry,
  MEXICAN_TIMEZONES
} from "../supabase/functions/_shared/business_country";
import { planStep } from "../supabase/functions/_shared/ai_flows/steps";
import type { FlowStep } from "../supabase/functions/_shared/ai_flows/types";

const MX = { defaultCountry: "MX" as const };
const US = { defaultCountry: "US" as const };

describe("normalizeMxToE164", () => {
  it("normalizes an explicit +52 number with ordinary separators", () => {
    expect(normalizeMxToE164("+52 55 1234 5678")).toBe("+525512345678");
    expect(normalizeMxToE164("+52 (55) 1234-5678")).toBe("+525512345678");
    expect(normalizeMxToE164("+525512345678")).toBe("+525512345678");
  });

  it("canonicalizes the legacy 521 mobile form down to +52 + 10", () => {
    expect(normalizeMxToE164("+52 1 55 1234 5678")).toBe("+525512345678");
    expect(normalizeMxToE164("5215512345678")).toBe("+525512345678");
  });

  it("accepts bare 10 national digits (callers gate this arm on MX context)", () => {
    expect(normalizeMxToE164("55 1234 5678")).toBe("+525512345678");
    expect(normalizeMxToE164("6641234567")).toBe("+526641234567");
  });

  it("rejects 0/1-leading nationals and wrong lengths", () => {
    expect(normalizeMxToE164("+52 05 1234 5678")).toBeNull();
    expect(normalizeMxToE164("+52 15 1234 5678")).toBeNull();
    expect(normalizeMxToE164("551234567")).toBeNull();
    expect(normalizeMxToE164("+52 55 1234 5678 9")).toBeNull();
    expect(normalizeMxToE164("")).toBeNull();
  });
});

describe("extractPhones with Mexican numbers", () => {
  it("reads +52 55 1234 5678 as Mexican, never as the +1 of its last 10 digits", () => {
    const out = extractPhones("Nuevo lead: +52 5512345678, responder pronto");
    expect(out).toContain("+525512345678");
    expect(out).not.toContain("+15512345678");
  });

  it("extracts mixed +52 and +1 numbers in text order under the US default", () => {
    expect(
      extractPhones("Cliente: +52 55 1234 5678, agente: +1 (602) 686-6672")
    ).toEqual(["+525512345678", "+16026866672"]);
  });

  it("under the MX default, bare 10-digit shapes read as +52", () => {
    expect(extractPhones("Cel 602-686-6672", MX)).toEqual(["+526026866672"]);
    expect(extractPhones("marcar al (55) 1234 5678", MX)).toEqual(["+525512345678"]);
  });

  it("under the MX default, explicit NANP shapes still read as +1", () => {
    expect(extractPhones("agente: +1 602 686 6672", MX)).toEqual(["+16026866672"]);
    expect(extractPhones("agente: 1 602 686 6672", MX)).toEqual(["+16026866672"]);
  });

  it("under the US default, a bare 2-4-4 Mexican grouping stays unextracted (dropped, not corrupted)", () => {
    expect(extractPhones("Cel: 55 1234 5678")).toEqual([]);
  });

  it("never reads a phone out of a longer digit run (tracking-number pin, both defaults)", () => {
    const text = "Tracking: 9400111202555842332999";
    expect(extractPhones(text)).toEqual([]);
    expect(extractPhones(text, MX)).toEqual([]);
  });
});

describe("extractLabeledPhones with Mexican labels", () => {
  it("accepts Spanish phone labels under the MX default", () => {
    expect(extractLabeledPhones("Cel: 55 1234 5678", MX)).toEqual(["+525512345678"]);
    expect(extractLabeledPhones("Teléfono: 55-1234-5678", MX)).toEqual(["+525512345678"]);
    expect(extractLabeledPhones("llámame al 55 1234 5678", MX)).toEqual(["+525512345678"]);
  });

  it("accepts a labeled +52 number under the US default too", () => {
    expect(extractLabeledPhones("WhatsApp: +52 1 55 1234 5678")).toEqual(["+525512345678"]);
  });

  it("still refuses unlabeled numbers (Privyr support-line pin, both defaults)", () => {
    const text = "Thanks for your interest!\nCall Privyr support at (415) 555-0126 anytime.";
    expect(extractLabeledPhones(text)).toEqual([]);
    expect(extractLabeledPhones(text, MX)).toEqual([]);
  });

  it("refuses an unlabeled bare Mexican number under the MX default", () => {
    expect(extractLabeledPhones("Referencia de pago 55 1234 5678", MX)).toEqual([]);
  });

  it("keeps the English labels working exactly as before", () => {
    expect(extractLabeledPhones("Phone: 602-686-6672")).toEqual(["+16026866672"]);
  });
});

describe("sanitizeExtractedPhone with Mexican values", () => {
  it("keeps a +52 value whose digits appear plus-less in the source (the discarded-lead fix)", () => {
    expect(
      sanitizeExtractedPhone("+525512345678", "Cel: 52 55 1234 5678")
    ).toBe("+525512345678");
    expect(
      sanitizeExtractedPhone("+525512345678", "Cel: 52 55 1234 5678", MX)
    ).toBe("+525512345678");
  });

  it("canonicalizes a corroborated legacy 521 value", () => {
    expect(
      sanitizeExtractedPhone("+5215512345678", "WhatsApp 52 1 55 1234 5678")
    ).toBe("+525512345678");
  });

  it("downgrades a +52 value with no digit trail in the source", () => {
    expect(sanitizeExtractedPhone("+525512345678", "please call me back")).toBe("none");
  });

  it("downgrades a 0-leading Mexican national even when the source corroborates it", () => {
    expect(sanitizeExtractedPhone("+52 05 1234 5678", "tel 52 05 1234 5678")).toBe("none");
  });

  it("under the MX default, bare national digits coerce to +52 (NANP-analog trust)", () => {
    expect(sanitizeExtractedPhone("55 1234 5678", "anything", MX)).toBe("+525512345678");
    expect(sanitizeExtractedPhone("602-686-6672", "anything", MX)).toBe("+526026866672");
  });

  it("under the MX default, trusts +52 values the way the US default trusts +1 values", () => {
    expect(sanitizeExtractedPhone("+525512345678", "no digits in source", MX)).toBe(
      "+525512345678"
    );
    expect(sanitizeExtractedPhone("+52 55 1234 56", "no digits in source", MX)).toBe("none");
  });

  it("under the MX default, explicit NANP shapes keep NANP treatment", () => {
    expect(sanitizeExtractedPhone("+1 602 686 6672", "anything", MX)).toBe("+16026866672");
    expect(sanitizeExtractedPhone("1 602 686 6672", "anything", MX)).toBe("+16026866672");
  });

  it("under the US default, bare 10 digits still coerce to +1 (unchanged)", () => {
    expect(sanitizeExtractedPhone("5512345678", "anything")).toBe("+15512345678");
  });

  it("still kills the hallucinated-plus class under both defaults (KYP +492046781 pin)", () => {
    expect(sanitizeExtractedPhone("+492046781", "entered 492046781 on the form")).toBe("none");
    expect(sanitizeExtractedPhone("+492046781", "entered 492046781 on the form", MX)).toBe("none");
  });

  it("still refuses an overlong +1 even when the source corroborates it (+16133439985030 pin)", () => {
    const src = "phone: +16133439985030";
    expect(sanitizeExtractedPhone("+16133439985030", src)).toBe("none");
    expect(sanitizeExtractedPhone("+16133439985030", src, MX)).toBe("none");
  });

  it("passes empty-class values through untouched under both defaults", () => {
    expect(sanitizeExtractedPhone("none", "x", MX)).toBe("none");
    expect(sanitizeExtractedPhone("", "x", MX)).toBe("");
    expect(sanitizeExtractedPhone("N/A", "x")).toBe("N/A");
  });
});

describe("postProcessExtractedField under the MX default", () => {
  it("leaves word-valued gate fields alone (phone_lead_type pin)", () => {
    expect(postProcessExtractedField("phone_lead_type", "seller", "Cel: 55 1234 5678", MX)).toBe(
      "seller"
    );
    expect(postProcessExtractedField("has_phone", "yes", "x", MX)).toBe("yes");
  });

  it("fills an empty phone field from a Spanish-labeled number", () => {
    expect(postProcessExtractedField("lead_phone", "", "Cel: 55 1234 5678", MX)).toBe(
      "+525512345678"
    );
  });

  it("sanitizes a filled phone field with the MX rules", () => {
    expect(postProcessExtractedField("contact_number", "55 1234 5678", "x", MX)).toBe(
      "+525512345678"
    );
  });

  it("ignores non-phone field names entirely", () => {
    expect(postProcessExtractedField("order_number", "5512345678", "x", MX)).toBe("5512345678");
  });
});

describe("coerceDialableE164 with Mexican numbers", () => {
  it("passes a canonical +52 number through and canonicalizes the legacy 521 form", () => {
    expect(coerceDialableE164("+525512345678")).toBe("+525512345678");
    expect(coerceDialableE164("+5215512345678")).toBe("+525512345678");
  });

  it("rejects malformed +52 values instead of passing them structurally", () => {
    expect(coerceDialableE164("+52123")).toBeNull();
    expect(coerceDialableE164("+52551234567890")).toBeNull();
  });

  it("under the MX default, bare national digits dial as +52", () => {
    expect(coerceDialableE164("602-686-6672", MX)).toBe("+526026866672");
    expect(coerceDialableE164("55 1234 5678", MX)).toBe("+525512345678");
  });

  it("under the MX default, explicit NANP shapes still dial as +1", () => {
    expect(coerceDialableE164("+1 602 686 6672", MX)).toBe("+16026866672");
    expect(coerceDialableE164("1 602 686 6672", MX)).toBe("+16026866672");
  });

  it("keeps the strict-NANP rejections under both defaults (+16133439985030 pin)", () => {
    expect(coerceDialableE164("+16133439985030")).toBeNull();
    expect(coerceDialableE164("+16133439985030", MX)).toBeNull();
  });

  it("keeps passing other international E.164 through untouched", () => {
    expect(coerceDialableE164("+447911123456")).toBe("+447911123456");
    expect(coerceDialableE164("+447911123456", MX)).toBe("+447911123456");
  });

  it("keeps US behavior byte-identical when no options are passed", () => {
    expect(coerceDialableE164("602-686-6672")).toBe("+16026866672");
    expect(coerceDialableE164("(155) 123-4567")).toBeNull();
  });
});

describe("businessDefaultPhoneCountry", () => {
  it("classifies a +52 owner phone as MX, authoritative over timezone", () => {
    expect(businessDefaultPhoneCountry({ phone: "+525512345678" })).toBe("MX");
    expect(
      businessDefaultPhoneCountry({ phone: "+52 55 1234 5678", timezone: "America/Vancouver" })
    ).toBe("MX");
  });

  it("pins any NANP-parseable phone to US, never falling through to timezone", () => {
    expect(businessDefaultPhoneCountry({ phone: "+16028053377" })).toBe("US");
    expect(
      businessDefaultPhoneCountry({ phone: "6028053377", timezone: "America/Mexico_City" })
    ).toBe("US");
  });

  it("falls back to the timezone when the phone is absent or unparseable", () => {
    expect(businessDefaultPhoneCountry({ timezone: "America/Mexico_City" })).toBe("MX");
    expect(businessDefaultPhoneCountry({ phone: "", timezone: "America/Tijuana" })).toBe("MX");
    expect(businessDefaultPhoneCountry({ phone: null, timezone: "America/Phoenix" })).toBe("US");
    expect(businessDefaultPhoneCountry({})).toBe("US");
  });

  it("covers every Mexican zone in the set", () => {
    for (const tz of MEXICAN_TIMEZONES) {
      expect(businessDefaultPhoneCountry({ timezone: tz })).toBe("MX");
    }
  });

  it("classifies a plus-less 52/521-prefixed row as MX (legacy hand entry)", () => {
    expect(businessDefaultPhoneCountry({ phone: "52 55 1234 5678" })).toBe("MX");
    expect(businessDefaultPhoneCountry({ phone: "5215512345678" })).toBe("MX");
  });

  it("never reads a bare 10-digit or junk 52-run as MX from the phone alone", () => {
    expect(businessDefaultPhoneCountry({ phone: "5512345678" })).toBe("US");
    expect(businessDefaultPhoneCountry({ phone: "52123", timezone: "America/Phoenix" })).toBe(
      "US"
    );
    expect(businessDefaultPhoneCountry({ phone: "520512345678" })).toBe("US");
  });
});

describe("send_whatsapp +52 recipients", () => {
  it("canonicalizes a plus-less legacy 521 digit run resurrected by the wa fallback", () => {
    const r = planStep(
      { id: "w", type: "send_whatsapp", to: "5215512345678", body: "hola" } as FlowStep,
      { vars: {} }
    );
    expect(r).toMatchObject({ ok: true, action: { kind: "send_whatsapp", to: "+525512345678" } });
  });

  it("under the MX default, a bare 10-digit recipient reads as +52", () => {
    const r = planStep(
      { id: "w", type: "send_whatsapp", to: "55 1234 5678", body: "hola" } as FlowStep,
      { vars: {}, phoneCountry: "MX" }
    );
    expect(r).toMatchObject({ ok: true, action: { kind: "send_whatsapp", to: "+525512345678" } });
  });
});

describe("recall_url keys agree with the +52 store side", () => {
  const step: FlowStep = { id: "r", type: "recall_url", keyVars: ["k"], saveAs: "u" } as FlowStep;

  it("keys a loose 10-digit var by the tenant's phone country", () => {
    expect(planStep(step, { vars: { k: "55 1234 5678" }, phoneCountry: "MX" })).toEqual({
      ok: true,
      action: { kind: "recall_url", keys: ["+525512345678"], saveAs: "u" }
    });
    expect(planStep(step, { vars: { k: "602-555-0126" } })).toEqual({
      ok: true,
      action: { kind: "recall_url", keys: ["+16025550126"], saveAs: "u" }
    });
  });

  it("keeps +52 participants as +52 keys, canonicalizing the legacy 521 form", () => {
    const s: FlowStep = {
      id: "r",
      type: "recall_url",
      keyFromTrigger: "participants",
      saveAs: "u"
    } as FlowStep;
    expect(
      planStep(s, { trigger: { participants: ["+5215512345678", "+16025550126"] } })
    ).toEqual({
      ok: true,
      action: { kind: "recall_url", keys: ["+525512345678", "+16025550126"], saveAs: "u" }
    });
  });
});

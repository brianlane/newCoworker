/**
 * Prospecting pitch composition (src/lib/outreach/compose.ts).
 *
 * The two load-bearing guarantees under test: a prospect with no checkable
 * finding is never pitched, and the compliance footer is assembled AFTER any
 * AI polish, from code the model never sees.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const generateSpy = vi.fn(async () => ({ text: "Hi Acme,\n\nRewritten by default deps.", usage: null }));
const meterSpy = vi.fn(async () => {});
vi.mock("@/lib/gemini-generate-content", () => ({
  geminiGenerateTextDetailed: (...args: unknown[]) => generateSpy(...(args as []))
}));
vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: (...args: unknown[]) => meterSpy(...(args as []))
}));

import {
  assembleBody,
  composePitch,
  isPitchable,
  leadFinding,
  PITCH_POLISH_INSTRUCTION,
  PITCH_POLISH_MODEL,
  PITCH_POLISH_SURFACE,
  pitchParagraphs,
  polishParagraphs,
  splitParagraphs,
  type PitchTenant
} from "@/lib/outreach/compose";

const TENANT: PitchTenant = {
  name: "New Coworker",
  valueProp: "We give small businesses an AI coworker that answers every call and text.",
  website: "https://www.newcoworker.com",
  bookingUrl: "https://www.newcoworker.com/book/hq",
  senderName: "Brian",
  postalAddress: "New Coworker, 1 Example Plaza, Phoenix AZ 85001"
};

const UNSUB = "https://www.newcoworker.com/api/outreach/unsubscribe?bid=b&p=p&t=t";

const BOOKING_FINDING = {
  code: "no_online_booking",
  detail: "No booking link or scheduler found on the site."
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("leadFinding / isPitchable", () => {
  it("leads with the finding that maps to lost work, not the first one found", () => {
    const findings = [
      { code: "no_tap_to_call", detail: "d" },
      { code: "after_hours_gap", detail: "d" },
      BOOKING_FINDING
    ];
    expect(leadFinding(findings)?.code).toBe("after_hours_gap");
  });

  it("has nothing to lead with when there are no findings", () => {
    expect(leadFinding([])).toBeNull();
    expect(isPitchable([])).toBe(false);
  });

  it("opens the hours findings without naming a source", () => {
    // The hours evidence comes from EITHER the prospect's markup or their
    // Google listing, so an opening that says "the site says..." is false
    // whenever Google supplied the fact. A cold email that opens by getting
    // something wrong is finished, so neither hours opening may name a source.
    for (const code of ["closed_weekends", "after_hours_gap"]) {
      const pitch = composePitch(
        TENANT,
        { businessName: "Acme", city: "", findings: [{ code, detail: "either source" }] },
        UNSUB
      );
      expect(pitch).not.toBeNull();
      const opening = (pitch?.body ?? "").split("\n\n")[1] ?? "";
      expect(opening).not.toMatch(/site|website|Google|listing/i);
    }
  });

  it("has a cost sentence for every opening it will pitch", () => {
    // The two maps are keyed the same way and read in the same breath. If one
    // gains a finding code the other does not, the pitch reads "...noticed X.
    // undefined" and goes out that way, because isPitchable only ever checked
    // the opening. This is the guard that keeps them in step.
    for (const code of [
      "no_online_booking",
      "no_chat_widget",
      "no_text_option",
      "no_tap_to_call",
      "closed_weekends",
      "after_hours_gap"
    ]) {
      const pitch = composePitch(
        TENANT,
        { businessName: "Acme", city: "Mesa", findings: [{ code, detail: "d" }] },
        UNSUB
      );
      expect(isPitchable([{ code, detail: "d" }])).toBe(true);
      expect(pitch?.body).not.toContain("undefined");
      // Observation and cost land as one paragraph, so the gap and what falls
      // through it are read as a single thought.
      const opening = (pitch?.body ?? "").split("\n\n")[1] ?? "";
      expect(opening.split(". ").length).toBeGreaterThan(1);
    }
  });

  it("never puts a number, a percentage, or a competitor in the reader's mouth", () => {
    // The most persuasive sentence a cold email can write is the one it has not
    // earned: "up to 35% of those calls go to voicemail". We probed their site;
    // we did not measure their phone. Every cost line is general behaviour, and
    // the polish prompt forbids inventing the rest.
    for (const code of [
      "no_online_booking",
      "no_chat_widget",
      "no_text_option",
      "no_tap_to_call",
      "closed_weekends",
      "after_hours_gap"
    ]) {
      const paragraphs = pitchParagraphs(
        TENANT,
        { businessName: "Acme", city: "Mesa", findings: [] },
        { code, detail: "d" }
      );
      const cost = paragraphs[1];
      expect(cost).not.toMatch(/\d/);
      expect(cost).not.toMatch(/percent|%|competitor|revenue/i);
    }
    expect(PITCH_POLISH_INSTRUCTION).toContain("percentages");
    expect(PITCH_POLISH_INSTRUCTION).toContain("never");
    expect(PITCH_POLISH_INSTRUCTION).toContain("name a competitor");
  });

  it("refuses a finding it has no honest opening for", () => {
    // An unknown code could only produce a vague opener, which is spam.
    expect(isPitchable([{ code: "invented_by_a_future_probe", detail: "d" }])).toBe(false);
    expect(leadFinding([{ code: "unknown", detail: "d" }])?.code).toBe("unknown");
    expect(isPitchable([BOOKING_FINDING])).toBe(true);
  });
});

describe("composePitch", () => {
  it("builds a subject and body grounded in the lead finding", () => {
    const pitch = composePitch(
      TENANT,
      { businessName: "Acme HVAC", city: "Mesa", findings: [BOOKING_FINDING] },
      UNSUB
    );
    expect(pitch).not.toBeNull();
    expect(pitch?.subject).toBe("Acme HVAC: booking a job without the phone tag");
    expect(pitch?.body).toContain("Hi Acme HVAC,");
    expect(pitch?.body).toContain("in Mesa");
    expect(pitch?.body).toContain("no way to book you online");
    expect(pitch?.body).toContain(TENANT.valueProp);
    expect(pitch?.body).toContain(TENANT.bookingUrl as string);
    // Compliance: both required elements, every time.
    expect(pitch?.body).toContain(UNSUB);
    expect(pitch?.body).toContain(TENANT.postalAddress);
  });

  it("returns null rather than a vague email when nothing checkable was found", () => {
    expect(
      composePitch(TENANT, { businessName: "Acme", city: "", findings: [] }, UNSUB)
    ).toBeNull();
    expect(
      composePitch(
        TENANT,
        { businessName: "Acme", city: "", findings: [{ code: "mystery", detail: "d" }] },
        UNSUB
      )
    ).toBeNull();
  });

  it("falls back to a neutral greeting and omits the city when they are unknown", () => {
    const pitch = composePitch(
      TENANT,
      { businessName: "   ", city: "   ", findings: [BOOKING_FINDING] },
      UNSUB
    );
    expect(pitch?.subject).toBe("there: booking a job without the phone tag");
    expect(pitch?.body).toContain("Hi there,");
    expect(pitch?.body).not.toContain(" in .");
  });
});

describe("assembleBody", () => {
  it("asks for a reply when the tenant has no booking page", () => {
    const body = assembleBody(
      { ...TENANT, bookingUrl: null },
      pitchParagraphs(TENANT, { businessName: "Acme", city: "", findings: [] }, BOOKING_FINDING),
      UNSUB
    );
    expect(body).toContain("Just reply if you want to hear more.");
    expect(body).toContain(UNSUB);
  });

  it("prints the unsubscribe line alone when the tenant has no address at all", () => {
    // Only reachable for a tier the platform exempts from the typed address
    // (Enterprise) that also has none on its business profile. An empty line
    // where an address should be reads as a template that failed to render.
    const body = assembleBody({ ...TENANT, postalAddress: "  " }, ["Hi there,", "True."], UNSUB);
    expect(body).toContain(UNSUB);
    expect(body.trimEnd().split("\n").pop()).toContain(UNSUB);
  });

  it("signs with the business name when no sender is configured", () => {
    const body = assembleBody(
      { ...TENANT, senderName: null, website: null },
      ["Hi there,", "Something true."],
      UNSUB
    );
    expect(body).toContain("New Coworker");
    expect(body).not.toContain("Brian");
  });
});

describe("splitParagraphs", () => {
  it("turns owner-typed text into the same shape the polish pass returns", () => {
    // One shape in, one assembly path out: an edited draft and a
    // machine-written one must not diverge here.
    expect(splitParagraphs("One.\n\n\n  \n\n  Two.  \n\n")).toEqual(["One.", "Two."]);
    expect(splitParagraphs("   ")).toEqual([]);
  });

  it("never returns nothing for text that survived a trim", () => {
    // The invariant editProspectDraft leans on: it refuses empty text after a
    // trim, then splits. If a trimmed non-empty string could still split to
    // nothing, an owner could save a pitch that is only CTA, signature, and
    // footer. It cannot: a trimmed string starts on a non-whitespace
    // character, and the separator /\n\s*\n/ cannot match at position 0, so
    // the first chunk always carries that character through filter(Boolean).
    for (const raw of [
      "\n\n",
      "  \n\n  ",
      "\n \n \n",
      "\t\n\n\t",
      "\r\n\r\n",
      " \n\n ",
      "﻿\n\n﻿",
      "   ",
      ""
    ]) {
      const trimmed = raw.trim();
      // Every one of these is caught by the empty check, never reaching the split.
      expect(trimmed).toBe("");
    }
    for (const raw of [".", "a\n\nb", "  .  ", "\n\n.\n\n", " . "]) {
      expect(splitParagraphs(raw.trim()).length).toBeGreaterThan(0);
    }
  });
});

describe("polishParagraphs", () => {
  const paragraphs = ["Hi Acme,", "You have no booking link.", "Worth a quick look?"];

  it("returns the deterministic paragraphs when there is no API key", async () => {
    expect(await polishParagraphs("biz", paragraphs, { apiKey: "" })).toEqual(paragraphs);
  });

  it("rewrites for tone, meters the spend, and never sees the footer", async () => {
    const generate = vi.fn(
      async (_args: { userText: string; systemInstruction: string }) => ({
        text: "Hi Acme,\n\nNoticed there is no way to book you online.\n\nWorth a look?",
        usage: { promptTokens: 40, outputTokens: 20 }
      })
    );
    const meter = vi.fn(async () => {});
    const polished = await polishParagraphs("biz-1", paragraphs, {
      apiKey: "k",
      generate: generate as never,
      meter: meter as never
    });
    expect(polished).toEqual([
      "Hi Acme,",
      "Noticed there is no way to book you online.",
      "Worth a look?"
    ]);
    const promptArgs = generate.mock.calls[0][0];
    expect(promptArgs.userText).not.toContain("unsubscribe");
    expect(promptArgs.systemInstruction).toBe(PITCH_POLISH_INSTRUCTION);
    // The no-em-dash instruction rides every model prompt (repo rule).
    expect(PITCH_POLISH_INSTRUCTION).toContain("never use an em dash");
    expect(meter).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: "biz-1",
        model: PITCH_POLISH_MODEL,
        surface: PITCH_POLISH_SURFACE,
        usage: { promptTokens: 40, outputTokens: 20 }
      })
    );
  });

  it("strips an em dash the model produced anyway", async () => {
    const generate = vi.fn(async () => ({
      text: "Hi Acme,\n\nNo booking link \u2014 that costs you jobs.",
      usage: null
    }));
    const polished = await polishParagraphs("biz", paragraphs, {
      apiKey: "k",
      generate: generate as never,
      meter: vi.fn() as never
    });
    expect(polished.join(" ")).not.toContain("\u2014");
    // The spacing around the dash goes with it: no double space left behind.
    expect(polished[1]).toBe("No booking link, that costs you jobs.");
  });

  it("discards an empty draw or a response long enough to have invented material", async () => {
    const empty = vi.fn(async () => ({ text: "   ", usage: null }));
    expect(
      await polishParagraphs("biz", paragraphs, {
        apiKey: "k",
        generate: empty as never,
        meter: vi.fn() as never
      })
    ).toEqual(paragraphs);

    const rambling = vi.fn(async () => ({ text: "x".repeat(1000), usage: null }));
    expect(
      await polishParagraphs("biz", paragraphs, {
        apiKey: "k",
        generate: rambling as never,
        meter: vi.fn() as never
      })
    ).toEqual(paragraphs);
  });

  it("falls back to the deterministic paragraphs when the model call fails", async () => {
    const failing = vi.fn(async () => {
      throw new Error("gemini_http_503");
    });
    expect(
      await polishParagraphs("biz", paragraphs, {
        apiKey: "k",
        generate: failing as never,
        meter: vi.fn() as never
      })
    ).toEqual(paragraphs);
  });

  it("reads the key from the environment, and skips the call when there is none", async () => {
    const previous = process.env.GOOGLE_API_KEY;
    process.env.GOOGLE_API_KEY = "";
    expect(await polishParagraphs("biz", paragraphs)).toEqual(paragraphs);
    expect(generateSpy).not.toHaveBeenCalled();

    // Unset entirely, not just blank: a deployment without the variable at all
    // must degrade the same way rather than send `undefined` as a key.
    delete process.env.GOOGLE_API_KEY;
    expect(await polishParagraphs("biz", paragraphs)).toEqual(paragraphs);
    expect(generateSpy).not.toHaveBeenCalled();

    process.env.GOOGLE_API_KEY = previous;
  });

  it("uses the real generate + meter modules when no deps are injected", async () => {
    const polished = await polishParagraphs("biz-2", paragraphs, { apiKey: "k" });
    expect(polished).toEqual(["Hi Acme,", "Rewritten by default deps."]);
    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(meterSpy).toHaveBeenCalledWith(
      expect.objectContaining({ businessId: "biz-2", surface: PITCH_POLISH_SURFACE })
    );
  });
});

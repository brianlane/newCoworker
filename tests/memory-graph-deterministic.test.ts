/**
 * Deterministic KG ingestion (src/lib/memory/graph-deterministic.ts): the
 * pure builders per source, the shared mode-gate, and the never-throws
 * contract the hook sites rely on.
 */
import { describe, expect, it, vi } from "vitest";

import {
  bookingExtraction,
  capturedLeadExtraction,
  contactExtraction,
  docRecordExtraction,
  ingestBooking,
  ingestBusinessProfile,
  ingestCapturedLead,
  ingestContact,
  ingestDeterministic,
  ingestDocRecordFields,
  ingestLeadSubmission,
  ingestPinnedNote,
  ingestRosterMember,
  leadExtraction,
  leadName,
  pinnedNoteExtraction,
  profileExtraction,
  retirePinnedNote,
  rosterExtraction
} from "@/lib/memory/graph-deterministic";

const BIZ = "11111111-1111-4111-8111-111111111111";

function deps(mode: "off" | "shadow" | "active" = "shadow") {
  return {
    getMode: vi.fn(async () => mode),
    apply: vi.fn(async () => ({
      entitiesCreated: 1,
      entitiesMerged: 0,
      factsInserted: 1,
      factsSuperseded: 0,
      factsSkipped: 0
    }))
  };
}

describe("ingestDeterministic (shared gate)", () => {
  const extraction = rosterExtraction({ name: "Jason" });

  it("applies with the given provenance when the mode is shadow/active", async () => {
    const d = deps("shadow");
    const res = await ingestDeterministic(
      BIZ,
      extraction,
      "src",
      { source: "team_roster", trust: 3, attributedTo: null },
      d
    );
    expect(res.ran).toBe(true);
    expect(d.apply).toHaveBeenCalledWith(BIZ, extraction, ["src"], {}, {
      source: "team_roster",
      trust: 3,
      attributedTo: null
    });
  });

  it("no-ops on off mode and on empty extractions (mode never read)", async () => {
    const off = deps("off");
    expect(
      (await ingestDeterministic(BIZ, extraction, "s", { source: "booking", trust: 2 }, off)).ran
    ).toBe(false);
    expect(off.apply).not.toHaveBeenCalled();

    const d = deps("shadow");
    expect(
      (
        await ingestDeterministic(
          BIZ,
          { entities: [], facts: [] },
          "s",
          { source: "booking", trust: 2 },
          d
        )
      ).ran
    ).toBe(false);
    expect(d.getMode).not.toHaveBeenCalled();
  });

  it("never throws — mode-read and apply failures degrade to ran:false (non-Error too)", async () => {
    const modeFail = {
      getMode: vi.fn(async () => {
        throw new Error("db down");
      }),
      apply: vi.fn()
    };
    expect(
      (await ingestDeterministic(BIZ, extraction, "s", { source: "booking", trust: 2 }, modeFail))
        .ran
    ).toBe(false);

    const applyFail = deps("active");
    applyFail.apply.mockRejectedValue("string failure" as never);
    expect(
      (await ingestDeterministic(BIZ, extraction, "s", { source: "booking", trust: 2 }, applyFail))
        .ran
    ).toBe(false);
  });
});

describe("builders", () => {
  it("rosterExtraction: person + employee role; blank names build nothing", () => {
    const x = rosterExtraction({ name: " Jason ", phoneE164: "+14807039575", email: "j@x.co" });
    expect(x.entities[0]).toMatchObject({
      kind: "person",
      name: "Jason",
      phones: ["+14807039575"],
      emails: ["j@x.co"]
    });
    expect(x.facts[0]).toMatchObject({ predicate: "role", objectValue: "employee" });
    expect(rosterExtraction({ name: "  " })).toEqual({ entities: [], facts: [] });
    // Optional contact points omitted cleanly.
    expect(rosterExtraction({ name: "J" }).entities[0]).toMatchObject({ phones: [], emails: [] });
  });

  it("contactExtraction: named contacts only (a bare number adds nothing new)", () => {
    expect(
      contactExtraction({ displayName: "Bryan Buyer", e164: "+15551234567", email: "b@x.co" })
        .entities[0]
    ).toMatchObject({ name: "Bryan Buyer", phones: ["+15551234567"], emails: ["b@x.co"] });
    expect(contactExtraction({ displayName: null, e164: "+15551234567" })).toEqual({
      entities: [],
      facts: []
    });
    expect(contactExtraction({ displayName: "NoEmail", e164: "+1555" }).entities[0].emails).toEqual(
      []
    );
  });

  it("pinnedNoteExtraction: owner_note fact, name falling back to the number", () => {
    const x = pinnedNoteExtraction({ displayName: null, e164: "+15551234567", note: " repeat buyer " });
    expect(x.entities[0].name).toBe("+15551234567");
    expect(x.facts[0]).toMatchObject({ predicate: "owner_note", objectValue: "repeat buyer" });
    expect(pinnedNoteExtraction({ displayName: "B", e164: "+1", note: "  " })).toEqual({
      entities: [],
      facts: []
    });
  });

  it("profileExtraction: org node with address fact; hours optional; blank name builds nothing", () => {
    const x = profileExtraction({
      businessName: "Amy Laidlaw Real Estate",
      address: "1 Main St, Phoenix AZ",
      phoneE164: "+16023131823",
      hoursSummary: "Mon-Fri 9-5"
    });
    expect(x.entities[0]).toMatchObject({ kind: "organization", phones: ["+16023131823"] });
    expect(x.facts).toEqual([
      expect.objectContaining({ predicate: "address" }),
      expect.objectContaining({ predicate: "hours", objectValue: "Mon-Fri 9-5" })
    ]);
    expect(profileExtraction({ businessName: "X" }).facts).toEqual([]);
    expect(profileExtraction({ businessName: " " })).toEqual({ entities: [], facts: [] });
  });

  it("leadName pulls the best available name shape", () => {
    expect(leadName({ full_name: "Jane Lead" })).toBe("Jane Lead");
    expect(leadName({ name: "N" })).toBe("N");
    expect(leadName({ first_name: "Jane", last_name: "Lead" })).toBe("Jane Lead");
    expect(leadName({ first_name: "Jane" })).toBe("Jane");
    expect(leadName({ city: "Phoenix" })).toBe("");
  });

  it("leadExtraction: person + lead_source (+campaign/interest when present); nameless leads build nothing", () => {
    const x = leadExtraction({
      source: "facebook_lead_ads",
      fields: { full_name: "Jane Lead", campaign_name: "Spring Promo", interested_in: "selling" },
      phoneE164: "+15550001111",
      email: "jane@x.co"
    });
    expect(x.entities[0]).toMatchObject({ name: "Jane Lead", phones: ["+15550001111"] });
    expect(x.facts).toEqual([
      expect.objectContaining({ predicate: "lead_source", objectValue: "facebook_lead_ads" }),
      expect.objectContaining({ predicate: "campaign", objectValue: "Spring Promo" }),
      expect.objectContaining({ predicate: "interested_in", objectValue: "selling" })
    ]);
    // Nameless but identified: the identifier names the node (booking
    // convention) so lead facts still land; identity-less builds nothing.
    const phoneNamed = leadExtraction({
      source: "s",
      fields: { city: "PHX" },
      phoneE164: "+15550001111"
    });
    expect(phoneNamed.entities[0].name).toBe("+15550001111");
    expect(phoneNamed.facts[0]).toMatchObject({ predicate: "lead_source" });
    expect(
      leadExtraction({ source: "s", fields: { city: "PHX" }, email: "a@b.co" }).entities[0].name
    ).toBe("a@b.co");
    expect(
      leadExtraction({ source: "s", fields: { city: "PHX" } })
    ).toEqual({ entities: [], facts: [] });
    // Minimal lead: source fact only, no phones/emails.
    const minimal = leadExtraction({ source: "s", fields: { name: "J" } });
    expect(minimal.facts).toHaveLength(1);
    expect(minimal.entities[0]).toMatchObject({ phones: [], emails: [] });
  });

  it("bookingExtraction: booked_appointment fact, name falling back to phone/email; identity-less builds nothing", () => {
    const x = bookingExtraction({ phoneE164: "+15550001111", detail: "appointment booked (2026-07-23)" });
    expect(x.entities[0].name).toBe("+15550001111");
    expect(x.facts[0]).toMatchObject({
      predicate: "booked_appointment",
      objectValue: "appointment booked (2026-07-23)"
    });
    expect(bookingExtraction({ email: "a@b.co", detail: "" }).entities[0].name).toBe("a@b.co");
    expect(bookingExtraction({ email: "a@b.co", detail: "" }).facts[0].objectValue).toBe(
      "appointment booked"
    );
    expect(bookingExtraction({ detail: "x" })).toEqual({ entities: [], facts: [] });
  });

  it("docRecordExtraction: snake_cased field facts on the linked contact, capped at 20", () => {
    const x = docRecordExtraction({
      title: "Quote #42",
      fields: { Carrier: "Acme Ins", "Annual Premium!": "$1,200", empty: "  " },
      contactName: "Bryan Buyer",
      contactE164: "+15551234567"
    });
    expect(x.entities[0]).toMatchObject({ name: "Bryan Buyer", phones: ["+15551234567"] });
    expect(x.facts).toEqual([
      expect.objectContaining({ predicate: "carrier", objectValue: "Acme Ins" }),
      expect.objectContaining({ predicate: "annual_premium", objectValue: "$1,200" })
    ]);

    const many = docRecordExtraction({
      title: "T",
      fields: Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}`, `v${i}`])),
      contactE164: "+1555"
    });
    expect(many.facts).toHaveLength(20);

    expect(docRecordExtraction({ title: "T", fields: { a: "b" } })).toEqual({
      entities: [],
      facts: []
    });
    expect(
      docRecordExtraction({ title: "T", fields: { "!!!": "x" }, contactE164: "+1555" })
    ).toEqual({ entities: [], facts: [] });

    // Name without a number: node built with no phones.
    expect(
      docRecordExtraction({ title: "T", fields: { a: "b" }, contactName: "Bob" }).entities[0]
    ).toMatchObject({ name: "Bob", phones: [] });
  });
});

describe("capturedLeadExtraction / ingestCapturedLead (DM lead-capture boundary)", () => {
  it("builds person + interested_in/note facts; nameless captures build nothing", () => {
    const x = capturedLeadExtraction({
      name: " Vera Visitor ",
      phone: "+15550002222",
      email: "v@x.co",
      interest: "kitchen remodel",
      notes: "prefers evenings"
    });
    expect(x.entities[0]).toMatchObject({
      name: "Vera Visitor",
      phones: ["+15550002222"],
      emails: ["v@x.co"]
    });
    expect(x.facts).toEqual([
      expect.objectContaining({ predicate: "interested_in", objectValue: "kitchen remodel" }),
      expect.objectContaining({ predicate: "note", objectValue: "prefers evenings" })
    ]);
    // No interest/notes → entity only; no phone/email → empty contact points.
    const bare = capturedLeadExtraction({ name: "V" });
    expect(bare.facts).toEqual([]);
    expect(bare.entities[0]).toMatchObject({ phones: [], emails: [] });
    expect(capturedLeadExtraction({ phone: "+1555" })).toEqual({ entities: [], facts: [] });
  });

  it("maps channels to registry sources with each channel's trust", async () => {
    const cases: Array<{ channel: "messenger" | "instagram" | "whatsapp" | "webchat"; source: string; trust: number }> = [
      { channel: "messenger", source: "messenger", trust: 1 },
      { channel: "instagram", source: "messenger", trust: 1 },
      { channel: "whatsapp", source: "whatsapp", trust: 1 },
      { channel: "webchat", source: "webchat", trust: 0 }
    ];
    for (const c of cases) {
      const d = deps("active");
      await ingestCapturedLead(BIZ, c.channel, { name: "V", phone: "+1555" }, d);
      expect(d.apply).toHaveBeenCalledWith(
        BIZ,
        expect.anything(),
        expect.anything(),
        {},
        expect.objectContaining({ source: c.source, trust: c.trust, attributedTo: "+1555" })
      );
    }
  });

  it("attribution falls back phone → email → channel", async () => {
    const emailOnly = deps("active");
    await ingestCapturedLead(BIZ, "webchat", { name: "V", email: "v@x.co" }, emailOnly);
    expect(emailOnly.apply).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.anything(),
      {},
      expect.objectContaining({ attributedTo: "v@x.co" })
    );

    const bare = deps("active");
    await ingestCapturedLead(BIZ, "webchat", { name: "V" }, bare);
    expect(bare.apply).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.anything(),
      {},
      expect.objectContaining({ attributedTo: "webchat" })
    );
  });
});

describe("retirePinnedNote (owner cleared the note)", () => {
  const PERSON = {
    id: "e-1",
    business_id: BIZ,
    kind: "person",
    canonical_name: "Joe",
    aliases: [],
    phones: ["+15551234567"],
    emails: [],
    customer_e164: null,
    source: "contacts",
    trust: 3,
    attributed_to: null,
    created_at: "",
    updated_at: ""
  };
  const NOTE_FACT = { id: "f-1" } as never;

  function retireDeps(overrides: Record<string, unknown> = {}) {
    return {
      getMode: vi.fn(async () => "shadow" as const),
      listEntities: vi.fn(async () => [PERSON]),
      listFacts: vi.fn(async () => [NOTE_FACT]),
      deactivate: vi.fn(async () => undefined),
      ...overrides
    } as never;
  }

  it("deactivates the person's active owner_note facts (no successor)", async () => {
    const deps = retireDeps();
    const res = await retirePinnedNote(BIZ, "+15551234567", deps);
    expect(res).toEqual({ retired: 1 });
    const d = deps as { listFacts: ReturnType<typeof vi.fn>; deactivate: ReturnType<typeof vi.fn> };
    expect(d.listFacts).toHaveBeenCalledWith(BIZ, "e-1", "owner_note");
    expect(d.deactivate).toHaveBeenCalledWith(["f-1"]);
  });

  it("no-ops on off mode, unknown numbers, and note-less people", async () => {
    const off = retireDeps({ getMode: vi.fn(async () => "off" as const) });
    expect(await retirePinnedNote(BIZ, "+15551234567", off)).toEqual({ retired: 0 });
    expect((off as { listEntities: ReturnType<typeof vi.fn> }).listEntities).not.toHaveBeenCalled();

    const unknown = retireDeps();
    expect(await retirePinnedNote(BIZ, "+19998887777", unknown)).toEqual({ retired: 0 });
    expect((unknown as { deactivate: ReturnType<typeof vi.fn> }).deactivate).not.toHaveBeenCalled();

    const noteless = retireDeps({ listFacts: vi.fn(async () => []) });
    expect(await retirePinnedNote(BIZ, "+15551234567", noteless)).toEqual({ retired: 0 });
    expect((noteless as { deactivate: ReturnType<typeof vi.fn> }).deactivate).not.toHaveBeenCalled();
  });

  it("never throws (Error and non-Error)", async () => {
    const failing = retireDeps({
      deactivate: vi.fn(async () => {
        throw new Error("db down");
      })
    });
    expect(await retirePinnedNote(BIZ, "+15551234567", failing)).toEqual({ retired: 0 });

    const weird = retireDeps({ getMode: vi.fn(async () => Promise.reject("string throw")) });
    expect(await retirePinnedNote(BIZ, "+15551234567", weird)).toEqual({ retired: 0 });
  });
});

describe("per-source ingest wrappers carry registry provenance", () => {
  const CASES: Array<{
    run: (d: ReturnType<typeof deps>) => Promise<{ ran: boolean }>;
    source: string;
    trust: number;
    attributedTo?: string | null;
  }> = [
    {
      run: (d) => ingestRosterMember(BIZ, { name: "Jason" }, d),
      source: "team_roster",
      trust: 3,
      attributedTo: null
    },
    {
      run: (d) => ingestContact(BIZ, { displayName: "B", e164: "+1555" }, d),
      source: "contacts",
      trust: 3,
      attributedTo: null
    },
    {
      run: (d) => ingestPinnedNote(BIZ, { displayName: "B", e164: "+1555", note: "vip" }, d),
      source: "customer_pinned_notes",
      trust: 3,
      attributedTo: null
    },
    {
      run: (d) => ingestBusinessProfile(BIZ, { businessName: "Acme" }, d),
      source: "business_profile",
      trust: 3,
      attributedTo: null
    },
    {
      run: (d) =>
        ingestLeadSubmission(BIZ, { source: "facebook_lead_ads", fields: { name: "J" } }, d),
      source: "aiflow_lead",
      trust: 0,
      attributedTo: "facebook_lead_ads"
    },
    {
      run: (d) => ingestBooking(BIZ, { phoneE164: "+1555", detail: "booked" }, d),
      source: "booking",
      trust: 2,
      attributedTo: null
    },
    {
      run: (d) =>
        ingestDocRecordFields(
          BIZ,
          { title: "Quote", fields: { carrier: "Acme" }, contactE164: "+1555" },
          d
        ),
      source: "doc_extract_fields",
      trust: 2,
      attributedTo: "Quote"
    }
  ];

  for (const test of CASES) {
    it(`${test.source} → trust ${test.trust}`, async () => {
      const d = deps("active");
      const res = await test.run(d);
      expect(res.ran).toBe(true);
      expect(d.apply).toHaveBeenCalledWith(
        BIZ,
        expect.anything(),
        expect.anything(),
        {},
        expect.objectContaining({
          source: test.source,
          trust: test.trust,
          ...(test.attributedTo !== undefined ? { attributedTo: test.attributedTo } : {})
        })
      );
    });
  }

  it("a lead with an empty source label attributes to 'webhook'", async () => {
    const d = deps("active");
    await ingestLeadSubmission(BIZ, { source: "  ", fields: { name: "J" } }, d);
    expect(d.apply).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.anything(),
      {},
      expect.objectContaining({ attributedTo: "webhook" })
    );
  });

  it("a doc with a blank title attributes to null", async () => {
    const d = deps("active");
    await ingestDocRecordFields(
      BIZ,
      { title: " ", fields: { carrier: "Acme" }, contactE164: "+1555" },
      d
    );
    expect(d.apply).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.anything(),
      {},
      expect.objectContaining({ attributedTo: null })
    );
  });
});

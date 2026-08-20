import { describe, expect, it } from "vitest";

import {
  FUB_EXTERNAL_SOURCE,
  FUB_STAGE_TO_LIFECYCLE_TAG,
  dealStatusFromStageName,
  fubStageTag,
  mapFubDeal,
  mapFubNote,
  mapFubPerson,
  stripHtml
} from "@/lib/fub-import/map";
import { NOTE_AUTHOR_LABEL_MAX, NOTE_BODY_MAX } from "@/lib/notes/core";
import { MAX_DEAL_TITLE_LENGTH, MAX_DEAL_VALUE_CENTS } from "@/lib/deals/core";

const NOW = "2026-08-20T12:00:00.000Z";

describe("fubStageTag", () => {
  it("maps every fixed FUB stage to its lifecycle tag, case-insensitively", () => {
    expect(fubStageTag("Lead")).toBe("New Lead");
    expect(fubStageTag("HOT PROSPECT")).toBe("Engaged");
    expect(fubStageTag("nurture")).toBe("Contacted");
    expect(fubStageTag("Attempted Contact")).toBe("Contacted");
    expect(fubStageTag("contacted")).toBe("Contacted");
    expect(fubStageTag("Active Client")).toBe("Engaged");
    expect(fubStageTag("Pending")).toBe("Booked");
    // The table is the contract: every key resolves.
    for (const key of Object.keys(FUB_STAGE_TO_LIFECYCLE_TAG)) {
      expect(fubStageTag(key)).toBe(FUB_STAGE_TO_LIFECYCLE_TAG[key]);
    }
  });

  it("falls back to a fub:<stage> tag, clamped to the tag length cap", () => {
    expect(fubStageTag("Past Client")).toBe("fub:past client");
    expect(fubStageTag(`Very${"y".repeat(60)} Custom`)).toHaveLength(40);
  });

  it("returns null for blank stages", () => {
    expect(fubStageTag("")).toBeNull();
    expect(fubStageTag("   ")).toBeNull();
    expect(fubStageTag(null)).toBeNull();
    expect(fubStageTag(undefined)).toBeNull();
  });
});

describe("mapFubPerson", () => {
  it("keys by the first phone that normalizes, keeping the email on the side", () => {
    const mapped = mapFubPerson({
      id: 7,
      name: "Jane Doe",
      stage: "Lead",
      source: "Zillow",
      tags: ["buyer"],
      emails: [{ value: "Jane@Example.com" }],
      phones: [{ value: "not-a-number" }, { value: "(602) 555-1234" }]
    });
    expect(mapped).toEqual({
      ok: true,
      value: {
        key: "+16025551234",
        email: "jane@example.com",
        name: "Jane Doe",
        leadSource: "Zillow",
        tags: ["New Lead", "buyer"]
      }
    });
  });

  it("keys by email when there is no usable phone", () => {
    const mapped = mapFubPerson({
      id: 8,
      firstName: "Sam",
      lastName: "Okoye",
      emails: [{ value: "sam@example.com" }]
    });
    expect(mapped).toEqual({
      ok: true,
      value: {
        key: "email:sam@example.com",
        email: "sam@example.com",
        name: "Sam Okoye",
        leadSource: null,
        tags: []
      }
    });
  });

  it("skips a person with no usable phone or email, naming them in the reason", () => {
    const mapped = mapFubPerson({ id: 9, phones: [{ value: "abc" }], emails: [{ value: "nope" }] });
    expect(mapped).toEqual({
      ok: false,
      reason: "person 9: no usable phone number or email address"
    });
  });

  it("tolerates missing arrays and empty values", () => {
    const mapped = mapFubPerson({ id: 10, phones: [{ value: null }, {}], emails: null });
    expect(mapped.ok).toBe(false);
    const nullEmailValues = mapFubPerson({
      id: 10,
      phones: [{ value: "+16025559999" }],
      emails: [{ value: null }, {}]
    });
    expect(nullEmailValues.ok && nullEmailValues.value.email).toBeNull();
  });

  it("builds the name from first/last only when the full name is blank, else null", () => {
    const fromParts = mapFubPerson({
      id: 11,
      name: "  ",
      firstName: " Ana ",
      phones: [{ value: "+16025550000" }]
    });
    expect(fromParts.ok && fromParts.value.name).toBe("Ana");
    const nameless = mapFubPerson({ id: 12, phones: [{ value: "+16025550001" }] });
    expect(nameless.ok && nameless.value.name).toBeNull();
  });

  it("clamps lead source to the column cap and drops blanks", () => {
    const long = mapFubPerson({
      id: 13,
      source: "s".repeat(300),
      phones: [{ value: "+16025550002" }]
    });
    expect(long.ok && long.value.leadSource).toHaveLength(120);
    const blank = mapFubPerson({ id: 14, source: "  ", phones: [{ value: "+16025550003" }] });
    expect(blank.ok && blank.value.leadSource).toBeNull();
  });

  it("normalizes stage tag + passthrough tags together (dedup, first spelling wins)", () => {
    const mapped = mapFubPerson({
      id: 15,
      stage: "Lead",
      tags: ["new lead", "VIP", "vip"],
      phones: [{ value: "+16025550004" }]
    });
    expect(mapped.ok && mapped.value.tags).toEqual(["New Lead", "VIP"]);
  });
});

describe("stripHtml", () => {
  it("turns breaks and block closers into newlines and drops other tags", () => {
    expect(stripHtml("<p>Hello<br/>there</p><div>friend</div>")).toBe("Hello\nthere\nfriend");
  });

  it("decodes the common entities and collapses whitespace", () => {
    expect(stripHtml("A &amp; B &lt;c&gt; &nbsp; &#39;d&#039; &quot;e&quot;   \n\n\n\nf")).toBe(
      "A & B <c>   'd' \"e\"\n\nf"
    );
  });
});

describe("mapFubNote", () => {
  it("joins subject and body, strips HTML bodies, and keeps FUB timestamps", () => {
    const mapped = mapFubNote(
      {
        id: 42,
        subject: "Call recap",
        body: "<p>Went&nbsp;great</p>",
        isHtml: true,
        createdBy: "Agent Amy",
        created: "2026-01-02T03:04:05Z",
        updated: "2026-01-03T03:04:05Z"
      },
      NOW
    );
    expect(mapped).toEqual({
      ok: true,
      value: {
        author_label: "Agent Amy",
        body: "Call recap\n\nWent great",
        external_source: FUB_EXTERNAL_SOURCE,
        external_id: "42",
        created_at: "2026-01-02T03:04:05Z",
        updated_at: "2026-01-03T03:04:05Z"
      }
    });
  });

  it("skips notes that are empty once stripped", () => {
    expect(mapFubNote({ id: 43, body: "<p>  </p>", isHtml: true }, NOW)).toEqual({
      ok: false,
      reason: "note 43: empty body"
    });
  });

  it("keeps a subject-only note (no body at all)", () => {
    const mapped = mapFubNote({ id: 47, subject: "Left voicemail" }, NOW);
    expect(mapped.ok && mapped.value.body).toBe("Left voicemail");
  });

  it("falls back: author to a generic label, created to now, updated to created", () => {
    const mapped = mapFubNote({ id: 44, body: "plain", created: "garbage" }, NOW);
    expect(mapped.ok && mapped.value.author_label).toBe("Follow Up Boss");
    expect(mapped.ok && mapped.value.created_at).toBe(NOW);
    expect(mapped.ok && mapped.value.updated_at).toBe(NOW);
    const withCreated = mapFubNote({ id: 45, body: "x", created: "2026-01-01T00:00:00Z" }, NOW);
    expect(withCreated.ok && withCreated.value.updated_at).toBe("2026-01-01T00:00:00Z");
  });

  it("clamps body and author label to the platform caps", () => {
    const mapped = mapFubNote(
      { id: 46, body: "b".repeat(NOTE_BODY_MAX + 50), createdBy: "a".repeat(200) },
      NOW
    );
    expect(mapped.ok && mapped.value.body).toHaveLength(NOTE_BODY_MAX);
    expect(mapped.ok && mapped.value.author_label).toHaveLength(NOTE_AUTHOR_LABEL_MAX);
  });
});

describe("dealStatusFromStageName", () => {
  it("checks lost before won/closed so Closed Lost never reads as a win", () => {
    expect(dealStatusFromStageName("Closed Lost")).toBe("lost");
    expect(dealStatusFromStageName("Lost")).toBe("lost");
    expect(dealStatusFromStageName("Closed Won")).toBe("won");
    expect(dealStatusFromStageName("Won!")).toBe("won");
    expect(dealStatusFromStageName("Closed")).toBe("won");
    expect(dealStatusFromStageName("Under Contract")).toBe("under_contract");
    expect(dealStatusFromStageName("Pending Inspection")).toBe("under_contract");
    expect(dealStatusFromStageName("Showing Homes")).toBe("open");
    expect(dealStatusFromStageName(null)).toBe("open");
    expect(dealStatusFromStageName(undefined)).toBe("open");
  });
});

describe("mapFubDeal", () => {
  const stages = { "3": "Closed Won", "4": "Under Contract" };

  it("maps an active deal: dollars to cents, stage heuristic, close date, ids", () => {
    const mapped = mapFubDeal(
      {
        id: 88,
        name: "123 Main St",
        price: 350000.4,
        stageId: 4,
        people: [{ id: 12 }],
        projectedCloseDate: "2026-09-15T00:00:00Z",
        status: "Active",
        createdAt: "2026-05-01T00:00:00Z"
      },
      stages,
      NOW
    );
    expect(mapped).toEqual({
      ok: true,
      value: {
        title: "123 Main St",
        value_cents: 35000040,
        currency: "USD",
        expected_close_date: "2026-09-15",
        status: "under_contract",
        won_at: null,
        lost_at: null,
        external_source: FUB_EXTERNAL_SOURCE,
        external_id: "88",
        created_at: "2026-05-01T00:00:00Z",
        updated_at: NOW,
        personId: 12
      }
    });
  });

  it("stamps won_at from enteredStageAt, then createdAt, then now", () => {
    const base = { id: 89, stageId: 3, status: "Active" };
    const entered = mapFubDeal(
      { ...base, enteredStageAt: "2026-06-01T00:00:00Z", createdAt: "2026-05-01T00:00:00Z" },
      stages,
      NOW
    );
    expect(entered.ok && entered.value.won_at).toBe("2026-06-01T00:00:00Z");
    const created = mapFubDeal({ ...base, createdAt: "2026-05-01T00:00:00Z" }, stages, NOW);
    expect(created.ok && created.value.won_at).toBe("2026-05-01T00:00:00Z");
    const bare = mapFubDeal(base, stages, NOW);
    expect(bare.ok && bare.value.won_at).toBe(NOW);
    expect(bare.ok && bare.value.created_at).toBe(NOW);
  });

  it("stamps lost_at for lost stages", () => {
    const mapped = mapFubDeal(
      { id: 90, stageId: 5, status: "Active", enteredStageAt: "2026-06-02T00:00:00Z" },
      { "5": "Closed Lost" },
      NOW
    );
    expect(mapped.ok && mapped.value.status).toBe("lost");
    expect(mapped.ok && mapped.value.lost_at).toBe("2026-06-02T00:00:00Z");
    expect(mapped.ok && mapped.value.won_at).toBeNull();
  });

  it("skips archived and deleted records, naming the state", () => {
    expect(mapFubDeal({ id: 91, status: "Archived" }, stages, NOW)).toEqual({
      ok: false,
      reason: "deal 91: archived in Follow Up Boss"
    });
    expect(mapFubDeal({ id: 92, status: "Deleted" }, stages, NOW).ok).toBe(false);
  });

  it("treats a missing record status as active", () => {
    expect(mapFubDeal({ id: 93 }, stages, NOW).ok).toBe(true);
  });

  it("falls back to a generated title, clamped to the deal title cap", () => {
    const untitled = mapFubDeal({ id: 94, name: "  " }, stages, NOW);
    expect(untitled.ok && untitled.value.title).toBe("Follow Up Boss deal 94");
    const long = mapFubDeal({ id: 95, name: "x".repeat(500) }, stages, NOW);
    expect(long.ok && long.value.title).toHaveLength(MAX_DEAL_TITLE_LENGTH);
  });

  it("treats zero, negative, or junk prices as unsized and caps huge ones", () => {
    expect(mapFubDeal({ id: 96, price: 0 }, stages, NOW).ok && null).toBeFalsy();
    const zero = mapFubDeal({ id: 96, price: 0 }, stages, NOW);
    expect(zero.ok && zero.value.value_cents).toBeNull();
    const negative = mapFubDeal({ id: 97, price: -5 }, stages, NOW);
    expect(negative.ok && negative.value.value_cents).toBeNull();
    const junk = mapFubDeal({ id: 98, price: Number.NaN }, stages, NOW);
    expect(junk.ok && junk.value.value_cents).toBeNull();
    const huge = mapFubDeal({ id: 99, price: 10 ** 16 }, stages, NOW);
    expect(huge.ok && huge.value.value_cents).toBe(MAX_DEAL_VALUE_CENTS);
  });

  it("drops close dates that are not date-shaped", () => {
    const bad = mapFubDeal({ id: 100, projectedCloseDate: "soon" }, stages, NOW);
    expect(bad.ok && bad.value.expected_close_date).toBeNull();
  });

  it("handles unknown stages, missing stageId, and missing people", () => {
    const unknownStage = mapFubDeal({ id: 101, stageId: 999 }, stages, NOW);
    expect(unknownStage.ok && unknownStage.value.status).toBe("open");
    const noStage = mapFubDeal({ id: 102 }, stages, NOW);
    expect(noStage.ok && noStage.value.status).toBe("open");
    expect(noStage.ok && noStage.value.personId).toBeNull();
    const emptyPeople = mapFubDeal({ id: 103, people: [] }, stages, NOW);
    expect(emptyPeople.ok && emptyPeople.value.personId).toBeNull();
  });
});

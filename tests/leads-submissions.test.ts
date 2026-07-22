import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

const warnSpy = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => warnSpy(...a) }
}));

import {
  MAX_SUBMISSION_FIELDS,
  MAX_SUBMISSION_KEY_LENGTH,
  MAX_SUBMISSION_VALUE_LENGTH,
  extractLeadgenId,
  extractSubmissionIdentifiers,
  flattenSubmissionFields,
  recordLeadSubmission
} from "@/lib/leads/submissions";

function upsertDb(result: { error: unknown } = { error: null }) {
  const upsert = vi.fn((..._args: unknown[]) => Promise.resolve(result));
  return { db: { from: vi.fn(() => ({ upsert })) }, upsert };
}

beforeEach(() => {
  defaultClientSpy.mockReset();
  warnSpy.mockReset();
});

describe("flattenSubmissionFields", () => {
  it("flattens nested objects with dotted keys and arrays with indices", () => {
    expect(
      flattenSubmissionFields({
        name: "Jane",
        field_data: { city: "Phoenix" },
        tags: ["a", "b"]
      })
    ).toEqual({
      name: "Jane",
      "field_data.city": "Phoenix",
      "tags.0": "a",
      "tags.1": "b"
    });
  });

  it("skips null/undefined values and stringifies scalars", () => {
    expect(
      flattenSubmissionFields({ a: null, b: undefined, n: 7, ok: true })
    ).toEqual({ n: "7", ok: "true" });
  });

  it("bounds key/value lengths and the field count", () => {
    const big: Record<string, unknown> = {};
    for (let i = 0; i < MAX_SUBMISSION_FIELDS + 20; i++) big[`k${i}`] = "v";
    const flattened = flattenSubmissionFields(big);
    expect(Object.keys(flattened).length).toBe(MAX_SUBMISSION_FIELDS);

    const long = flattenSubmissionFields({
      ["k".repeat(200)]: "v".repeat(2000)
    });
    const [key, value] = Object.entries(long)[0];
    expect(key.length).toBe(MAX_SUBMISSION_KEY_LENGTH);
    expect(value.length).toBe(MAX_SUBMISSION_VALUE_LENGTH);
  });

  it("stops descending past depth 4 (hostile nesting)", () => {
    expect(
      flattenSubmissionFields({ a: { b: { c: { d: { e: { f: "too deep" } } } } } })
    ).toEqual({});
  });

  it("drops an empty-string key (no column to render it under)", () => {
    expect(flattenSubmissionFields({ "": "orphan", ok: "kept" })).toEqual({ ok: "kept" });
  });
});

describe("extractSubmissionIdentifiers", () => {
  it("takes the phone only from a phone-named key (E.164 or loose NANP)", () => {
    expect(
      extractSubmissionIdentifiers({ phone_number: "+16025551234" }).phoneE164
    ).toBe("+16025551234");
    expect(
      extractSubmissionIdentifiers({ Mobile: "(602) 555-1234" }).phoneE164
    ).toBe("+16025551234");
    // A phone-shaped value under a NON-phone key must not qualify.
    expect(
      extractSubmissionIdentifiers({ notes: "call (602) 555-1234" }).phoneE164
    ).toBeNull();
    // An unparseable value under a phone key yields null.
    expect(extractSubmissionIdentifiers({ phone: "soon" }).phoneE164).toBeNull();
  });

  it("prefers an email-named key, falls back to any email-shaped value, lowercases", () => {
    expect(
      extractSubmissionIdentifiers({
        contact: "Jane@Example.com",
        email: "REAL@Example.com"
      }).email
    ).toBe("real@example.com");
    expect(
      extractSubmissionIdentifiers({ contact: "Jane@Example.com" }).email
    ).toBe("jane@example.com");
    // An email key with a non-address value does not block the fallback.
    expect(
      extractSubmissionIdentifiers({ email: "none", other: "x@y.co" }).email
    ).toBe("x@y.co");
  });

  it("ignores blank values and returns nulls when nothing matches", () => {
    expect(extractSubmissionIdentifiers({ phone: "  ", note: "hi" })).toEqual({
      phoneE164: null,
      email: null
    });
  });
});

describe("extractLeadgenId", () => {
  it("prefers an explicit leadgen_id (string or number, l:-prefixed ok)", () => {
    expect(extractLeadgenId({ leadgen_id: "1993202861289031" }, "evt")).toBe(
      "1993202861289031"
    );
    expect(extractLeadgenId({ leadgen_id: 1993202861289031 }, "evt")).toBe(
      "1993202861289031"
    );
    expect(extractLeadgenId({ leadgen_id: "l:1993202861289031" }, "evt")).toBe(
      "1993202861289031"
    );
  });

  it("falls back to a digits-only event key (the direct webhook path)", () => {
    expect(extractLeadgenId({}, "1993202861289031")).toBe("1993202861289031");
  });

  it("returns null when neither candidate looks like a Meta id", () => {
    expect(extractLeadgenId({ leadgen_id: "abc" }, "sha-of-payload")).toBeNull();
    expect(extractLeadgenId({}, "123")).toBeNull();
  });
});

describe("recordLeadSubmission", () => {
  const INPUT = {
    source: "facebook_lead_ads",
    eventKey: "1993202861289031",
    data: {
      full_name: "Jane Lead",
      phone_number: "+16025551234",
      email: "Jane@Example.com"
    }
  };

  it("upserts one row with extracted identifiers, ignore-duplicates", async () => {
    const { db, upsert } = upsertDb();
    await recordLeadSubmission("biz-1", INPUT, db as never);
    expect(upsert).toHaveBeenCalledWith(
      {
        business_id: "biz-1",
        source: "facebook_lead_ads",
        event_key: "1993202861289031",
        leadgen_id: "1993202861289031",
        fields: {
          full_name: "Jane Lead",
          phone_number: "+16025551234",
          email: "Jane@Example.com"
        },
        phone_e164: "+16025551234",
        email: "jane@example.com"
      },
      { onConflict: "business_id,event_key", ignoreDuplicates: true }
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("bounds source and event_key lengths", async () => {
    const { db, upsert } = upsertDb();
    await recordLeadSubmission(
      "biz-1",
      { ...INPUT, source: "s".repeat(300), eventKey: "k".repeat(300) },
      db as never
    );
    const row = upsert.mock.calls[0][0] as unknown as {
      source: string;
      event_key: string;
    };
    expect(row.source.length).toBe(120);
    expect(row.event_key.length).toBe(200);
  });

  it("never throws: a db error is swallowed with a warning", async () => {
    const { db } = upsertDb({ error: { message: "down" } });
    await expect(
      recordLeadSubmission("biz-1", INPUT, db as never)
    ).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "lead submission record failed (ignored)",
      expect.objectContaining({ businessId: "biz-1", error: "down" })
    );
  });

  it("uses the default client when none is injected (and survives its failure)", async () => {
    const { db, upsert } = upsertDb();
    defaultClientSpy.mockResolvedValueOnce(db);
    await recordLeadSubmission("biz-1", INPUT);
    expect(upsert).toHaveBeenCalledTimes(1);

    defaultClientSpy.mockRejectedValueOnce(new Error("no client"));
    await expect(recordLeadSubmission("biz-1", INPUT)).resolves.toBeUndefined();
    expect(warnSpy).toHaveBeenCalledWith(
      "lead submission record failed (ignored)",
      expect.objectContaining({ error: "no client" })
    );
  });

  it("stringifies a non-Error failure", async () => {
    defaultClientSpy.mockRejectedValueOnce("boom");
    await recordLeadSubmission("biz-1", INPUT);
    expect(warnSpy).toHaveBeenCalledWith(
      "lead submission record failed (ignored)",
      expect.objectContaining({ error: "boom" })
    );
  });
});

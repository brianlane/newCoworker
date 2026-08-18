import { describe, expect, it, vi } from "vitest";
import {
  contactLanguageStateFromRow,
  detectAndPersistCustomerLanguage,
  persistDetectedContactLanguage,
  readContactLanguageState,
  resolveThreadLanguage
} from "../supabase/functions/_shared/customer_language_persist";

/**
 * The shared detect-and-persist path for a contact's language.
 *
 * The bug this module exists to fix: detection used to live inline in the SMS
 * reply path, so any turn an AiFlow owned (a parked wait_for_reply, or a flow
 * with suppressDefaultReply) never recorded language at all. A lead answering
 * a flow's question in Spanish stayed flagged English forever.
 */

type Call = { table: string; op: string; payload?: unknown; filter?: string };

/**
 * Minimal contacts-table fake: records every write, answers the single
 * maybeSingle() read with `row`.
 */
function makeDb(opts: { row?: unknown; readError?: boolean; insertError?: boolean } = {}) {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      return {
        select() {
          // The read is `.eq(business_id)` then EITHER `.or(alias filter)` for a
          // number key OR a second `.eq(customer_e164)` for an email key, so the
          // chain has to accept both shapes.
          const terminal = {
            maybeSingle: async () => {
              calls.push({ table, op: "select", filter: lastFilter });
              if (opts.readError) throw new Error("read boom");
              return { data: opts.row ?? null };
            }
          };
          let lastFilter: string | undefined;
          const afterBiz = {
            or(filter: string) {
              lastFilter = `or:${filter}`;
              return terminal;
            },
            eq(column: string, value: unknown) {
              lastFilter = `eq:${column}=${String(value)}`;
              return terminal;
            }
          };
          return { eq: () => afterBiz };
        },
        update(payload: unknown) {
          calls.push({ table, op: "update", payload });
          return {
            eq() {
              return { eq: async () => ({ error: null }) };
            }
          };
        },
        insert: async (payload: unknown) => {
          calls.push({ table, op: "insert", payload });
          return { error: opts.insertError ? { message: "dup" } : null };
        }
      };
    }
  };
  return { db, calls };
}

const EN_TEXT = "Hi, I want to book an appointment for Friday please";
const ES_TEXT = "Hola, quiero agendar una cita para el viernes por la tarde";

describe("contactLanguageStateFromRow", () => {
  it("reads the stored language, source, and alias-aware primary number", () => {
    expect(
      contactLanguageStateFromRow({
        customer_e164: "+15551112222",
        preferred_language: "es",
        language_source: "detected"
      })
    ).toEqual({
      preferred: "es",
      source: "detected",
      primaryE164: "+15551112222",
      exists: true
    });
  });

  it("treats a missing row as first contact", () => {
    for (const row of [null, undefined]) {
      expect(contactLanguageStateFromRow(row)).toEqual({
        preferred: null,
        source: null,
        primaryE164: null,
        exists: false
      });
    }
  });

  it("tolerates a row with no language columns set", () => {
    expect(contactLanguageStateFromRow({ customer_e164: "+1555" })).toEqual({
      preferred: null,
      source: null,
      primaryE164: "+1555",
      exists: true
    });
  });

  it("tolerates a row whose primary number is missing or not a string", () => {
    for (const row of [{ preferred_language: "es" }, { customer_e164: 42 }]) {
      expect(contactLanguageStateFromRow(row)).toMatchObject({
        primaryE164: null,
        exists: true
      });
    }
  });
});

describe("readContactLanguageState", () => {
  it("reads the row", async () => {
    const { db } = makeDb({ row: { customer_e164: "+1555", preferred_language: "es" } });
    const state = await readContactLanguageState(db, "biz", "+1555");
    expect(state.preferred).toBe("es");
  });

  it("answers 'nothing stored' when the read throws (never breaks an inbound path)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { db } = makeDb({ readError: true });
    expect(await readContactLanguageState(db, "biz", "+1555")).toEqual({
      preferred: null,
      source: null,
      primaryE164: null,
      exists: false
    });
    errSpy.mockRestore();
  });
});

describe("email-keyed contacts", () => {
  it("reads with an exact match, never the alias filter", async () => {
    // alias_e164s only ever holds NUMBERS a merge folded away, and an address
    // in a comma-delimited PostgREST filter is an escaping hazard.
    const { db, calls } = makeDb({ row: null });
    await readContactLanguageState(db, "biz", "email:val@example.com");
    expect(calls[0]?.filter).toBe("eq:customer_e164=email:val@example.com");
  });

  it("still uses the alias filter for a number key", async () => {
    const { db, calls } = makeDb({ row: null });
    await readContactLanguageState(db, "biz", "+16025551234");
    expect(calls[0]?.filter).toMatch(/^or:customer_e164\.eq\.\+16025551234,alias_e164s/);
  });

  it("carries the address into the first-contact INSERT", async () => {
    // Without `email`, the DB constraint contacts_email_key_matches_email
    // rejects the row and the detected language is silently lost.
    const { db, calls } = makeDb();
    await persistDetectedContactLanguage(db, "biz", "email:val@example.com", "es", {
      preferred: null,
      source: null,
      primaryE164: null,
      exists: false
    });
    expect(calls.find((c) => c.op === "insert")?.payload).toEqual({
      business_id: "biz",
      customer_e164: "email:val@example.com",
      email: "val@example.com",
      preferred_language: "es",
      language_source: "detected"
    });
  });
});

describe("persistDetectedContactLanguage", () => {
  it("never overwrites an owner override", async () => {
    const { db, calls } = makeDb();
    await persistDetectedContactLanguage(db, "biz", "+1555", "es", {
      preferred: "en",
      source: "owner_set",
      primaryE164: "+1555",
      exists: true
    });
    expect(calls.filter((c) => c.op !== "select")).toEqual([]);
  });

  it("updates the surviving profile's PRIMARY number, not the alias", async () => {
    const { db, calls } = makeDb();
    await persistDetectedContactLanguage(db, "biz", "+1999alias", "es", {
      preferred: null,
      source: null,
      primaryE164: "+1555primary",
      exists: true
    });
    const update = calls.find((c) => c.op === "update");
    expect(update?.payload).toEqual({ preferred_language: "es", language_source: "detected" });
  });

  it("falls back to the given number when the row carries no primary", async () => {
    const { db, calls } = makeDb();
    await persistDetectedContactLanguage(db, "biz", "+1555", "es", {
      preferred: null,
      source: null,
      primaryE164: null,
      exists: true
    });
    expect(calls.some((c) => c.op === "update")).toBe(true);
    expect(calls.some((c) => c.op === "insert")).toBe(false);
  });

  it("inserts on first contact (an UPDATE would hit zero rows)", async () => {
    const { db, calls } = makeDb();
    await persistDetectedContactLanguage(db, "biz", "+1555", "es", {
      preferred: null,
      source: null,
      primaryE164: null,
      exists: false
    });
    expect(calls.find((c) => c.op === "insert")?.payload).toEqual({
      business_id: "biz",
      customer_e164: "+1555",
      preferred_language: "es",
      language_source: "detected"
    });
  });

  it("falls back to an update when the insert races a concurrent create", async () => {
    const { db, calls } = makeDb({ insertError: true });
    await persistDetectedContactLanguage(db, "biz", "+1555", "es", {
      preferred: null,
      source: null,
      primaryE164: null,
      exists: false
    });
    expect(calls.filter((c) => c.op === "insert")).toHaveLength(1);
    expect(calls.filter((c) => c.op === "update")).toHaveLength(1);
  });

  it("swallows write failures (language is an enhancement, not a gate)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from() {
        throw new Error("write boom");
      }
    };
    await expect(
      persistDetectedContactLanguage(db, "biz", "+1555", "es", {
        preferred: null,
        source: null,
        primaryE164: null,
        exists: true
      })
    ).resolves.toBeUndefined();
    errSpy.mockRestore();
  });
});

describe("resolveThreadLanguage", () => {
  const detectedEs = { language: "es" as const, persist: true, confidence: "high" as const };
  const weak = { language: "en" as const, persist: false, confidence: "low" as const };

  it("an owner override wins over any detection", () => {
    expect(
      resolveThreadLanguage(
        { preferred: "en", source: "owner_set", primaryE164: null, exists: true },
        detectedEs
      )
    ).toBe("en");
  });

  it("a confident detection wins (mid-thread switch)", () => {
    expect(
      resolveThreadLanguage(
        { preferred: "en", source: "detected", primaryE164: null, exists: true },
        detectedEs
      )
    ).toBe("es");
  });

  it("a weak signal keeps the stored language", () => {
    expect(
      resolveThreadLanguage(
        { preferred: "es", source: "detected", primaryE164: null, exists: true },
        weak
      )
    ).toBe("es");
  });

  it("falls back to the detected language when nothing is stored", () => {
    expect(
      resolveThreadLanguage(
        { preferred: null, source: null, primaryE164: null, exists: false },
        weak
      )
    ).toBe("en");
  });
});

describe("detectAndPersistCustomerLanguage", () => {
  it("persists a confident Spanish reply on first contact", async () => {
    const { db, calls } = makeDb();
    const result = await detectAndPersistCustomerLanguage({
      supabase: db,
      businessId: "biz",
      customerE164: "+1555",
      text: ES_TEXT,
      defaultLanguage: "en",
      supported: ["en", "es"]
    });
    expect(result.detected.language).toBe("es");
    expect(result.threadLanguage).toBe("es");
    expect(calls.some((c) => c.op === "insert")).toBe(true);
  });

  it("writes nothing for an English reply that is already the stored language", async () => {
    const { db, calls } = makeDb({
      row: { customer_e164: "+1555", preferred_language: "en", language_source: "detected" }
    });
    const result = await detectAndPersistCustomerLanguage({
      supabase: db,
      businessId: "biz",
      customerE164: "+1555",
      text: EN_TEXT,
      defaultLanguage: "en",
      supported: ["en", "es"]
    });
    expect(result.detected.language).toBe("en");
    // A same-value write is harmless but pointless; what matters is that the
    // stored language is what the prompt follows.
    expect(result.threadLanguage).toBe("en");
    expect(calls.some((c) => c.op === "select")).toBe(true);
  });

  it("persists NOTHING for a weak signal (a bare 'ok' must not flip a thread)", async () => {
    const { db, calls } = makeDb({
      row: { customer_e164: "+1555", preferred_language: "en", language_source: "detected" }
    });
    const result = await detectAndPersistCustomerLanguage({
      supabase: db,
      businessId: "biz",
      customerE164: "+1555",
      text: "ok",
      defaultLanguage: "en",
      supported: ["en", "es"]
    });
    expect(result.detected.persist).toBe(false);
    expect(calls.some((c) => c.op === "update" || c.op === "insert")).toBe(false);
    expect(result.threadLanguage).toBe("en");
  });

  it("reuses a caller-supplied state instead of re-reading (the reply path)", async () => {
    const { db, calls } = makeDb();
    await detectAndPersistCustomerLanguage({
      supabase: db,
      businessId: "biz",
      customerE164: "+1555",
      text: ES_TEXT,
      defaultLanguage: "en",
      supported: ["en", "es"],
      state: { preferred: "en", source: "detected", primaryE164: "+1555", exists: true }
    });
    expect(calls.filter((c) => c.op === "select")).toHaveLength(0);
  });

  it("an English-only tenant never persists Spanish", async () => {
    const { db, calls } = makeDb();
    const result = await detectAndPersistCustomerLanguage({
      supabase: db,
      businessId: "biz",
      customerE164: "+1555",
      text: ES_TEXT,
      defaultLanguage: "en",
      supported: ["en"]
    });
    expect(result.detected.language).toBe("en");
    expect(calls.some((c) => c.op === "insert")).toBe(true);
    expect(calls.find((c) => c.op === "insert")?.payload).toMatchObject({
      preferred_language: "en"
    });
  });
});

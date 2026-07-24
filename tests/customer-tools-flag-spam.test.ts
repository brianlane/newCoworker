/**
 * flag_contact_spam core (src/lib/customer-tools/flag-spam.ts): opt-out
 * suppression fails the call honestly, the identity set (canonical +
 * aliases) is fully covered, pending-run cancels are revision-gated and
 * best-effort, contact tag/note writes are idempotent, cap-guarded, and
 * hook-free, the note mirrors real outcomes, and nothing ever throws.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  SPAM_CANCELED_BY,
  SPAM_TAG,
  flagContactSpam
} from "@/lib/customer-tools/flag-spam";

const BIZ = "11111111-1111-4111-8111-111111111111";
const PHONE = "+12038097763";
const CANONICAL = "+16025550111";

type Scripted = { data?: unknown; error?: unknown };

/**
 * Chainable builder (mirrors ai-flows-response-stop.test.ts): pops one
 * scripted result per terminal await, records every call for wire-shape
 * assertions. Scripted order: contact read, runs lookup, per-run updates,
 * contact insert/update.
 */
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "insert", "eq", "or", "in", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

function deps(db: unknown, overrides: Record<string, unknown> = {}) {
  return {
    createDb: vi.fn(async () => db) as never,
    setOptOut: vi.fn(async () => ({ isNew: true })) as never,
    ...overrides
  };
}

/** A pending run as the candidate lookup returns it. */
function runRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    status: "awaiting_reply",
    context: { vars: { lead_phone: PHONE }, trigger: { from: PHONE } },
    revision: 3,
    ...over
  };
}

/** A contact row as the lookup returns it. */
function contactRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    customer_e164: PHONE,
    alias_e164s: [],
    tags: [],
    pinned_md: null,
    ...over
  };
}

describe("flagContactSpam", () => {
  it("refuses undialable input (short codes, letters) before touching anything", async () => {
    const { db, calls } = makeDb([]);
    const d = deps(db);
    for (const bad of ["12345", "not-a-phone x99"]) {
      const res = await flagContactSpam(BIZ, { phone: bad }, d);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("invalid_phone");
    }
    expect((d.setOptOut as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it("normalizes forgiving input to canonical E.164 before the opt-out write", async () => {
    const { db } = makeDb([
      { data: [contactRow()], error: null }, // contact read
      { data: [], error: null } // runs lookup
      // contact update: default empty result
    ]);
    const d = deps(db, {});
    const res = await flagContactSpam(BIZ, { phone: "(203) 809-7763" }, d);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.phoneE164).toBe(PHONE);
    expect(d.setOptOut).toHaveBeenCalledWith(BIZ, PHONE);
  });

  it("fails the whole call honestly when suppression cannot be written (Error and non-Error)", async () => {
    const { db, calls } = makeDb([]);
    for (const boom of [new Error("db down"), "string blow-up"]) {
      const d = deps(db, {
        setOptOut: vi.fn(async () => {
          throw boom;
        }) as never
      });
      const res = await flagContactSpam(BIZ, { phone: PHONE }, d);
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.message).toContain("spam_flag_failed");
    }
    expect(calls).toHaveLength(0);
  });

  it("suppresses the FULL identity set (canonical + aliases) and matches runs across it", async () => {
    const { db, calls } = makeDb([
      {
        data: [
          contactRow({
            customer_e164: CANONICAL,
            // Junk alias values are filtered out of the identity set.
            alias_e164s: ["+15145550123", "12345", 7]
          })
        ],
        error: null
      },
      { data: [], error: null } // runs lookup
      // contact update: default empty result
    ]);
    const d = deps(db);
    const res = await flagContactSpam(BIZ, { phone: PHONE }, d);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identitySet).toEqual([PHONE, CANONICAL, "+15145550123"]);
      expect(res.suppressionComplete).toBe(true);
      expect(res.note).toContain("their 2 linked number(s) too");
    }
    // One opt-out per identity number (the given one first).
    const optOutCalls = (d.setOptOut as ReturnType<typeof vi.fn>).mock.calls;
    expect(optOutCalls).toEqual([
      [BIZ, PHONE],
      [BIZ, CANONICAL],
      [BIZ, "+15145550123"]
    ]);
    // The run OR filter names every identity number.
    const orFilter = calls.find((c) => c.table === "ai_flow_runs" && c.name === "or");
    expect(orFilter?.args[0]).toContain(`context->vars->>lead_phone.eq.${CANONICAL}`);
    expect(orFilter?.args[0]).toContain(`context->waiting_call->>to.eq.+15145550123`);
  });

  it("an alias opt-out failure degrades to suppressionComplete false (Error and non-Error)", async () => {
    for (const boom of [new Error("alias down"), "string blow-up"]) {
      const { db } = makeDb([
        { data: [contactRow({ customer_e164: CANONICAL })], error: null },
        { data: [], error: null }
      ]);
      const d = deps(db, {
        setOptOut: vi.fn(async (_biz: string, n: string) => {
          if (n === CANONICAL) throw boom;
          return { isNew: true };
        }) as never
      });
      const res = await flagContactSpam(BIZ, { phone: PHONE }, d);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.suppressionComplete).toBe(false);
        expect(res.note).toContain("could not be confirmed as blocked");
      }
    }
  });

  it("a contact-lookup error continues on the given number alone", async () => {
    const { db } = makeDb([
      { data: null, error: { message: "lookup down" } }, // contact read fails
      { data: [], error: null }, // runs lookup
      { error: { message: "insert refused" } } // fallback insert also fails
    ]);
    const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.identitySet).toEqual([PHONE]);
      expect(res.contactOutcome).toBe("failed");
    }
  });

  it("cancels pending runs with the owner-stop shape, counting only landed writes", async () => {
    const { db, calls } = makeDb([
      { data: [contactRow()], error: null },
      {
        data: [runRow({ id: "r1" }), runRow({ id: "r2", context: null }), runRow({ id: "r3" })],
        error: null
      },
      { data: [{ id: "r1" }], error: null }, // r1 cancel lands
      { data: [], error: null }, // r2 lost its revision race
      { data: null, error: null }, // r3: null update data also reads as not landed
      { error: null } // contact update
    ]);
    const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.canceledRuns).toBe(1);
      expect(res.runsSweepComplete).toBe(true);
      expect(res.note).toContain("1 pending automation run(s)");
      expect(res.note).toContain("the contact is tagged spam");
    }
    const update = calls.find((c) => c.table === "ai_flow_runs" && c.name === "update");
    const payload = update?.args[0] as {
      status: string;
      context: { canceled: { by: string; from_status: string } };
      respond_by_at: null;
    };
    expect(payload.status).toBe("canceled");
    expect(payload.context.canceled.by).toBe(SPAM_CANCELED_BY);
    expect(payload.context.canceled.from_status).toBe("awaiting_reply");
    expect(payload.respond_by_at).toBeNull();
  });

  it("a run-lookup error degrades to runsSweepComplete false (suppression already active)", async () => {
    const { db } = makeDb([
      { data: [contactRow()], error: null },
      { data: null, error: { message: "lookup down" } },
      { error: null }
    ]);
    const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.runsSweepComplete).toBe(false);
      expect(res.canceledRuns).toBe(0);
      expect(res.note).toContain("could not be confirmed as stopped");
    }
  });

  it("a cancel write error marks the sweep incomplete but keeps canceling the rest", async () => {
    const { db } = makeDb([
      { data: [contactRow()], error: null },
      { data: [runRow({ id: "r1" }), runRow({ id: "r2" })], error: null },
      { data: null, error: { message: "write refused" } }, // r1 fails
      { data: [{ id: "r2" }], error: null }, // r2 lands
      { error: null }
    ]);
    const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.canceledRuns).toBe(1);
      expect(res.runsSweepComplete).toBe(false);
    }
  });

  it("null run data reads as zero pending runs", async () => {
    const { db } = makeDb([
      { data: [contactRow()], error: null },
      { data: null, error: null },
      { error: null }
    ]);
    const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.canceledRuns).toBe(0);
  });

  it("a client blow-up after suppression degrades to the honest partial result (never throws)", async () => {
    for (const boom of [new Error("no client"), "string blow-up"]) {
      const d = deps(null, {
        createDb: vi.fn(async () => {
          throw boom;
        }) as never
      });
      const res = await flagContactSpam(BIZ, { phone: PHONE }, d);
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.optedOut).toBe(true);
        expect(res.runsSweepComplete).toBe(false);
        expect(res.contactTagged).toBe(false);
        expect(res.contactOutcome).toBe("failed");
      }
    }
  });

  describe("contact tag + pinned note", () => {
    it("creates a minimal tagged contact when none exists", async () => {
      const { db, calls } = makeDb([
        { data: [], error: null }, // contact read: missing
        { data: [], error: null }, // runs
        { error: null } // insert
      ]);
      const res = await flagContactSpam(BIZ, { phone: PHONE, reason: "junk form fill" }, deps(db));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.contactOutcome).toBe("tagged");
        expect(res.contactTagged).toBe(true);
      }
      const insert = calls.find((c) => c.table === "contacts" && c.name === "insert");
      const row = insert?.args[0] as { tags: string[]; pinned_md: string; customer_e164: string };
      expect(row.customer_e164).toBe(PHONE);
      expect(row.tags).toEqual([SPAM_TAG]);
      expect(row.pinned_md).toContain("SPAM");
      expect(row.pinned_md).toContain("Reason: junk form fill");
    });

    it("appends the tag and note to an existing contact, preserving prior content", async () => {
      const { db, calls } = makeDb([
        { data: [contactRow({ tags: ["vip"], pinned_md: "- Prefers email" })], error: null },
        { data: [], error: null },
        { error: null }
      ]);
      const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.contactTagged).toBe(true);
      const update = calls.find((c) => c.table === "contacts" && c.name === "update");
      const payload = update?.args[0] as { tags: string[]; pinned_md: string };
      expect(payload.tags).toEqual(["vip", SPAM_TAG]);
      expect(payload.pinned_md).toContain("- Prefers email\n- ");
      // No reason given → no Reason suffix (whitespace-only counts as none).
      expect(payload.pinned_md).not.toContain("Reason:");
      // The lookup matches merged aliases too (Bugbot, PR #881): primary OR
      // alias_e164s containment.
      const orFilter = calls.find((c) => c.table === "contacts" && c.name === "or");
      expect(orFilter?.args[0]).toBe(`customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`);
    });

    it("a whitespace-only reason adds no Reason suffix (null contact data reads as missing)", async () => {
      const { db, calls } = makeDb([
        { data: null, error: null }, // null contact page → no contact row
        { data: [], error: null },
        { error: null }
      ]);
      await flagContactSpam(BIZ, { phone: PHONE, reason: "   " }, deps(db));
      const insert = calls.find((c) => c.table === "contacts" && c.name === "insert");
      expect((insert?.args[0] as { pinned_md: string }).pinned_md).not.toContain("Reason:");
    });

    it("re-flagging is idempotent: already tagged + noted skips the write entirely", async () => {
      const { db, calls } = makeDb([
        {
          data: [
            contactRow({
              tags: [SPAM_TAG],
              pinned_md: "- Owner declared this contact SPAM (2026-07-23)."
            })
          ],
          error: null
        },
        { data: [], error: null }
      ]);
      const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.contactTagged).toBe(true);
      expect(calls.some((c) => c.table === "contacts" && c.name === "update")).toBe(false);
    });

    it("a contact at the 25-tag cap gets the pinned note only (note_only, no doomed write)", async () => {
      const manyTags = Array.from({ length: 25 }, (_, i) => `t${i}`);
      const { db, calls } = makeDb([
        { data: [contactRow({ tags: manyTags })], error: null },
        { data: [], error: null },
        { error: null } // pinned-note update
      ]);
      const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.contactOutcome).toBe("note_only");
        expect(res.contactTagged).toBe(false);
        expect(res.note).toContain("tag limit");
      }
      const update = calls.find((c) => c.table === "contacts" && c.name === "update");
      const payload = update?.args[0] as { tags?: string[]; pinned_md: string };
      expect(payload.tags).toBeUndefined();
      expect(payload.pinned_md).toContain("SPAM");
    });

    it("at the cap with the note already present, nothing is written (still note_only)", async () => {
      const manyTags = Array.from({ length: 25 }, (_, i) => `t${i}`);
      const { db, calls } = makeDb([
        {
          data: [contactRow({ tags: manyTags, pinned_md: "- Owner declared this contact SPAM." })],
          error: null
        },
        { data: [], error: null }
      ]);
      const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
      expect(res.ok).toBe(true);
      if (res.ok) expect(res.contactOutcome).toBe("note_only");
      expect(calls.some((c) => c.table === "contacts" && c.name === "update")).toBe(false);
    });

    it("non-array tags and non-string pinned_md are treated as empty", async () => {
      const { db, calls } = makeDb([
        { data: [contactRow({ tags: null, pinned_md: 7 })], error: null },
        { data: [], error: null },
        { error: null }
      ]);
      await flagContactSpam(BIZ, { phone: PHONE }, deps(db));
      const update = calls.find((c) => c.table === "contacts" && c.name === "update");
      const payload = update?.args[0] as { tags: string[]; pinned_md: string };
      expect(payload.tags).toEqual([SPAM_TAG]);
      expect(payload.pinned_md.startsWith("- ")).toBe(true);
    });

    it("insert and update errors degrade to contactOutcome failed with an honest note", async () => {
      const insertFail = makeDb([
        { data: [], error: null },
        { data: [], error: null },
        { error: { message: "insert refused" } }
      ]);
      const r1 = await flagContactSpam(BIZ, { phone: PHONE }, deps(insertFail.db));
      expect(r1.ok && r1.contactOutcome === "failed").toBe(true);
      // The note must not claim a tag that never landed (Bugbot, PR #884).
      if (r1.ok) {
        expect(r1.note).toContain("tagging the contact record failed");
        expect(r1.note).not.toContain("the contact is tagged spam");
      }

      const updateFail = makeDb([
        { data: [contactRow()], error: null },
        { data: [], error: null },
        { error: { message: "update refused" } }
      ]);
      const r2 = await flagContactSpam(BIZ, { phone: PHONE }, deps(updateFail.db));
      expect(r2.ok && r2.contactOutcome === "failed").toBe(true);
    });

    it("a non-Error blow-up in the contact phase is stringified, not rethrown", async () => {
      // from() throws a raw string only for the contacts UPDATE phase (the
      // read succeeded), exercising the catch's String(err) arm while the
      // run sweep still completes.
      const { db } = makeDb([
        { data: [contactRow()], error: null },
        { data: [], error: null }
      ]);
      let contactsCalls = 0;
      const throwing = {
        from: (table: string) => {
          if (table === "contacts") {
            contactsCalls += 1;
            if (contactsCalls > 1) throw "contacts exploded";
          }
          return (db as { from: (t: string) => unknown }).from(table);
        }
      };
      const res = await flagContactSpam(BIZ, { phone: PHONE }, deps(throwing));
      expect(res.ok).toBe(true);
      if (res.ok) {
        expect(res.contactOutcome).toBe("failed");
        expect(res.runsSweepComplete).toBe(true);
      }
    });
  });
});

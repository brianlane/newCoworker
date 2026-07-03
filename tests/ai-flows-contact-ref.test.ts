import { describe, expect, it } from "vitest";
import {
  contactRefKey,
  matchVoiceFlowByCaller,
  resolveContactRef,
  resolveFromMatchesRefValues,
  resolveRefIdentityValues,
  resolveVoiceContactRefs,
  type ContactRefSupabase
} from "../supabase/functions/_shared/ai_flows/contact_ref";
import type {
  AiFlowDefinition,
  ContactRef,
  TriggerCondition
} from "../supabase/functions/_shared/ai_flows/types";

const EMP_ID = "11111111-1111-4111-8111-111111111111";
const CON_ID = "22222222-2222-4222-8222-222222222222";

type TableResult = { data: unknown; error: { message: string } | null };

/**
 * Structural supabase stub: returns the programmed result for each table and
 * records every (table, filters) query so tests can assert query shape and
 * memoization (call counts).
 */
function stubDb(results: Record<string, TableResult>) {
  const calls: { table: string; filters: Record<string, unknown> }[] = [];
  const db: ContactRefSupabase = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const chain = {
        eq(column: string, value: unknown) {
          filters[column] = value;
          return chain;
        },
        maybeSingle() {
          calls.push({ table, filters });
          const r = results[table] ?? { data: null, error: null };
          return Promise.resolve(r);
        }
      };
      return { select: () => chain };
    }
  };
  return { db, calls };
}

describe("resolveContactRef", () => {
  it("resolves an active employee to their live name + phone", async () => {
    const { db, calls } = stubDb({
      ai_flow_team_members: { data: { name: " Dave ", phone_e164: " +16025551234 " }, error: null }
    });
    const hit = await resolveContactRef(db, "biz", { source: "employee", id: EMP_ID });
    expect(hit).toEqual({ name: "Dave", phone: "+16025551234" });
    expect(calls).toEqual([
      {
        table: "ai_flow_team_members",
        filters: { business_id: "biz", id: EMP_ID, active: true }
      }
    ]);
  });

  it("falls back to a generic employee name when the row has none", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: { phone_e164: "+16025551234" }, error: null }
    });
    const hit = await resolveContactRef(db, "biz", { source: "employee", id: EMP_ID });
    expect(hit).toEqual({ name: "teammate", phone: "+16025551234" });
  });

  it("returns null for a missing / inactive / phoneless employee", async () => {
    const missing = stubDb({ ai_flow_team_members: { data: null, error: null } });
    expect(await resolveContactRef(missing.db, "biz", { source: "employee", id: EMP_ID })).toBeNull();
    const phoneless = stubDb({
      ai_flow_team_members: { data: { name: "Dave", phone_e164: "  " }, error: null }
    });
    expect(await resolveContactRef(phoneless.db, "biz", { source: "employee", id: EMP_ID })).toBeNull();
  });

  it("throws on an employee query error (caller retries / falls through)", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: null, error: { message: "boom" } }
    });
    await expect(
      resolveContactRef(db, "biz", { source: "employee", id: EMP_ID })
    ).rejects.toThrow("contact ref: roster query failed: boom");
  });

  it("resolves a contact to their live display name + number", async () => {
    const { db, calls } = stubDb({
      contacts: { data: { display_name: " Pat Lee ", customer_e164: "+16025550000" }, error: null }
    });
    const hit = await resolveContactRef(db, "biz", { source: "contact", id: CON_ID });
    expect(hit).toEqual({ name: "Pat Lee", phone: "+16025550000" });
    expect(calls).toEqual([{ table: "contacts", filters: { business_id: "biz", id: CON_ID } }]);
  });

  it("falls back to a generic contact name when the row has none", async () => {
    const { db } = stubDb({
      contacts: { data: { customer_e164: "+16025550000" }, error: null }
    });
    const hit = await resolveContactRef(db, "biz", { source: "contact", id: CON_ID });
    expect(hit).toEqual({ name: "contact", phone: "+16025550000" });
  });

  it("returns null for a missing / numberless contact", async () => {
    const missing = stubDb({ contacts: { data: null, error: null } });
    expect(await resolveContactRef(missing.db, "biz", { source: "contact", id: CON_ID })).toBeNull();
    const numberless = stubDb({ contacts: { data: { display_name: "Pat" }, error: null } });
    expect(await resolveContactRef(numberless.db, "biz", { source: "contact", id: CON_ID })).toBeNull();
  });

  it("throws on a contact query error", async () => {
    const { db } = stubDb({ contacts: { data: null, error: { message: "nope" } } });
    await expect(
      resolveContactRef(db, "biz", { source: "contact", id: CON_ID })
    ).rejects.toThrow("contact ref: contact query failed: nope");
  });
});

describe("resolveVoiceContactRefs", () => {
  const empRef: ContactRef = { source: "employee", id: EMP_ID, label: "Dave" };
  const conRef: ContactRef = { source: "contact", id: CON_ID };

  function voiceDef(steps: unknown[]): AiFlowDefinition {
    return {
      version: 1,
      trigger: { channel: "voice", fromE164: "+15550001111" },
      steps
    } as AiFlowDefinition;
  }

  it("passes a non-voice definition through untouched (same reference)", async () => {
    const { db, calls } = stubDb({});
    const def = {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s", type: "notify_owner", message: "hi" }]
    } as AiFlowDefinition;
    expect(await resolveVoiceContactRefs(db, "biz", def)).toBe(def);
    expect(calls).toEqual([]);
  });

  it("passes through a malformed definition (null / steps not an array)", async () => {
    const { db } = stubDb({});
    const noDef = null as unknown as AiFlowDefinition;
    expect(await resolveVoiceContactRefs(db, "biz", noDef)).toBe(noDef);
    const badSteps = { version: 1, trigger: { channel: "voice" }, steps: "x" } as unknown as AiFlowDefinition;
    expect(await resolveVoiceContactRefs(db, "biz", badSteps)).toBe(badSteps);
  });

  it("returns the SAME definition when no step carries a ref", async () => {
    const { db, calls } = stubDb({});
    const def = voiceDef([
      { id: "r", type: "ring_handoff", toE164: "+16025551234" },
      { id: "ai", type: "voice_ai_intake", notifyE164: "+16025551234" }
    ]);
    expect(await resolveVoiceContactRefs(db, "biz", def)).toBe(def);
    expect(calls).toEqual([]);
  });

  it("resolves ring_handoff / voice_transfer toRef into toE164 (input not mutated)", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: { name: "Dave", phone_e164: "+16025551234" }, error: null }
    });
    const def = voiceDef([
      { id: "r", type: "ring_handoff", toRef: empRef, ringSeconds: 25 },
      { id: "t", type: "voice_transfer", toRef: empRef, whisper: "hi" }
    ]);
    const out = await resolveVoiceContactRefs(db, "biz", def);
    expect(out).not.toBe(def);
    expect(out.steps[0]).toEqual({
      id: "r",
      type: "ring_handoff",
      toRef: empRef,
      ringSeconds: 25,
      toE164: "+16025551234"
    });
    expect(out.steps[1]).toEqual({
      id: "t",
      type: "voice_transfer",
      toRef: empRef,
      whisper: "hi",
      toE164: "+16025551234"
    });
    // Original untouched (raw JSONB reads are often shared/cached).
    expect((def.steps[0] as { toE164?: string }).toE164).toBeUndefined();
  });

  it("memoizes repeated refs to one query", async () => {
    const { db, calls } = stubDb({
      ai_flow_team_members: { data: { name: "Dave", phone_e164: "+16025551234" }, error: null }
    });
    const def = voiceDef([
      { id: "r1", type: "ring_handoff", toRef: empRef },
      { id: "r2", type: "ring_handoff", toRef: empRef }
    ]);
    await resolveVoiceContactRefs(db, "biz", def);
    expect(calls).toHaveLength(1);
  });

  it("resolves voice_ai_intake notifyRef into notifyE164", async () => {
    const { db } = stubDb({
      contacts: { data: { display_name: "Pat", customer_e164: "+16025550000" }, error: null }
    });
    const def = voiceDef([
      { id: "r", type: "ring_handoff", toE164: "+16025551234" },
      { id: "ai", type: "voice_ai_intake", notifyRef: conRef }
    ]);
    const out = await resolveVoiceContactRefs(db, "biz", def);
    expect((out.steps[1] as { notifyE164?: string }).notifyE164).toBe("+16025550000");
  });

  it("resolves outbound_call toRef AND notifyRef independently", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: { name: "Dave", phone_e164: "+16025551234" }, error: null },
      contacts: { data: { display_name: "Pat", customer_e164: "+16025550000" }, error: null }
    });
    const def = {
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: [{ id: "c", type: "outbound_call", toRef: conRef, notifyRef: empRef }]
    } as AiFlowDefinition;
    const out = await resolveVoiceContactRefs(db, "biz", def);
    expect(out.steps[0]).toMatchObject({ toE164: "+16025550000", notifyE164: "+16025551234" });
  });

  it("leaves outbound_call E164s unset when its refs do not resolve", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: null, error: null },
      contacts: { data: null, error: null }
    });
    const def = {
      version: 1,
      trigger: { channel: "voice", direction: "outbound" },
      steps: [{ id: "c", type: "outbound_call", toRef: conRef, notifyRef: empRef }]
    } as AiFlowDefinition;
    const out = await resolveVoiceContactRefs(db, "biz", def);
    expect(out).not.toBe(def);
    expect((out.steps[0] as { toE164?: string }).toE164).toBeUndefined();
    expect((out.steps[0] as { notifyE164?: string }).notifyE164).toBeUndefined();
  });

  it("leaves the E164 unset when a ref does not resolve (compilers degrade gracefully)", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: null, error: null },
      contacts: { data: null, error: null }
    });
    const def = voiceDef([
      { id: "r", type: "ring_handoff", toRef: empRef },
      { id: "ai", type: "voice_ai_intake", notifyRef: conRef }
    ]);
    const out = await resolveVoiceContactRefs(db, "biz", def);
    expect(out).not.toBe(def);
    expect((out.steps[0] as { toE164?: string }).toE164).toBeUndefined();
    expect((out.steps[1] as { notifyE164?: string }).notifyE164).toBeUndefined();
  });

  it("skips a ref when the hardcoded E164 is already set, and ignores malformed refs", async () => {
    const { db, calls } = stubDb({});
    const def = voiceDef([
      // toE164 wins — the ref must NOT be queried.
      { id: "r", type: "ring_handoff", toE164: "+16025551234", toRef: empRef },
      // Malformed refs (wrong source / missing id / non-object) are ignored.
      { id: "t", type: "voice_transfer", toRef: { source: "owner", id: "x" } },
      { id: "ai", type: "voice_ai_intake", notifyRef: "not-an-object" },
      { id: "c2", type: "outbound_call", toRef: { source: "employee" }, notifyRef: null }
    ]);
    const out = await resolveVoiceContactRefs(db, "biz", def);
    expect(out).toBe(def);
    expect(calls).toEqual([]);
  });

  it("propagates a query error (callers decide to fall through)", async () => {
    const { db } = stubDb({
      ai_flow_team_members: { data: null, error: { message: "down" } }
    });
    const def = voiceDef([{ id: "r", type: "ring_handoff", toRef: empRef }]);
    await expect(resolveVoiceContactRefs(db, "biz", def)).rejects.toThrow(
      "contact ref: roster query failed: down"
    );
  });
});

describe("resolveRefIdentityValues", () => {
  it("returns an employee's phone + email (trimmed, blanks dropped)", async () => {
    const { db, calls } = stubDb({
      ai_flow_team_members: { data: { phone_e164: " +16025551234 ", email: "dave@x.com" }, error: null }
    });
    expect(await resolveRefIdentityValues(db, "biz", { source: "employee", id: EMP_ID })).toEqual([
      "+16025551234",
      "dave@x.com"
    ]);
    expect(calls[0]).toEqual({
      table: "ai_flow_team_members",
      filters: { business_id: "biz", id: EMP_ID, active: true }
    });
    const noEmail = stubDb({
      ai_flow_team_members: { data: { phone_e164: "+16025551234", email: null }, error: null }
    });
    expect(await resolveRefIdentityValues(noEmail.db, "biz", { source: "employee", id: EMP_ID })).toEqual([
      "+16025551234"
    ]);
  });

  it("returns [] for a missing employee and throws on a query error", async () => {
    const missing = stubDb({ ai_flow_team_members: { data: null, error: null } });
    expect(await resolveRefIdentityValues(missing.db, "biz", { source: "employee", id: EMP_ID })).toEqual([]);
    const err = stubDb({ ai_flow_team_members: { data: null, error: { message: "boom" } } });
    await expect(
      resolveRefIdentityValues(err.db, "biz", { source: "employee", id: EMP_ID })
    ).rejects.toThrow("contact ref: roster query failed: boom");
  });

  it("returns a contact's canonical number, merge aliases, and email", async () => {
    const { db, calls } = stubDb({
      contacts: {
        data: {
          customer_e164: "+16025550000",
          alias_e164s: ["+16025550001", " ", 42],
          email: "pat@x.com"
        },
        error: null
      }
    });
    expect(await resolveRefIdentityValues(db, "biz", { source: "contact", id: CON_ID })).toEqual([
      "+16025550000",
      "+16025550001",
      "pat@x.com"
    ]);
    expect(calls[0]).toEqual({ table: "contacts", filters: { business_id: "biz", id: CON_ID } });
    const bareAliases = stubDb({
      contacts: { data: { customer_e164: "+16025550000", alias_e164s: null, email: null }, error: null }
    });
    expect(
      await resolveRefIdentityValues(bareAliases.db, "biz", { source: "contact", id: CON_ID })
    ).toEqual(["+16025550000"]);
  });

  it("returns [] for a missing contact and throws on a query error", async () => {
    const missing = stubDb({ contacts: { data: null, error: null } });
    expect(await resolveRefIdentityValues(missing.db, "biz", { source: "contact", id: CON_ID })).toEqual([]);
    const err = stubDb({ contacts: { data: null, error: { message: "nope" } } });
    await expect(
      resolveRefIdentityValues(err.db, "biz", { source: "contact", id: CON_ID })
    ).rejects.toThrow("contact ref: contact query failed: nope");
  });
});

describe("resolveFromMatchesRefValues", () => {
  const empRef: ContactRef = { source: "employee", id: EMP_ID };

  it("resolves each distinct from_matches ref once, keyed by contactRefKey", async () => {
    const { db, calls } = stubDb({
      ai_flow_team_members: { data: { phone_e164: "+16025551234", email: null }, error: null }
    });
    const conditions: TriggerCondition[] = [
      { type: "contains", value: "lead" },
      { type: "from_matches", ref: empRef },
      { type: "from_matches", ref: empRef },
      { type: "from_matches", value: "+1602" }
    ];
    const map = await resolveFromMatchesRefValues(db, "biz", conditions);
    expect(map.get(contactRefKey(empRef))).toEqual(["+16025551234"]);
    expect(map.size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("returns an empty map for undefined conditions / no refs / malformed refs", async () => {
    const { db, calls } = stubDb({});
    expect((await resolveFromMatchesRefValues(db, "biz", undefined)).size).toBe(0);
    const noRefs: TriggerCondition[] = [
      { type: "has_url" },
      { type: "from_matches", value: "x" },
      { type: "from_matches", ref: { source: "owner", id: "x" } as unknown as ContactRef }
    ];
    expect((await resolveFromMatchesRefValues(db, "biz", noRefs)).size).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("matchVoiceFlowByCaller", () => {
  const CALLER = "+14155551000";
  const empRef: ContactRef = { source: "employee", id: EMP_ID };

  const flow = (trigger: Record<string, unknown>, id: string) => ({
    id,
    definition: { version: 1, trigger, steps: [] }
  });

  it("prefers a literal fromE164 match (no queries) over ref flows", async () => {
    const { db, calls } = stubDb({});
    const flows = [
      flow({ channel: "voice", fromRef: empRef }, "ref-flow"),
      flow({ channel: "voice", fromE164: CALLER }, "literal-flow")
    ];
    const hit = await matchVoiceFlowByCaller(db, "biz", flows, CALLER);
    expect(hit?.id).toBe("literal-flow");
    expect(calls).toEqual([]);
  });

  it("matches a fromRef flow when the caller is one of the person's live numbers", async () => {
    const { db, calls } = stubDb({
      ai_flow_team_members: { data: { phone_e164: CALLER, email: "d@x.com" }, error: null }
    });
    const flows = [
      flow({ channel: "voice", fromE164: "+19998887777" }, "other-literal"),
      flow({ channel: "voice", fromRef: empRef }, "ref-flow")
    ];
    const hit = await matchVoiceFlowByCaller(db, "biz", flows, CALLER);
    expect(hit?.id).toBe("ref-flow");
    expect(calls).toHaveLength(1);
  });

  it("memoizes a repeated fromRef across flows (one query even when nothing matches)", async () => {
    const { db, calls } = stubDb({
      ai_flow_team_members: { data: { phone_e164: "+17770001111", email: null }, error: null }
    });
    const flows = [
      flow({ channel: "voice", fromRef: empRef }, "ref-1"),
      flow({ channel: "voice", fromRef: empRef }, "ref-2")
    ];
    expect(await matchVoiceFlowByCaller(db, "biz", flows, CALLER)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("skips outbound / non-voice / malformed definitions and unresolved refs", async () => {
    const { db } = stubDb({ ai_flow_team_members: { data: null, error: null } });
    const flows = [
      flow({ channel: "voice", direction: "outbound", fromRef: empRef }, "outbound"),
      flow({ channel: "sms", conditions: [] }, "sms"),
      { id: "no-def", definition: undefined },
      flow({ channel: "voice", fromRef: { source: "employee" } }, "malformed-ref"),
      flow({ channel: "voice", fromRef: empRef }, "unresolved-ref"),
      flow({ channel: "voice" }, "no-caller")
    ];
    expect(await matchVoiceFlowByCaller(db, "biz", flows, CALLER)).toBeNull();
  });

  it("a resolution error skips that flow only (logged, not thrown)", async () => {
    const conRef: ContactRef = { source: "contact", id: CON_ID };
    const { db } = stubDb({
      ai_flow_team_members: { data: null, error: { message: "down" } },
      contacts: { data: { customer_e164: CALLER, alias_e164s: [], email: null }, error: null }
    });
    const flows = [
      flow({ channel: "voice", fromRef: { source: "employee", id: EMP_ID } }, "erroring"),
      flow({ channel: "voice", fromRef: conRef }, "contact-flow")
    ];
    const hit = await matchVoiceFlowByCaller(db, "biz", flows, CALLER);
    expect(hit?.id).toBe("contact-flow");
  });
});

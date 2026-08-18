import { describe, expect, it, vi } from "vitest";
import {
  PENDING_EDIT_TTL_MINUTES,
  consumePendingEdit,
  peekPendingEdit,
  stagePendingEdit
} from "@/lib/ai-flows/pending-edits";
import type { AiFlowDefinition } from "@/lib/ai-flows/schema";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

const BIZ = "11111111-1111-4111-8111-111111111111";
const FLOW_ID = "22222222-2222-4222-8222-222222222222";
const NOW = Date.parse("2026-08-18T00:00:00Z");

const DEFINITION = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [{ id: "s1", type: "notify_owner", message: "hi" }]
} as unknown as AiFlowDefinition;

function row(over: Record<string, unknown> = {}) {
  return {
    id: "pending-1",
    business_id: BIZ,
    flow_id: FLOW_ID,
    token: "tok-1",
    definition: DEFINITION,
    new_name: null,
    summary: ["a line"],
    ambiguities: [],
    risk: "wording",
    base_updated_at: "2026-07-01T00:00:00Z",
    surface: null,
    actor: null,
    created_at: "2026-08-18T00:00:00Z",
    expires_at: "2026-08-18T00:15:00Z",
    consumed_at: null,
    ...over
  };
}

/**
 * PostgREST-ish builder. `results` is consumed one query at a time, so a
 * test can script the update-then-diagnose pair consumePendingEdit runs.
 */
function makeDb(results: Array<{ data?: unknown; error?: { message: string } | null }>) {
  const calls: Array<Record<string, unknown>> = [];
  let i = 0;
  const make = () => {
    const captured: Record<string, unknown> = {};
    const node: Record<string, unknown> = {};
    const chain = (name: string) =>
      vi.fn((...args: unknown[]) => {
        captured[name] = args;
        return node;
      });
    for (const m of ["select", "eq", "is", "gt", "insert", "update", "order", "limit"]) {
      node[m] = chain(m);
    }
    const settle = () => {
      const r = results[i] ?? {};
      i += 1;
      return { data: r.data ?? null, error: r.error ?? null };
    };
    node.single = vi.fn(async () => settle());
    node.maybeSingle = vi.fn(async () => settle());
    node.then = (resolve: (v: unknown) => unknown) => resolve(settle());
    calls.push(captured);
    return node;
  };
  return { db: { from: vi.fn(() => make()) }, calls };
}

describe("stagePendingEdit", () => {
  it("writes the compiled bytes with a generated token and a bounded expiry", async () => {
    const { db, calls } = makeDb([{ data: row() }]);
    const staged = await stagePendingEdit(
      {
        businessId: BIZ,
        flowId: FLOW_ID,
        definition: DEFINITION,
        summary: ["a line"],
        ambiguities: [],
        risk: "wording",
        baseUpdatedAt: "2026-07-01T00:00:00Z",
        surface: "ai_edit_sms",
        actor: "+15555550100"
      },
       
      { client: db as any, now: () => NOW }
    );
    expect(staged.token).toBe("tok-1");
    const inserted = (calls[0].insert as unknown[])[0] as Record<string, unknown>;
    expect(inserted.definition).toBe(DEFINITION);
    expect(inserted.surface).toBe("ai_edit_sms");
    expect(typeof inserted.token).toBe("string");
    expect(inserted.expires_at).toBe(
      new Date(NOW + PENDING_EDIT_TTL_MINUTES * 60_000).toISOString()
    );
  });

  it("defaults the optional columns to null rather than omitting them", async () => {
    const { db, calls } = makeDb([{ data: row() }]);
    await stagePendingEdit(
      {
        businessId: BIZ,
        flowId: FLOW_ID,
        definition: DEFINITION,
        summary: [],
        ambiguities: [],
        risk: "structural",
        baseUpdatedAt: "2026-07-01T00:00:00Z"
      },
       
      { client: db as any, now: () => NOW }
    );
    const inserted = (calls[0].insert as unknown[])[0] as Record<string, unknown>;
    expect(inserted.new_name).toBeNull();
    expect(inserted.surface).toBeNull();
    expect(inserted.actor).toBeNull();
  });

  it("throws on a write error", async () => {
    const { db } = makeDb([{ error: { message: "boom" } }]);
    await expect(
      stagePendingEdit(
        {
          businessId: BIZ,
          flowId: FLOW_ID,
          definition: DEFINITION,
          summary: [],
          ambiguities: [],
          risk: "wording",
          baseUpdatedAt: "2026-07-01T00:00:00Z"
        },
         
        { client: db as any, now: () => NOW }
      )
    ).rejects.toThrow("stagePendingEdit: boom");
  });
});

describe("consumePendingEdit", () => {
  it("claims by compare-and-swap, not read-then-write", async () => {
    // Two confirmations arriving together must not both apply the same
    // staged definition, so unconsumed + unexpired are WHERE clauses.
    const { db, calls } = makeDb([{ data: [row()] }]);
     
    const res = await consumePendingEdit(BIZ, "tok-1", { client: db as any, now: () => NOW });
    expect(res).toMatchObject({ ok: true });
    expect(calls[0].is).toEqual(["consumed_at", null]);
    expect(calls[0].gt).toEqual(["expires_at", new Date(NOW).toISOString()]);
    expect(calls[0].update).toEqual([{ consumed_at: new Date(NOW).toISOString() }]);
  });

  it("says 'already applied' rather than failing generically on a replayed token", async () => {
    const { db } = makeDb([{ data: [] }, { data: row({ consumed_at: "2026-08-18T00:05:00Z" }) }]);
     
    const res = await consumePendingEdit(BIZ, "tok-1", { client: db as any, now: () => NOW });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("NOT been applied a second time");
  });

  it("distinguishes an expired token from an unknown one", async () => {
    const expired = makeDb([{ data: [] }, { data: row() }]);
    const res = await consumePendingEdit(BIZ, "tok-1", {
       
      client: expired.db as any,
      now: () => NOW
    });
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.message).toContain("expired");

    const unknown = makeDb([{ data: [] }, { data: null }]);
    const res2 = await consumePendingEdit(BIZ, "tok-1", {
       
      client: unknown.db as any,
      now: () => NOW
    });
    expect(res2).toMatchObject({ ok: false });
    if (!res2.ok) expect(res2.message).toContain("not staged any more");
  });

  it("never reports an unapplied change as applied", async () => {
    const { db } = makeDb([{ data: [] }, { data: null }]);
     
    const res = await consumePendingEdit(BIZ, "tok-1", { client: db as any, now: () => NOW });
    if (!res.ok) expect(res.message).toContain("do not tell the owner it was applied");
  });

  it("throws on a claim error", async () => {
    const { db } = makeDb([{ error: { message: "boom" } }]);
    await expect(
       
      consumePendingEdit(BIZ, "tok-1", { client: db as any, now: () => NOW })
    ).rejects.toThrow("consumePendingEdit: boom");
  });

  it("treats a null claim result as a miss rather than a success", async () => {
    const { db } = makeDb([{ data: null }, { data: null }]);
     
    const res = await consumePendingEdit(BIZ, "tok-1", { client: db as any, now: () => NOW });
    expect(res).toMatchObject({ ok: false });
  });
});

describe("peekPendingEdit", () => {
  it("reads without claiming, so a refusal does not burn a single-use token", async () => {
    const { db, calls } = makeDb([{ data: row() }]);
     
    const found = await peekPendingEdit(BIZ, "tok-1", { client: db as any });
    expect(found?.token).toBe("tok-1");
    expect(calls[0].update).toBeUndefined();
  });

  it("returns null for an unknown token", async () => {
    const { db } = makeDb([{ data: null }]);
     
    expect(await peekPendingEdit(BIZ, "tok-1", { client: db as any })).toBeNull();
  });

  it("throws on a read error", async () => {
    const { db } = makeDb([{ error: { message: "boom" } }]);
    await expect(
       
      peekPendingEdit(BIZ, "tok-1", { client: db as any })
    ).rejects.toThrow("peekPendingEdit: boom");
  });
});

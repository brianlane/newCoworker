import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  RENEWAL_PIPELINE_SCAN_LIMIT,
  getRenewalPipeline,
  renewalBucketFor
} from "@/lib/analytics/renewal-pipeline";

const BIZ = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-07-16T12:00:00Z");

function inDays(days: number): string {
  return new Date(NOW.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

type TableResult = { data: unknown; error: { message: string } | null };

/** Table-keyed scripted mock: each table pops its own result queue. */
function makeDb(queues: Record<string, TableResult[]>) {
  const from = vi.fn((table: string) => {
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "not", "gte", "lte", "order", "limit", "in"]) {
      chain[m] = vi.fn(() => chain);
    }
    (chain as { then: unknown }).then = (resolve: (v: unknown) => unknown) => {
      const queue = queues[table] ?? [];
      const result = queue.shift() ?? { data: [], error: null };
      return Promise.resolve(result).then(resolve);
    };
    return chain;
  });
  return { from } as never;
}

function docRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "d-1",
    title: "Auto policy",
    category: "policy",
    renewal_date: inDays(10),
    contact_id: null,
    assigned_employee_id: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("renewalBucketFor", () => {
  it("maps day distances onto the four buckets", () => {
    expect(renewalBucketFor(-1)).toBe("overdue");
    expect(renewalBucketFor(0)).toBe("next30");
    expect(renewalBucketFor(30)).toBe("next30");
    expect(renewalBucketFor(31)).toBe("next60");
    expect(renewalBucketFor(60)).toBe("next60");
    expect(renewalBucketFor(61)).toBe("next90");
    expect(renewalBucketFor(90)).toBe("next90");
  });
});

describe("getRenewalPipeline", () => {
  it("buckets rows, resolves names, and tallies handlers", async () => {
    const db = makeDb({
      business_documents: [
        {
          data: [
            docRow({ id: "d-overdue", renewal_date: inDays(-3), contact_id: "c-1", assigned_employee_id: "m-1" }),
            docRow({ id: "d-soon", renewal_date: inDays(10), contact_id: "c-2" }),
            docRow({ id: "d-later", renewal_date: inDays(75) })
          ],
          error: null
        }
      ],
      contacts: [
        {
          data: [
            { id: "c-1", display_name: "Jane Doe", customer_e164: "+16025551234" },
            { id: "c-2", display_name: "  ", customer_e164: "+16025555678" }
          ],
          error: null
        }
      ],
      ai_flow_team_members: [{ data: [{ id: "m-1", name: "Dania" }], error: null }]
    });
    const pipeline = await getRenewalPipeline(BIZ, { client: db, now: NOW });
    expect(pipeline.counts).toEqual({ overdue: 1, next30: 1, next60: 0, next90: 1 });
    expect(pipeline.clipped).toBe(false);
    expect(pipeline.rows[0]).toMatchObject({
      documentId: "d-overdue",
      bucket: "overdue",
      daysUntil: -3,
      contactName: "Jane Doe",
      contactE164: "+16025551234",
      assignedEmployee: "Dania"
    });
    // Blank display name → null name, number still linked.
    expect(pipeline.rows[1]).toMatchObject({
      contactName: null,
      contactE164: "+16025555678",
      assignedEmployee: null
    });
    expect(pipeline.byAssignee).toEqual([
      { name: "Unassigned", count: 2 },
      { name: "Dania", count: 1 }
    ]);
  });

  it("handles unresolvable directory ids and null data (default client)", async () => {
    const db = makeDb({
      business_documents: [
        { data: [docRow({ contact_id: "c-gone", assigned_employee_id: "m-gone" })], error: null }
      ],
      contacts: [{ data: null, error: null }],
      ai_flow_team_members: [{ data: null, error: null }]
    });
    defaultClientSpy.mockReturnValue(db);
    const pipeline = await getRenewalPipeline(BIZ, { now: NOW });
    expect(pipeline.rows[0]).toMatchObject({
      contactName: null,
      contactE164: null,
      assignedEmployee: null
    });
    expect(pipeline.byAssignee).toEqual([{ name: "Unassigned", count: 1 }]);
  });

  it("returns an empty pipeline when nothing renews soon (default clock)", async () => {
    const db = makeDb({ business_documents: [{ data: null, error: null }] });
    const pipeline = await getRenewalPipeline(BIZ, { client: db });
    expect(pipeline.rows).toEqual([]);
    expect(pipeline.counts).toEqual({ overdue: 0, next30: 0, next60: 0, next90: 0 });
    expect(pipeline.byAssignee).toEqual([]);
  });

  it("flags a capped scan", async () => {
    const many = Array.from({ length: RENEWAL_PIPELINE_SCAN_LIMIT }, (_, i) =>
      docRow({ id: `d-${i}` })
    );
    const db = makeDb({ business_documents: [{ data: many, error: null }] });
    const pipeline = await getRenewalPipeline(BIZ, { client: db, now: NOW });
    expect(pipeline.clipped).toBe(true);
  });

  it("throws on scan and directory errors", async () => {
    await expect(
      getRenewalPipeline(BIZ, {
        client: makeDb({ business_documents: [{ data: null, error: { message: "scan boom" } }] }),
        now: NOW
      })
    ).rejects.toThrow(/scan boom/);

    await expect(
      getRenewalPipeline(BIZ, {
        client: makeDb({
          business_documents: [{ data: [docRow({ contact_id: "c-1" })], error: null }],
          contacts: [{ data: null, error: { message: "contacts boom" } }]
        }),
        now: NOW
      })
    ).rejects.toThrow(/contacts boom/);

    await expect(
      getRenewalPipeline(BIZ, {
        client: makeDb({
          business_documents: [{ data: [docRow({ assigned_employee_id: "m-1" })], error: null }],
          ai_flow_team_members: [{ data: null, error: { message: "roster boom" } }]
        }),
        now: NOW
      })
    ).rejects.toThrow(/roster boom/);
  });
});

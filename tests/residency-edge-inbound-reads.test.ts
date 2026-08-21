import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../supabase/functions/_shared/residency.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../supabase/functions/_shared/residency")>();
  return { ...actual, edgeIsVpsReadMode: vi.fn(), edgeReadMovedRowsOrNull: vi.fn() };
});

import {
  edgeIsVpsReadMode,
  edgeReadMovedRowsOrNull
} from "../supabase/functions/_shared/residency";
import { loadContactTimeline } from "../supabase/functions/_shared/contact_context";
import { loadFlowRunContextDetailed } from "../supabase/functions/_shared/ai_flows/run_context";

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+15199560528";

/**
 * The inbound text path on a residency tenant.
 *
 * `sms_outbound_log` and `voice_call_transcripts` are PURGED from central at
 * cutover, so reading them centrally for a vps tenant is not stale, it is
 * empty: the model is told this customer has never written or called. These
 * pin that the box is asked instead, and that an unreachable box costs one
 * channel rather than the whole conversation.
 */

/** Central client that answers ONLY the tables that stay central. */
function centralOnlyDb(inbound: unknown[]) {
  const seen: string[] = [];
  const build = (table: string): Record<string, unknown> => {
    seen.push(table);
    const b: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "in", "or", "gte", "order", "limit"]) {
      b[m] = () => b;
    }
    b["maybeSingle"] = () => Promise.resolve({ data: null, error: null });
    b["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve({
        data: table === "sms_inbound_jobs" ? inbound : [],
        error:
          table === "sms_outbound_log" || table === "voice_call_transcripts"
            ? { message: "central must not be read for a vps tenant" }
            : null
      }).then(resolve);
    return b;
  };
  return { db: { from: (t: string) => build(t) } as never, seen };
}

describe("inbound path on a residency tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(edgeIsVpsReadMode).mockResolvedValue(true);
  });

  it("reads the purged timeline tables from the tenant's box, not central", async () => {
    vi.mocked(edgeReadMovedRowsOrNull).mockImplementation(async (_db, _biz, req) => {
      if (req.table === "contacts") return [{ customer_e164: LEAD, alias_e164s: [] }] as never;
      if (req.table === "sms_outbound_log")
        return [{ created_at: "2026-07-14T17:09:03Z", body: "When does your policy renew?" }] as never;
      if (req.table === "voice_call_transcripts")
        return [
          {
            started_at: "2026-07-14T16:00:00Z",
            created_at: "2026-07-14T16:00:00Z",
            direction: "inbound",
            summary: "Asked about renewal timing.",
            status: "completed"
          }
        ] as never;
      return [] as never;
    });
    const { db, seen } = centralOnlyDb([]);

    const text = await loadContactTimeline(db, BIZ, LEAD);

    expect(text, "the box rows never reached the timeline").toContain(
      "When does your policy renew?"
    );
    expect(text).toContain("Asked about renewal timing.");
    // The purged tables were asked of the BOX...
    const asked = vi
      .mocked(edgeReadMovedRowsOrNull)
      .mock.calls.map((c) => (c[2] as { table: string }).table);
    expect(asked).toContain("sms_outbound_log");
    expect(asked).toContain("voice_call_transcripts");
    // ...and never of central. sms_inbound_jobs is an engine table and
    // correctly stays central, so it must still appear.
    expect(seen).not.toContain("sms_outbound_log");
    expect(seen).not.toContain("voice_call_transcripts");
    expect(seen).toContain("sms_inbound_jobs");
  });

  it("sends the same filters the central query used", async () => {
    vi.mocked(edgeReadMovedRowsOrNull).mockResolvedValue([]);
    const { db } = centralOnlyDb([]);
    await loadContactTimeline(db, BIZ, LEAD);
    const outbound = vi
      .mocked(edgeReadMovedRowsOrNull)
      .mock.calls.map((c) => c[2] as { table: string; filters?: unknown[]; limit?: number })
      .find((r) => r.table === "sms_outbound_log");
    expect(outbound?.filters).toEqual([
      { column: "business_id", op: "eq", value: BIZ },
      { column: "to_e164", op: "in", value: [LEAD] },
      { column: "deleted_at", op: "is", value: null },
      { column: "created_at", op: "gte", value: expect.any(String) }
    ]);
  });

  it("resolves merged aliases from the box so the timeline spans the profile", async () => {
    // The alias arm is the reason this read exists at all: a contact whose
    // old number was merged keeps its rows keyed on the OLD number.
    vi.mocked(edgeReadMovedRowsOrNull).mockImplementation(async (_db, _biz, req) =>
      (req.table === "contacts"
        ? [{ customer_e164: "+15550009999", alias_e164s: [LEAD] }]
        : []) as never
    );
    const { db } = centralOnlyDb([]);
    await loadContactTimeline(db, BIZ, LEAD);
    const contactReq = vi
      .mocked(edgeReadMovedRowsOrNull)
      .mock.calls.map((c) => c[2] as { table: string; filters?: unknown[] })
      .find((r) => r.table === "contacts");
    expect(contactReq?.filters).toEqual([
      { column: "business_id", op: "eq", value: BIZ },
      {
        or: [
          [{ column: "customer_e164", op: "eq", value: LEAD }],
          [{ column: "alias_e164s", op: "contains", value: [LEAD] }]
        ]
      }
    ]);
    // The merged profile's numbers reach the content reads.
    const outbound = vi
      .mocked(edgeReadMovedRowsOrNull)
      .mock.calls.map((c) => c[2] as { table: string; filters?: Array<{ column: string; value: unknown }> })
      .find((r) => r.table === "sms_outbound_log");
    expect(outbound?.filters?.find((f) => f.column === "to_e164")?.value).toEqual([
      LEAD,
      "+15550009999"
    ]);
  });

  it("an unreachable box costs ONE channel, never the conversation", async () => {
    // Matches the module's documented per-source degrade. Throwing here would
    // fail a live customer reply to avoid a missing history line.
    vi.mocked(edgeReadMovedRowsOrNull).mockImplementation(async (_db, _biz, req) => {
      if (req.table === "voice_call_transcripts") return null; // box unreachable
      if (req.table === "contacts") return [{ customer_e164: LEAD, alias_e164s: [] }] as never;
      return [{ created_at: "2026-07-14T17:09:03Z", body: "Still here." }] as never;
    });
    const { db } = centralOnlyDb([]);
    const text = await loadContactTimeline(db, BIZ, LEAD);
    expect(text).toContain("Still here.");
    expect(text).not.toContain("call took place");
  });

  it("falls back to the queried number alone when the contact read fails", async () => {
    vi.mocked(edgeReadMovedRowsOrNull).mockImplementation(async (_db, _biz, req) =>
      (req.table === "contacts" ? null : []) as never
    );
    const { db } = centralOnlyDb([]);
    await loadContactTimeline(db, BIZ, LEAD);
    const outbound = vi
      .mocked(edgeReadMovedRowsOrNull)
      .mock.calls.map((c) => c[2] as { table: string; filters?: Array<{ column: string; value: unknown }> })
      .find((r) => r.table === "sms_outbound_log");
    expect(outbound?.filters?.find((f) => f.column === "to_e164")?.value).toEqual([LEAD]);
  });
});

describe("flow context on a residency tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(edgeIsVpsReadMode).mockResolvedValue(true);
  });

  /** Answers ai_flow_runs / ai_flows centrally; refuses the purged table. */
  function flowDb(runs: unknown[]) {
    const seen: string[] = [];
    const build = (table: string): Record<string, unknown> => {
      seen.push(table);
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "is", "or", "gte", "order", "limit", "neq"]) b[m] = () => b;
      b["then"] = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({
          data: table === "ai_flow_runs" ? runs : [],
          error:
            table === "sms_outbound_log"
              ? { message: "central must not be read for a vps tenant" }
              : null
        }).then(resolve);
      return b;
    };
    return { db: { from: (t: string) => build(t) } as never, seen };
  }

  it("reads the automation's recent sends from the box, not central", async () => {
    // An empty result here is the Truly Insurance 2026-07-14 regression: the
    // model loses sight of what the automation already texted and restarts
    // intake mid-conversation. On a vps tenant central IS empty.
    vi.mocked(edgeReadMovedRowsOrNull).mockResolvedValue([
      { body: "when does your current policy renew?" }
    ] as never);
    const { db, seen } = flowDb([]);

    const detail = await loadFlowRunContextDetailed(db, BIZ, LEAD);

    expect(detail.recentMessages).toEqual(["when does your current policy renew?"]);
    expect(seen).not.toContain("sms_outbound_log");
    const req = vi.mocked(edgeReadMovedRowsOrNull).mock.calls[0][2] as {
      table: string;
      filters?: unknown[];
      limit?: number;
    };
    expect(req.table).toBe("sms_outbound_log");
    expect(req.filters).toEqual([
      { column: "business_id", op: "eq", value: BIZ },
      { column: "to_e164", op: "eq", value: LEAD },
      { column: "source", op: "eq", value: "ai_flow" },
      { column: "created_at", op: "gte", value: expect.any(String) }
    ]);
  });

  it("an unreachable box leaves recentMessages empty rather than throwing", async () => {
    vi.mocked(edgeReadMovedRowsOrNull).mockResolvedValue(null);
    const { db } = flowDb([]);
    const detail = await loadFlowRunContextDetailed(db, BIZ, LEAD);
    expect(detail.recentMessages).toEqual([]);
    // The weak version of this assertion passes even when the function threw
    // early and returned EMPTY_DETAILED, which is a different bug wearing the
    // same result. Prove the box was actually asked and the null was handled.
    expect(edgeReadMovedRowsOrNull).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(edgeReadMovedRowsOrNull).mock.calls[0][2] as { table: string }).table
    ).toBe("sms_outbound_log");
  });
});

/**
 * The dashboard API routes that read residency-MOVED tables.
 *
 * `contacts`, `ai_flows` and `scheduled_sms` all move to an opted-in
 * enterprise tenant's own box, so for a tenant in `data_residency_mode =
 * 'vps'` a central `db.from(...)` read comes back EMPTY. These routes used
 * to do exactly that, which meant the Tasks board and the leads Data grid
 * rendered nothing at all, with no error to explain it. Each case here
 * drives the real route handler in vps mode and asserts the rows come from
 * the box AND that central was never asked for the moved table.
 *
 * The alias trade is pinned deliberately: on the box a lead keyed on a
 * merged-away number resolves to NO contact, so it stays its own unresolved
 * card rather than being folded onto another person's profile. The
 * central-mode counterpart of the same case shows what is given up.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  getAuthUser: vi.fn(),
  requireBusinessRole: vi.fn()
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimit: vi.fn(() => ({ success: true, limit: 30, remaining: 29, reset: 0 }))
}));

// The routing layer itself is unit-tested in tests/residency-read.test.ts;
// mocked here so each route's mode branch can be driven directly.
vi.mock("@/lib/residency/read", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/residency/read")>();
  return { ...actual, isVpsReadMode: vi.fn(), readMovedRows: vi.fn() };
});

// Central-table helpers the boards call around the moved-table reads.
vi.mock("@/lib/db/caller-employee", () => ({ resolveCallerEmployeeId: vi.fn(async () => null) }));
vi.mock("@/lib/db/implicit-contact-owner", () => ({
  resolveImplicitContactOwner: vi.fn(async () => null)
}));
vi.mock("@/lib/db/contact-names", () => ({ resolveContactNames: vi.fn(async () => new Map()) }));
vi.mock("@/lib/db/activity", () => ({ getActivityForContacts: vi.fn(async () => new Map()) }));

vi.mock("@/lib/documents/db", () => ({
  countBusinessDocuments: vi.fn(async () => 0),
  deleteBusinessDocument: vi.fn(),
  getBusinessDocument: vi.fn(),
  listDocumentSignatureRequests: vi.fn(async () => []),
  patchBusinessDocument: vi.fn(async () => ({ id: "doc-1" })),
  voidAllSignatureRequestsForDocument: vi.fn()
}));
vi.mock("@/lib/vps/sync-vault", () => ({ syncVaultToVpsAndLog: vi.fn(async () => undefined) }));

import { GET as tasksGET } from "@/app/api/dashboard/tasks/route";
import { GET as leadsDataGET } from "@/app/api/dashboard/leads-data/route";
import { GET as scheduleGET } from "@/app/api/dashboard/messages/schedule/route";
import { PATCH as documentPATCH } from "@/app/api/dashboard/documents/[documentId]/route";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { ResidencyReadError, isVpsReadMode, readMovedRows } from "@/lib/residency/read";
import { getBusinessDocument } from "@/lib/documents/db";

const BIZ = "11111111-1111-4111-8111-111111111111";
const DOC = "22222222-2222-4222-8222-222222222222";
const CONTACT = "44444444-4444-4444-8444-444444444444";
const OWNER = { userId: "u1", email: "o@o.com", isAdmin: false };

/** The lead's surviving primary number, and a number merged into it. */
const PRIMARY = "+16025550111";
const ALIAS = "+16025550222";

/**
 * A central client that records every table it is asked for and resolves
 * each chain to that table's canned rows. Any read that WRONGLY stayed
 * central therefore shows up in `asked`.
 */
function centralDb(tables: Record<string, unknown[]> = {}) {
  const asked: string[] = [];
  const from = vi.fn((table: string) => {
    asked.push(table);
    const chain: Record<string, unknown> = {};
    for (const m of ["select", "eq", "neq", "is", "in", "or", "order", "limit"]) {
      chain[m] = vi.fn(() => chain);
    }
    chain.maybeSingle = vi.fn(async () => ({ data: null, error: null }));
    (chain as { then: unknown }).then = (
      onF: (v: unknown) => unknown,
      onR: (e: unknown) => unknown
    ) => Promise.resolve({ data: tables[table] ?? [], error: null }).then(onF, onR);
    return chain;
  });
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return { asked };
}

/** readMovedRows stub dispatching per moved table. */
function boxRows(rowsByTable: Record<string, unknown[]>) {
  vi.mocked(readMovedRows).mockImplementation(
    async (_biz, request) => (rowsByTable[(request as { table: string }).table] ?? []) as never
  );
}

/** Every box request made for one moved table. */
function boxRequests(table: string) {
  return vi
    .mocked(readMovedRows)
    .mock.calls.filter((c) => (c[1] as { table: string }).table === table)
    .map((c) => c[1]);
}

/** A contact row carrying both column sets the two boards project. */
function contactRow(overrides: Record<string, unknown> = {}) {
  return {
    customer_e164: PRIMARY,
    alias_e164s: [ALIAS],
    display_name: "Larry Lead",
    email: "larry@example.com",
    summary_md: null,
    tags: ["new-lead"],
    owner_employee_id: null,
    lead_source: "Clever",
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z",
    ...overrides
  };
}

/** One active run whose extracted lead phone is `phone`. */
function runRow(phone: string) {
  return {
    id: "run-1",
    flow_id: "flow-1",
    status: "awaiting_reply",
    current_step: 0,
    context: { vars: { lead_phone: phone } },
    respond_by_at: null,
    earliest_claim_at: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-08-02T00:00:00Z"
  };
}

const FLOW = {
  id: "flow-1",
  name: "Lead Intake",
  definition: { steps: [{ type: "send_sms", label: "Text the lead" }] }
};

async function jsonOf(res: Response) {
  return (await res.json()).data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getAuthUser).mockResolvedValue(OWNER as never);
  vi.mocked(isVpsReadMode).mockResolvedValue(true);
  vi.mocked(readMovedRows).mockResolvedValue([]);
});

describe("GET /api/dashboard/tasks on a residency tenant", () => {
  it("builds the board from the box, never asking central for the moved tables", async () => {
    const { asked } = centralDb({ ai_flow_runs: [runRow(PRIMARY)] });
    boxRows({ contacts: [contactRow()], ai_flows: [FLOW] });

    const data = await jsonOf(await tasksGET(new Request(`http://x/?businessId=${BIZ}`)));
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({
      e164: PRIMARY,
      name: "Larry Lead",
      hasContact: true,
      tags: ["new-lead"]
    });
    // The flow name and step position come from the box's ai_flows row.
    expect(data.tasks[0].runs[0]).toMatchObject({
      flowName: "Lead Intake",
      nodeLabel: "Send a text",
      totalSteps: 1
    });
    expect(asked).not.toContain("contacts");
    expect(asked).not.toContain("ai_flows");
    // One mode lookup for the whole request.
    expect(isVpsReadMode).toHaveBeenCalledTimes(1);
    expect(boxRequests("contacts")[0]).toMatchObject({
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        {
          or: [
            [{ column: "customer_e164", op: "in", value: [PRIMARY] }],
            [{ column: "alias_e164s", op: "overlaps", value: [PRIMARY] }]
          ]
        }
      ]
    });
    expect(boxRequests("ai_flows")[0]).toMatchObject({
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "id", op: "in", value: ["flow-1"] }
      ]
    });
  });

  /**
   * The trade PR #1547 and #1565 both made here is retired. The box grammar
   * gained OR groups and array overlap, so an alias-keyed run resolves onto
   * its surviving primary exactly as it does centrally. The two cases below
   * used to differ on purpose, one asserting the box gave up completeness and
   * the other asserting central kept it; they now assert the same outcome,
   * which is the point.
   */
  it("resolves an alias-keyed lead onto its surviving primary, like central", async () => {
    centralDb({ ai_flow_runs: [runRow(ALIAS)] });
    // The box is asked with an OR group, so it finds the surviving contact by
    // its alias and returns it for both the by-phone and the tagged read.
    vi.mocked(readMovedRows).mockImplementation(async (_biz, request) => {
      const req = request as { table: string };
      if (req.table === "ai_flows") return [FLOW] as never;
      return [contactRow()] as never;
    });

    const data = await jsonOf(await tasksGET(new Request(`http://x/?businessId=${BIZ}`)));
    // One card, re-keyed onto the surviving primary and carrying the run,
    // rather than a second unresolved card keyed on the dead alias.
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ e164: PRIMARY, name: "Larry Lead", hasContact: true });
    expect(data.tasks[0].runs).toHaveLength(1);
  });

  it("central mode resolves that alias identically", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(false);
    centralDb({ ai_flow_runs: [runRow(ALIAS)], contacts: [contactRow()], ai_flows: [FLOW] });

    const data = await jsonOf(await tasksGET(new Request(`http://x/?businessId=${BIZ}`)));
    expect(readMovedRows).not.toHaveBeenCalled();
    expect(data.tasks).toHaveLength(1);
    expect(data.tasks[0]).toMatchObject({ e164: PRIMARY, name: "Larry Lead" });
    expect(data.tasks[0].runs).toHaveLength(1);
  });

  it("surfaces an unreachable box as an error, never as an empty board", async () => {
    centralDb({ ai_flow_runs: [runRow(PRIMARY)] });
    vi.mocked(readMovedRows).mockRejectedValue(new ResidencyReadError(BIZ, "box unreachable"));
    const res = await tasksGET(new Request(`http://x/?businessId=${BIZ}`));
    expect(res.status).toBe(500);
    expect((await res.json()).ok).toBe(false);
  });
});

describe("GET /api/dashboard/leads-data on a residency tenant", () => {
  const submission = {
    source: "facebook_lead_ads",
    leadgen_id: "lg-1",
    fields: { Budget: "500k" },
    phone_e164: PRIMARY,
    email: "larry@example.com",
    created_at: "2026-08-02T00:00:00Z"
  };

  it("folds the box's contacts onto the grid's submission rows", async () => {
    const { asked } = centralDb({ lead_submissions: [submission] });
    boxRows({ contacts: [contactRow()] });

    const data = await jsonOf(await leadsDataGET(new Request(`http://x/?businessId=${BIZ}`)));
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toMatchObject({
      e164: PRIMARY,
      name: "Larry Lead",
      tags: ["new-lead"],
      hasContact: true,
      fields: { Budget: "500k" }
    });
    expect(data.columns).toEqual(["Budget"]);
    expect(asked).not.toContain("contacts");
    expect(isVpsReadMode).toHaveBeenCalledTimes(1);
    // Three routed contacts reads: by phone, by email, and the tagged sweep.
    expect(boxRequests("contacts")).toHaveLength(3);
    expect(boxRequests("contacts")[1]).toMatchObject({
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "email", op: "in", value: ["larry@example.com"] }
      ]
    });
    expect(boxRequests("contacts")[2]).toMatchObject({
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "tags", op: "neq", value: "{}" }
      ]
    });
  });

  it("never asks the box for an empty identifier list", async () => {
    // A submission with neither identifier: the by-phone and by-email reads
    // have nothing to match, and an empty `in` is an outright box error.
    centralDb({
      lead_submissions: [{ ...submission, phone_e164: null, email: null }]
    });
    boxRows({ contacts: [] });
    const res = await leadsDataGET(new Request(`http://x/?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    const requests = boxRequests("contacts");
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "tags", op: "neq", value: "{}" }
      ]
    });
  });

  it("reads contacts centrally for everyone else", async () => {
    vi.mocked(isVpsReadMode).mockResolvedValue(false);
    const { asked } = centralDb({ lead_submissions: [submission], contacts: [contactRow()] });
    const data = await jsonOf(await leadsDataGET(new Request(`http://x/?businessId=${BIZ}`)));
    expect(readMovedRows).not.toHaveBeenCalled();
    expect(asked).toContain("contacts");
    expect(data.rows[0]).toMatchObject({ e164: PRIMARY, name: "Larry Lead" });
  });
});

describe("GET /api/dashboard/messages/schedule on a residency tenant", () => {
  it("lists the box's queue, pending first", async () => {
    const { asked } = centralDb();
    vi.mocked(readMovedRows).mockImplementation(async (_biz, request) => {
      const pending = (request as { filters: Array<{ op: string }> }).filters.some(
        (f) => f.op === "eq" && "value" in f && f.value === "pending"
      );
      return (pending ? [{ id: "queued-1" }] : [{ id: "sent-1" }]) as never;
    });
    const data = await jsonOf(await scheduleGET(new Request(`http://x/?businessId=${BIZ}`)));
    expect(data.scheduled.map((s: { id: string }) => s.id)).toEqual(["queued-1", "sent-1"]);
    expect(asked).not.toContain("scheduled_sms");
  });
});

describe("PATCH /api/dashboard/documents/[documentId] on a residency tenant", () => {
  const params = { params: Promise.resolve({ documentId: DOC }) };
  const patchReq = () =>
    new Request(`http://x/api/dashboard/documents/${DOC}`, {
      method: "PATCH",
      body: JSON.stringify({ businessId: BIZ, contactId: CONTACT })
    });

  beforeEach(() => {
    vi.mocked(getBusinessDocument).mockResolvedValue({
      id: DOC,
      contact_id: null,
      expires_at: null,
      renewal_date: null
    } as never);
  });

  it("checks the linked contact against the box, and links it", async () => {
    const { asked } = centralDb();
    boxRows({ contacts: [{ id: CONTACT }] });
    const res = await documentPATCH(patchReq(), params);
    expect(res.status).toBe(200);
    expect(asked).not.toContain("contacts");
    expect(boxRequests("contacts")[0]).toMatchObject({
      table: "contacts",
      filters: [
        { column: "business_id", op: "eq", value: BIZ },
        { column: "id", op: "eq", value: CONTACT }
      ],
      limit: 1
    });
  });

  it("still refuses a contact the box does not have", async () => {
    centralDb();
    boxRows({ contacts: [] });
    const res = await documentPATCH(patchReq(), params);
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toBe("Contact not found");
  });

  it("reports an unreachable box as a broken lookup, not a missing contact", async () => {
    centralDb();
    vi.mocked(readMovedRows).mockRejectedValue(new ResidencyReadError(BIZ, "box unreachable"));
    const res = await documentPATCH(patchReq(), params);
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("Contact lookup failed");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
// Mock the default-client factory so calls WITHOUT the `client` dep exercise
// the `client ?? (await createSupabaseServiceClient())` fallback.
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: vi.fn(async () => ({ results: [] }))
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  ByonValidationError,
  cancelByonPortRequest,
  createByonPortRequest,
  handlePortingStatusChange,
  listByonPortRequests,
  runPortabilityCheck,
  type CreateByonPortRequestInput,
  type PortingClientLike
} from "@/lib/byon/port-requests";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { logger } from "@/lib/logger";

/**
 * Coverage for src/lib/byon/port-requests.ts. Same mocked-PostgREST approach
 * as tests/csv-contacts.test.ts: a chainable builder that records calls and
 * pops scripted `{ data, error }` results at each terminal await.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

type CallLog = { name: string; args: unknown[] };
type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const log: { table: string; calls: CallLog[] }[] = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const calls: CallLog[] = [];
    log.push({ table, calls });
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "insert", "update", "eq", "is", "order"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ name: m, args });
        return builder;
      };
    }
    for (const terminal of ["maybeSingle", "single"]) {
      builder[terminal] = async () => {
        calls.push({ name: terminal, args: [] });
        return next();
      };
    }
    // Chains awaited without a terminal method resolve here.
    builder["then"] = (resolve: (v: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from } as never, log };
}

function makePorting(overrides: Partial<Record<keyof PortingClientLike, unknown>> = {}) {
  return {
    checkPortability: vi.fn(async () => [
      { phone_number: "+13125550001", portable: true, fast_portable: true }
    ]),
    createPortingOrder: vi.fn(async () => [
      { id: "po-1", status: { value: "draft", details: [] }, support_key: "sr_1" }
    ]),
    updatePortingOrder: vi.fn(async () => ({ id: "po-1" })),
    confirmPortingOrder: vi.fn(async () => ({
      id: "po-1",
      status: { value: "submitted", details: [] },
      support_key: "sr_1",
      activation_settings: { foc_datetime_requested: "2026-07-20T13:00:00Z" }
    })),
    cancelPortingOrder: vi.fn(async () => ({ id: "po-1", status: { value: "cancel-pending" } })),
    uploadDocument: vi.fn(async ({ filename }: { filename: string }) => ({
      id: filename.startsWith("loa") ? "doc-loa" : "doc-bill"
    })),
    ...overrides
  } as unknown as PortingClientLike;
}

function baseInput(overrides: Partial<CreateByonPortRequestInput> = {}): CreateByonPortRequestInput {
  return {
    phone: "+13125550001",
    carrier: {
      entityName: "Acme LLC",
      authorizedName: "Jane Doe",
      accountNumber: "ACC-42"
    },
    serviceAddress: {
      street: "311 W Superior St",
      city: "Chicago",
      state: "IL",
      zip: "60654"
    },
    loa: { base64: "JVBERi0xLjQ=", filename: "loa.pdf" },
    bill: { base64: "JVBERi0xLjQ=", filename: "bill.pdf" },
    ...overrides
  };
}

function portRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "req-1",
    business_id: BIZ,
    phone_e164: "+13125550001",
    telnyx_order_id: "po-1",
    status: "submitted",
    status_detail: null,
    foc_at: null,
    support_key: "sr_1",
    loa_document_id: "doc-loa",
    invoice_document_id: "doc-bill",
    notified_status: null,
    activated_at: null,
    created_at: "2026-06-01T00:00:00Z",
    updated_at: "2026-06-01T00:00:00Z",
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("runPortabilityCheck", () => {
  it("rejects unparseable numbers and short codes with owner-facing errors", async () => {
    await expect(runPortabilityCheck("hello", { porting: makePorting() })).rejects.toThrow(
      ByonValidationError
    );
    await expect(runPortabilityCheck("12345", { porting: makePorting() })).rejects.toThrow(
      /Short codes can't be ported/
    );
  });

  it("returns fast-port ETA for portable + fast numbers", async () => {
    const porting = makePorting();
    const summary = await runPortabilityCheck("(312) 555-0001", { porting });
    expect(summary).toEqual({
      phoneE164: "+13125550001",
      portable: true,
      fastPortable: true,
      etaDays: "1-4 business days",
      notPortableReason: null,
      carrierName: null
    });
    expect(porting.checkPortability).toHaveBeenCalledWith(["+13125550001"]);
  });

  it("returns the standard ETA when portable but not fast, keeping the carrier name", async () => {
    const porting = makePorting({
      checkPortability: vi.fn(async () => [
        {
          phone_number: "+13125550001",
          portable: true,
          fast_portable: false,
          carrier_name: "Old Carrier"
        }
      ])
    });
    const summary = await runPortabilityCheck("+13125550001", { porting });
    expect(summary.fastPortable).toBe(false);
    expect(summary.etaDays).toBe("3-7 business days");
    expect(summary.carrierName).toBe("Old Carrier");
  });

  it("reports the not-portable reason (with a fallback when Telnyx omits it)", async () => {
    const porting = makePorting({
      checkPortability: vi.fn(async () => [
        {
          phone_number: "+13125550001",
          portable: false,
          fast_portable: false,
          not_portable_reason: "no_coverage"
        }
      ])
    });
    const summary = await runPortabilityCheck("+13125550001", { porting });
    expect(summary.portable).toBe(false);
    expect(summary.etaDays).toBe("");
    expect(summary.notPortableReason).toBe("no_coverage");

    const porting2 = makePorting({
      checkPortability: vi.fn(async () => [
        { phone_number: "+13125550001", portable: false, fast_portable: false }
      ])
    });
    const summary2 = await runPortabilityCheck("+13125550001", { porting: porting2 });
    expect(summary2.notPortableReason).toBe("Not portable");
  });

  it("falls back to the first result when phone_number doesn't echo back, and handles empty results", async () => {
    const porting = makePorting({
      checkPortability: vi.fn(async () => [
        { phone_number: "13125550001", portable: true, fast_portable: false }
      ])
    });
    const summary = await runPortabilityCheck("+13125550001", { porting });
    expect(summary.portable).toBe(true);

    const porting2 = makePorting({ checkPortability: vi.fn(async () => []) });
    const summary2 = await runPortabilityCheck("+13125550001", { porting: porting2 });
    expect(summary2.portable).toBe(false);
    expect(summary2.notPortableReason).toBe("Telnyx could not evaluate this number.");
  });

  it("builds a real Telnyx client from TELNYX_API_KEY when no client is injected", async () => {
    vi.stubEnv("TELNYX_API_KEY", "test-key");
    const fetchSpy = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: [{ phone_number: "+13125550001", portable: true, fast_portable: true }]
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        )
    );
    vi.stubGlobal("fetch", fetchSpy);
    const summary = await runPortabilityCheck("+13125550001");
    expect(summary.portable).toBe(true);
    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it("throws when TELNYX_API_KEY is missing and no client is injected", async () => {
    vi.stubEnv("TELNYX_API_KEY", "");
    await expect(runPortabilityCheck("+13125550001")).rejects.toThrow(/TELNYX_API_KEY missing/);
  });
});

describe("createByonPortRequest", () => {
  it("rejects each missing required field with a specific message", async () => {
    const deps = { porting: makePorting(), client: makeDb([]).db };
    const cases: [Partial<CreateByonPortRequestInput>, RegExp][] = [
      // Absent field (undefined, not just blank) → covers the `value ?? ""` arm.
      [{ carrier: {} as CreateByonPortRequestInput["carrier"] }, /business name/],
      [{ carrier: { entityName: " ", authorizedName: "J", accountNumber: "A" } }, /business name/],
      [{ carrier: { entityName: "E", authorizedName: "", accountNumber: "A" } }, /authorized to port/],
      [{ carrier: { entityName: "E", authorizedName: "J", accountNumber: "" } }, /account number/],
      [
        { serviceAddress: { street: "", city: "C", state: "S", zip: "Z" } },
        /street address/
      ],
      [{ serviceAddress: { street: "St", city: "", state: "S", zip: "Z" } }, /city/],
      [{ serviceAddress: { street: "St", city: "C", state: "", zip: "Z" } }, /state/],
      [{ serviceAddress: { street: "St", city: "C", state: "S", zip: "" } }, /ZIP/],
      [{ loa: { base64: "", filename: "loa.pdf" } }, /Upload the signed LOA/],
      [{ loa: { base64: "AAAA", filename: " " } }, /missing a filename/],
      [{ bill: { base64: "", filename: "bill.pdf" } }, /Upload the recent bill/],
      // Optional billing phone must fail up front (before any Telnyx call).
      [
        {
          carrier: {
            entityName: "E",
            authorizedName: "J",
            accountNumber: "A",
            billingPhone: "not-a-number"
          }
        },
        /valid phone number|10-digit/
      ]
    ];
    for (const [override, msg] of cases) {
      await expect(createByonPortRequest(BIZ, baseInput(override), deps)).rejects.toThrow(msg);
    }
    // None of the validation failures may have touched Telnyx.
    expect(deps.porting.createPortingOrder).not.toHaveBeenCalled();
    expect(deps.porting.uploadDocument).not.toHaveBeenCalled();
  });

  it("rejects documents over the 5 MB cap but accepts one exactly at it", async () => {
    // Exact base64 length of a 5 MB file: 4·ceil(n/3) per RFC 4648.
    const exactCap = 4 * Math.ceil((5 * 1024 * 1024) / 3);
    const huge = "A".repeat(exactCap + 4); // one base64 block over → > 5 MB raw
    await expect(
      createByonPortRequest(BIZ, baseInput({ loa: { base64: huge, filename: "loa.pdf" } }), {
        porting: makePorting(),
        client: makeDb([]).db
      })
    ).rejects.toThrow(/too large/);

    // A file of exactly 5 MB passes the size gate (whatever happens later on
    // the empty scripted DB, it is not the size rejection).
    const atCap = "A".repeat(exactCap);
    const outcome = await createByonPortRequest(
      BIZ,
      baseInput({ loa: { base64: atCap, filename: "loa.pdf" } }),
      { porting: makePorting(), client: makeDb([]).db }
    ).catch((e: unknown) => e);
    expect(String(outcome)).not.toMatch(/too large/);
  });

  it("throws when Telnyx returns no orders", async () => {
    const porting = makePorting({ createPortingOrder: vi.fn(async () => []) });
    await expect(
      createByonPortRequest(BIZ, baseInput(), { porting, client: makeDb([]).db })
    ).rejects.toThrow(/did not return a porting order/);
  });

  it("persists draft rows first, patches with full details, confirms, and refreshes the row", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com/");
    const porting = makePorting();
    const { db, log } = makeDb([
      { data: [portRow({ status: "draft" })], error: null }, // insert
      { data: [portRow({ status: "submitted" })], error: null } // post-confirm update
    ]);
    const result = await createByonPortRequest(
      BIZ,
      baseInput({
        carrier: {
          entityName: "Acme LLC",
          authorizedName: "Jane Doe",
          accountNumber: "ACC-42",
          pin: " 1234 ",
          billingPhone: "312-555-0001"
        },
        serviceAddress: {
          street: "311 W Superior St",
          extended: " Suite 400 ",
          city: "Chicago",
          state: "IL",
          zip: "60654",
          country: "us"
        },
        focDatetimeRequested: "2026-07-20T13:00:00Z"
      }),
      { porting, client: db }
    );

    expect(result.submitted).toBe(true);
    expect(result.submitError).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].status).toBe("submitted");

    expect(porting.createPortingOrder).toHaveBeenCalledWith({
      phoneNumbers: ["+13125550001"],
      customerReference: `byon:${BIZ}`
    });
    expect(porting.uploadDocument).toHaveBeenCalledTimes(2);
    expect(porting.updatePortingOrder).toHaveBeenCalledWith("po-1", {
      documents: { loa: "doc-loa", invoice: "doc-bill" },
      endUser: {
        admin: {
          entity_name: "Acme LLC",
          auth_person_name: "Jane Doe",
          account_number: "ACC-42",
          pin_passcode: "1234",
          billing_phone_number: "+13125550001"
        },
        location: {
          street_address: "311 W Superior St",
          extended_address: "Suite 400",
          locality: "Chicago",
          administrative_area: "IL",
          postal_code: "60654",
          country_code: "US"
        }
      },
      misc: { type: "full" },
      focDatetimeRequested: "2026-07-20T13:00:00Z",
      webhookUrl: "https://app.example.com/api/telnyx/porting-webhook"
    });
    expect(porting.confirmPortingOrder).toHaveBeenCalledWith("po-1");

    // Tracking row exists BEFORE confirm, in the order's draft state.
    const inserted = (log[0].calls.find((c) => c.name === "insert")?.args[0] as Record<
      string,
      unknown
    >[])[0];
    expect(inserted).toMatchObject({
      business_id: BIZ,
      phone_e164: "+13125550001",
      telnyx_order_id: "po-1",
      status: "draft",
      foc_at: null,
      support_key: "sr_1",
      loa_document_id: "doc-loa",
      invoice_document_id: "doc-bill"
    });
    // Post-confirm refresh mirrors the confirmed order snapshot.
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "submitted",
      status_detail: [],
      foc_at: "2026-07-20T13:00:00Z",
      support_key: "sr_1"
    });
    expect(log[1].calls).toContainEqual({ name: "eq", args: ["telnyx_order_id", "po-1"] });
    // Refresh is conditional on the status we inserted, so a webhook that
    // already advanced the row can't be clobbered by the confirm snapshot.
    expect(log[1].calls).toContainEqual({ name: "eq", args: ["status", "draft"] });
  });

  it("omits optional fields, defaults webhook URL to localhost and status to submitted", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", undefined);
    const porting = makePorting({
      createPortingOrder: vi.fn(async () => [{ id: "po-1" }]),
      confirmPortingOrder: vi.fn(async () => ({ id: "po-1" }))
    });
    const { db, log } = makeDb([
      { data: [portRow({ status: "draft" })], error: null },
      { data: [portRow({ status: "submitted" })], error: null }
    ]);
    const result = await createByonPortRequest(BIZ, baseInput(), { porting, client: db });

    expect(result.submitted).toBe(true);
    const patch = vi.mocked(porting.updatePortingOrder).mock.calls[0][1];
    expect(patch.endUser?.admin).not.toHaveProperty("pin_passcode");
    expect(patch.endUser?.admin).not.toHaveProperty("billing_phone_number");
    expect(patch.endUser?.location).not.toHaveProperty("extended_address");
    expect(patch.endUser?.location?.country_code).toBe("US");
    expect(patch).not.toHaveProperty("focDatetimeRequested");
    expect(patch.webhookUrl).toBe("http://localhost:3000/api/telnyx/porting-webhook");

    // Order carried no status/support_key → insert falls back to draft/null.
    const inserted = (log[0].calls.find((c) => c.name === "insert")?.args[0] as Record<
      string,
      unknown
    >[])[0];
    expect(inserted).toMatchObject({ status: "draft", status_detail: null, support_key: null });
    // Confirm succeeded but returned no status → refresh defaults to submitted.
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "submitted",
      status_detail: null,
      foc_at: null,
      support_key: null
    });
  });

  it("keeps the draft with a SUBMIT_FAILED detail when confirm fails, mirroring the PATCH response", async () => {
    const porting = makePorting({
      // Telnyx stored the PATCH (requested FOC, support key) before confirm
      // blew up — the refresh must mirror the PATCH, not the create snapshot.
      updatePortingOrder: vi.fn(async () => ({
        id: "po-1",
        activation_settings: { foc_datetime_requested: "2026-07-20T13:00:00Z" },
        support_key: "sr_patched"
      })),
      confirmPortingOrder: vi.fn(async () => {
        throw new Error("requirements not met");
      })
    });
    const { db, log } = makeDb([
      { data: [portRow({ status: "draft" })], error: null },
      { data: [portRow({ status: "draft" })], error: null }
    ]);
    const result = await createByonPortRequest(BIZ, baseInput(), { porting, client: db });
    expect(result.submitted).toBe(false);
    expect(result.submitError).toBe("requirements not met");
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: porting order submit failed; kept as draft",
      expect.objectContaining({ orderId: "po-1" })
    );
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "draft",
      status_detail: [{ code: "SUBMIT_FAILED", description: "requirements not met" }],
      foc_at: "2026-07-20T13:00:00Z",
      support_key: "sr_patched"
    });
  });

  it("also catches updatePortingOrder failures and stringifies non-Error throws", async () => {
    const porting = makePorting({
      createPortingOrder: vi.fn(async () => [{ id: "po-1" }]),
      updatePortingOrder: vi.fn(async () => {
        throw "boom";
      })
    });
    const { db, log } = makeDb([
      { data: [portRow({ status: "draft" })], error: null },
      { data: [portRow({ status: "draft" })], error: null }
    ]);
    const result = await createByonPortRequest(BIZ, baseInput(), { porting, client: db });
    expect(result.submitError).toBe("boom");
    expect(porting.confirmPortingOrder).not.toHaveBeenCalled();
    // Order had no status of its own → falls back to draft.
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "draft",
      status_detail: [{ code: "SUBMIT_FAILED", description: "boom" }]
    });
  });

  it("submits split orders independently and keeps the first failure as submitError", async () => {
    const porting = makePorting({
      createPortingOrder: vi.fn(async () => [
        { id: "po-1", status: { value: "draft" } },
        { id: "po-2", status: { value: "draft" } },
        { id: "po-3", status: { value: "draft" } }
      ]),
      confirmPortingOrder: vi.fn(async (orderId: string) => {
        if (orderId === "po-2") throw new Error("first failure");
        if (orderId === "po-3") throw new Error("second failure");
        return { id: orderId, status: { value: "submitted" } };
      })
    });
    const { db } = makeDb([
      { data: [portRow(), portRow({ id: "req-2" }), portRow({ id: "req-3" })], error: null },
      { data: [portRow({ status: "submitted" })], error: null },
      { data: [portRow({ id: "req-2", status: "draft" })], error: null },
      { data: [portRow({ id: "req-3", status: "draft" })], error: null }
    ]);
    const result = await createByonPortRequest(BIZ, baseInput(), { porting, client: db });
    // po-1 confirmed even though po-2/po-3 failed; flag reports the batch.
    expect(porting.confirmPortingOrder).toHaveBeenCalledTimes(3);
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].status).toBe("submitted");
    expect(result.submitted).toBe(false);
    expect(result.submitError).toBe("first failure");
  });

  it("throws when the tracking insert fails (before anything is confirmed)", async () => {
    const porting = makePorting();
    const { db } = makeDb([{ data: null, error: { message: "insert exploded" } }]);
    await expect(
      createByonPortRequest(BIZ, baseInput(), { porting, client: db })
    ).rejects.toThrow(/createByonPortRequest: insert exploded/);
    expect(porting.confirmPortingOrder).not.toHaveBeenCalled();
  });

  it("falls back to the inserted row (overlaid with the confirm state) when the refresh fails, and to nothing when the insert returned no rows", async () => {
    const porting = makePorting();
    const { db } = makeDb([
      { data: [portRow({ status: "draft" })], error: null },
      { data: null, error: { message: "refresh exploded" } }
    ]);
    const result = await createByonPortRequest(BIZ, baseInput(), { porting, client: db });
    expect(result.rows).toHaveLength(1);
    // Telnyx accepted the submit even though the bookkeeping write failed —
    // the returned row reflects the confirmed state, not the stale draft,
    // so it agrees with `submitted: true`.
    expect(result.submitted).toBe(true);
    expect(result.rows[0]).toMatchObject({
      status: "submitted",
      foc_at: "2026-07-20T13:00:00Z",
      support_key: "sr_1"
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: failed to refresh port request row after submit",
      expect.objectContaining({ error: "refresh exploded" })
    );

    // PostgREST returning no rows from insert (data: null) + refresh failure.
    const { db: db2 } = makeDb([
      { data: null, error: null },
      { data: null, error: { message: "refresh exploded" } }
    ]);
    const result2 = await createByonPortRequest(BIZ, baseInput(), {
      porting: makePorting(),
      client: db2
    });
    expect(result2.rows).toEqual([]);
  });

  it("returns the webhook's row when a status webhook wins the race against the confirm refresh", async () => {
    const webhookRow = portRow({
      status: "exception",
      status_detail: [{ code: "ACCOUNT_NUMBER_MISMATCH", description: "wrong account" }]
    });
    const { db, log } = makeDb([
      { data: [portRow({ status: "draft" })], error: null }, // insert
      { data: [], error: null }, // conditional refresh matched 0 rows
      { data: webhookRow, error: null } // re-fetch current state
    ]);
    const result = await createByonPortRequest(BIZ, baseInput(), {
      porting: makePorting(),
      client: db
    });
    // The webhook's exception state survives; the confirm snapshot did not clobber it.
    expect(result.rows).toEqual([webhookRow]);
    expect(log[2].calls).toContainEqual({ name: "eq", args: ["telnyx_order_id", "po-1"] });

    // Re-fetch coming back empty too → fall back to the inserted row
    // overlaid with what Telnyx confirmed.
    const { db: db2 } = makeDb([
      { data: [portRow({ status: "draft" })], error: null },
      { data: [], error: null },
      { data: null, error: null }
    ]);
    const result2 = await createByonPortRequest(BIZ, baseInput(), {
      porting: makePorting(),
      client: db2
    });
    expect(result2.rows).toHaveLength(1);
    expect(result2.rows[0].status).toBe("submitted");
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb([
      { data: [portRow({ status: "draft" })], error: null },
      { data: [portRow({ status: "submitted" })], error: null }
    ]);
    defaultClientSpy.mockReturnValue(db);
    const result = await createByonPortRequest(BIZ, baseInput(), { porting: makePorting() });
    expect(result.rows).toHaveLength(1);
    expect(defaultClientSpy).toHaveBeenCalledOnce();
  });
});

describe("listByonPortRequests", () => {
  it("lists a business's requests newest-first", async () => {
    const { db, log } = makeDb([{ data: [portRow()], error: null }]);
    const rows = await listByonPortRequests(BIZ, db);
    expect(rows).toHaveLength(1);
    expect(log[0].table).toBe("number_port_requests");
    expect(log[0].calls).toContainEqual({ name: "eq", args: ["business_id", BIZ] });
    expect(log[0].calls).toContainEqual({
      name: "order",
      args: ["created_at", { ascending: false }]
    });
  });

  it("returns [] when data is null, throws on error, and defaults the client", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    defaultClientSpy.mockReturnValue(db);
    expect(await listByonPortRequests(BIZ)).toEqual([]);

    const { db: db2 } = makeDb([{ data: null, error: { message: "list exploded" } }]);
    await expect(listByonPortRequests(BIZ, db2)).rejects.toThrow(
      /listByonPortRequests: list exploded/
    );
  });
});

describe("cancelByonPortRequest", () => {
  it("returns null when the row doesn't exist and throws on lookup errors", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    expect(await cancelByonPortRequest(BIZ, "req-404", { client: db })).toBeNull();

    const { db: db2 } = makeDb([{ data: null, error: { message: "lookup exploded" } }]);
    await expect(cancelByonPortRequest(BIZ, "req-1", { client: db2 })).rejects.toThrow(
      /cancelByonPortRequest: lookup exploded/
    );
  });

  it("refuses to cancel terminal requests with status-specific messages", async () => {
    const { db } = makeDb([{ data: portRow({ status: "ported" }), error: null }]);
    await expect(cancelByonPortRequest(BIZ, "req-1", { client: db })).rejects.toThrow(
      /already finished porting/
    );

    const { db: db2 } = makeDb([{ data: portRow({ status: "cancelled" }), error: null }]);
    await expect(cancelByonPortRequest(BIZ, "req-1", { client: db2 })).rejects.toThrow(
      /already cancelled/
    );
  });

  it("cancels the Telnyx order and mirrors its returned status", async () => {
    const porting = makePorting();
    const { db, log } = makeDb([
      { data: portRow(), error: null },
      { data: [portRow({ status: "cancel-pending" })], error: null }
    ]);
    const updated = await cancelByonPortRequest(BIZ, "req-1", { client: db, porting });
    expect(porting.cancelPortingOrder).toHaveBeenCalledWith("po-1");
    expect(updated?.status).toBe("cancel-pending");
    // Conditional on the status we read, so a webhook that landed mid-cancel
    // can't be regressed.
    expect(log[1].calls).toContainEqual({ name: "eq", args: ["status", "submitted"] });
  });

  it("returns the webhook's row when a status webhook wins the race against cancel", async () => {
    const porting = makePorting();
    const { db } = makeDb([
      { data: portRow(), error: null }, // read: submitted
      { data: [], error: null }, // conditional update matched 0 rows
      { data: portRow({ status: "ported" }), error: null } // re-fetch
    ]);
    const updated = await cancelByonPortRequest(BIZ, "req-1", { client: db, porting });
    expect(updated?.status).toBe("ported");

    // Re-fetch empty → fall back to the row we originally read. (The update
    // returning null instead of [] covers PostgREST's no-rows shape.)
    const { db: db2 } = makeDb([
      { data: portRow(), error: null },
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const updated2 = await cancelByonPortRequest(BIZ, "req-1", {
      client: db2,
      porting: makePorting()
    });
    expect(updated2?.status).toBe("submitted");

    // Re-fetch error → surfaces.
    const { db: db3 } = makeDb([
      { data: portRow(), error: null },
      { data: [], error: null },
      { data: null, error: { message: "refetch exploded" } }
    ]);
    await expect(
      cancelByonPortRequest(BIZ, "req-1", { client: db3, porting: makePorting() })
    ).rejects.toThrow(/cancelByonPortRequest: refetch exploded/);
  });

  it("falls back to cancel-pending when Telnyx omits a status, and to cancelled without an order id", async () => {
    const porting = makePorting({ cancelPortingOrder: vi.fn(async () => ({ id: "po-1" })) });
    const { db, log } = makeDb([
      { data: portRow(), error: null },
      { data: [portRow({ status: "cancel-pending" })], error: null }
    ]);
    await cancelByonPortRequest(BIZ, "req-1", { client: db, porting });
    const updateCall = log[1].calls.find((c) => c.name === "update");
    expect(updateCall?.args[0]).toMatchObject({ status: "cancel-pending" });

    // Dead draft with no Telnyx order: no API call, straight to cancelled.
    const porting2 = makePorting();
    const { db: db2, log: log2 } = makeDb([
      { data: portRow({ telnyx_order_id: null, status: "draft" }), error: null },
      { data: [portRow({ status: "cancelled" })], error: null }
    ]);
    const updated = await cancelByonPortRequest(BIZ, "req-1", { client: db2, porting: porting2 });
    expect(porting2.cancelPortingOrder).not.toHaveBeenCalled();
    expect(updated?.status).toBe("cancelled");
    const updateCall2 = log2[1].calls.find((c) => c.name === "update");
    expect(updateCall2?.args[0]).toMatchObject({ status: "cancelled" });
  });

  it("throws when the status update fails", async () => {
    const { db } = makeDb([
      { data: portRow({ telnyx_order_id: null }), error: null },
      { data: null, error: { message: "update exploded" } }
    ]);
    await expect(cancelByonPortRequest(BIZ, "req-1", { client: db })).rejects.toThrow(
      /cancelByonPortRequest: update exploded/
    );
  });
});

describe("handlePortingStatusChange", () => {
  const dispatchMock = vi.mocked(dispatchUrgentNotification);

  it("ignores payloads without an order id or status", async () => {
    expect(await handlePortingStatusChange({}, { client: makeDb([]).db })).toEqual({
      handled: false,
      ported: false,
      row: null
    });
    expect(
      await handlePortingStatusChange({ id: "po-1" }, { client: makeDb([]).db })
    ).toMatchObject({ handled: false });
    expect(
      await handlePortingStatusChange({ status: { value: "ported" } }, { client: makeDb([]).db })
    ).toMatchObject({ handled: false });
  });

  it("warns and skips when no row matches the order, throws on lookup errors", async () => {
    const { db } = makeDb([{ data: null, error: null }]);
    const result = await handlePortingStatusChange(
      { id: "po-unknown", status: { value: "ported" } },
      { client: db }
    );
    expect(result.handled).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: porting webhook for unknown order",
      expect.objectContaining({ orderId: "po-unknown" })
    );

    const { db: db2 } = makeDb([{ data: null, error: { message: "lookup exploded" } }]);
    await expect(
      handlePortingStatusChange({ id: "po-1", status: { value: "ported" } }, { client: db2 })
    ).rejects.toThrow(/handlePortingStatusChange: lookup exploded/);
  });

  it("mirrors the status onto the row and notifies on a milestone transition", async () => {
    const details = [{ code: "ACCOUNT_NUMBER_MISMATCH", description: "wrong account" }];
    const { db, log } = makeDb([
      { data: portRow({ status: "submitted" }), error: null },
      { data: [portRow({ status: "exception", status_detail: details })], error: null },
      // Milestone claim (notified_status CAS) wins.
      {
        data: [portRow({ status: "exception", status_detail: details, notified_status: "exception" })],
        error: null
      }
    ]);
    const dispatch = vi.fn(async () => ({ results: [] }));
    const result = await handlePortingStatusChange(
      {
        id: "po-1",
        status: { value: "exception", details },
        support_key: "sr_2"
      },
      { client: db, dispatch: dispatch as never }
    );
    expect(result.handled).toBe(true);
    expect(result.ported).toBe(false);
    expect(result.row?.status).toBe("exception");
    const updateCall = log[1].calls.find((c) => c.name === "update");
    expect(updateCall?.args[0]).toMatchObject({
      status: "exception",
      status_detail: details,
      support_key: "sr_2"
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        kind: "byon_port",
        summary: expect.stringContaining("Action needed"),
        payload: expect.objectContaining({ status: "exception", status_detail: details })
      })
    );
  });

  it("prefers actual FOC over requested over the prior value", async () => {
    const { db, log } = makeDb([
      { data: portRow({ foc_at: "2026-07-01T00:00:00Z" }), error: null },
      { data: [portRow()], error: null }
    ]);
    await handlePortingStatusChange(
      {
        id: "po-1",
        status: { value: "foc-date-confirmed" },
        activation_settings: {
          foc_datetime_actual: "2026-07-22T13:00:00Z",
          foc_datetime_requested: "2026-07-20T13:00:00Z"
        }
      },
      { client: db, dispatch: vi.fn(async () => ({ results: [] })) as never }
    );
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      foc_at: "2026-07-22T13:00:00Z"
    });

    const { db: db2, log: log2 } = makeDb([
      { data: portRow({ foc_at: "2026-07-01T00:00:00Z", support_key: "sr_prior" }), error: null },
      { data: [portRow()], error: null }
    ]);
    // submitted → in-process is a backward move; a newer occurred_at proves
    // it's a genuine event rather than a delayed retry.
    await handlePortingStatusChange(
      {
        id: "po-1",
        status: { value: "in-process" },
        activation_settings: { foc_datetime_requested: "2026-07-20T13:00:00Z" }
      },
      { client: db2 },
      "2026-06-02T00:00:00Z"
    );
    expect(log2[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      foc_at: "2026-07-20T13:00:00Z",
      support_key: "sr_prior"
    });

    const { db: db3, log: log3 } = makeDb([
      { data: portRow({ foc_at: "2026-07-01T00:00:00Z" }), error: null },
      { data: [portRow()], error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "in-process" } },
      { client: db3 },
      "2026-06-02T00:00:00Z"
    );
    expect(log3[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      foc_at: "2026-07-01T00:00:00Z"
    });
  });

  it("throws when the row update fails", async () => {
    const { db } = makeDb([
      { data: portRow(), error: null },
      { data: null, error: { message: "update exploded" } }
    ]);
    await expect(
      handlePortingStatusChange({ id: "po-1", status: { value: "ported" } }, { client: db })
    ).rejects.toThrow(/handlePortingStatusChange: update exploded/);
  });

  it("does not notify on repeats of the same status or non-milestone moves", async () => {
    // notified_status shows the exception alert already went out.
    const { db } = makeDb([
      { data: portRow({ status: "exception", notified_status: "exception" }), error: null },
      { data: [portRow({ status: "exception" })], error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "exception" } },
      { client: db }
    );
    expect(dispatchMock).not.toHaveBeenCalled();

    const { db: db2 } = makeDb([
      { data: portRow({ status: "in-process" }), error: null },
      { data: [portRow({ status: "submitted" })], error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db2 }
    );
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("keeps stored exception details on redeliveries that omit them, overwrites when they arrive", async () => {
    const stored = [{ code: "ACCOUNT_NUMBER_MISMATCH", description: "wrong account" }];

    // Same-status redelivery WITHOUT details carries nothing new → no write
    // at all (bumping updated_at would skew occurred_at ordering later).
    const { db, log } = makeDb([
      {
        data: portRow({ status: "exception", status_detail: stored, notified_status: "exception" }),
        error: null
      }
    ]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "exception" } },
      { client: db }
    );
    expect(result.handled).toBe(true);
    expect(result.row?.status_detail).toEqual(stored);
    expect(log).toHaveLength(1); // read only, no update

    // Same-status redelivery with EMPTY details → same no-op.
    const { db: db2, log: log2 } = makeDb([
      {
        data: portRow({ status: "exception", status_detail: stored, notified_status: "exception" }),
        error: null
      }
    ]);
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "exception", details: [] } },
      { client: db2 }
    );
    expect(result2.row?.status_detail).toEqual(stored);
    expect(log2).toHaveLength(1);

    // Same-status redelivery WITH new details → overwrite. (Alert already
    // claimed for this status, so no re-notification.)
    const fresh = [{ code: "PASSCODE_PIN_INVALID", description: "bad pin" }];
    const { db: db3, log: log3 } = makeDb([
      {
        data: portRow({ status: "exception", status_detail: stored, notified_status: "exception" }),
        error: null
      },
      {
        data: [
          portRow({ status: "exception", status_detail: fresh, notified_status: "exception" })
        ],
        error: null
      }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "exception", details: fresh } },
      { client: db3 }
    );
    expect(log3[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status_detail: fresh
    });

    // Status TRANSITION without details → clears stale exception codes.
    // (exception → in-process is backward, so it needs a newer occurred_at.)
    const { db: db4, log: log4 } = makeDb([
      { data: portRow({ status: "exception", status_detail: stored }), error: null },
      { data: [portRow({ status: "in-process", status_detail: null })], error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "in-process" } },
      { client: db4 },
      "2026-06-02T00:00:00Z"
    );
    expect(log4[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status_detail: null
    });
  });

  it("drops stale events: terminal rows never regress, backward moves need a newer occurred_at", async () => {
    // Delayed "submitted" retry arriving after the port finished → dropped.
    const { db, log } = makeDb([{ data: portRow({ status: "ported" }), error: null }]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db }
    );
    expect(result).toMatchObject({ handled: true, ported: false });
    expect(result.row?.status).toBe("ported");
    expect(log).toHaveLength(1); // lookup only, no update
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: dropped stale porting status event",
      expect.objectContaining({ priorStatus: "ported", status: "submitted" })
    );
    expect(dispatchMock).not.toHaveBeenCalled();

    // Backward move without any occurred_at → indistinguishable from a retry → dropped.
    const { db: db2, log: log2 } = makeDb([
      { data: portRow({ status: "exception" }), error: null }
    ]);
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db2 }
    );
    expect(result2.row?.status).toBe("exception");
    expect(log2).toHaveLength(1);

    // Backward move whose occurred_at predates our last write → stale → dropped.
    const { db: db3, log: log3 } = makeDb([
      { data: portRow({ status: "exception", updated_at: "2026-06-01T00:00:00Z" }), error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db3 },
      "2026-05-31T00:00:00Z"
    );
    expect(log3).toHaveLength(1);

    // Backward move but the row has no usable updated_at → can't order → dropped.
    const { db: db4, log: log4 } = makeDb([
      { data: portRow({ status: "exception", updated_at: null }), error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db4 },
      "2026-06-02T00:00:00Z"
    );
    expect(log4).toHaveLength(1);

    // Genuine recovery: backward move with a NEWER occurred_at → applied.
    const { db: db5, log: log5 } = makeDb([
      { data: portRow({ status: "exception", updated_at: "2026-06-01T00:00:00Z" }), error: null },
      { data: [portRow({ status: "submitted" })], error: null }
    ]);
    const result5 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db5 },
      "2026-06-02T00:00:00Z"
    );
    expect(result5.row?.status).toBe("submitted");
    expect(log5[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "submitted"
    });

    // Unknown PRIOR status also ranks highest, so moving off it counts as
    // backward and needs a newer occurred_at too.
    const { db: db7, log: log7 } = makeDb([
      { data: portRow({ status: "weird-status" }), error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" } },
      { client: db7 }
    );
    expect(log7).toHaveLength(1);

    // Statuses Telnyx adds later rank highest and always apply.
    const { db: db6, log: log6 } = makeDb([
      { data: portRow({ status: "submitted" }), error: null },
      { data: [portRow({ status: "brand-new-status" })], error: null }
    ]);
    const result6 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "brand-new-status" } },
      { client: db6 }
    );
    expect(result6.row?.status).toBe("brand-new-status");
    expect(log6).toHaveLength(2);
  });

  it("still writes same-status redeliveries that carry a new FOC date or support key", async () => {
    // Same status but a NEW FOC date → real information, write it. (Alert
    // for this status was already claimed, so no re-notification.)
    const { db, log } = makeDb([
      {
        data: portRow({
          status: "foc-date-confirmed",
          foc_at: "2026-07-20T13:00:00Z",
          notified_status: "foc-date-confirmed"
        }),
        error: null
      },
      {
        data: [
          portRow({
            status: "foc-date-confirmed",
            foc_at: "2026-07-25T13:00:00Z",
            notified_status: "foc-date-confirmed"
          })
        ],
        error: null
      }
    ]);
    await handlePortingStatusChange(
      {
        id: "po-1",
        status: { value: "foc-date-confirmed" },
        activation_settings: { foc_datetime_actual: "2026-07-25T13:00:00Z" }
      },
      { client: db }
    );
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      foc_at: "2026-07-25T13:00:00Z"
    });

    // Same status but a NEW support key (prior had none) → write it.
    const { db: db2, log: log2 } = makeDb([
      { data: portRow({ status: "submitted", support_key: null }), error: null },
      { data: [portRow({ status: "submitted", support_key: "sr_new" })], error: null }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "submitted" }, support_key: "sr_new" },
      { client: db2 }
    );
    expect(log2[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      support_key: "sr_new"
    });
    expect(dispatchMock).not.toHaveBeenCalled();

    // Neither the payload nor the row has a support key → stays null.
    const { db: db3, log: log3 } = makeDb([
      { data: portRow({ status: "submitted", support_key: null }), error: null },
      {
        data: [
          portRow({
            status: "foc-date-confirmed",
            support_key: null,
            notified_status: "foc-date-confirmed"
          })
        ],
        error: null
      }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "foc-date-confirmed" } },
      { client: db3 }
    );
    expect(log3[1].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      support_key: null
    });
  });

  it("yields to a concurrent delivery that wins the compare-and-swap, without notifying twice", async () => {
    // Our conditional update matches zero rows because a parallel worker
    // already applied this transition → return their row, notify nothing.
    // The winner finished its work, including the alert claim.
    const winnerRow = portRow({ status: "ported", notified_status: "ported" });
    const { db, log } = makeDb([
      { data: portRow({ status: "foc-date-confirmed" }), error: null }, // read
      { data: [], error: null }, // CAS matched 0 rows
      { data: winnerRow, error: null } // re-fetch
    ]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db }
    );
    expect(result).toMatchObject({ handled: true, ported: false });
    expect(result.row).toEqual(winnerRow);
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: porting status update lost the write race",
      expect.objectContaining({ orderId: "po-1", status: "ported" })
    );
    expect(log[1].calls).toContainEqual({ name: "eq", args: ["status", "foc-date-confirmed"] });

    // CAS returning null data + re-fetch coming back empty → fall back to
    // the row we originally read.
    const { db: db2 } = makeDb([
      { data: portRow({ status: "foc-date-confirmed" }), error: null },
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db2 }
    );
    expect(result2.ported).toBe(false);
    expect(result2.row?.status).toBe("foc-date-confirmed");
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("retries a lost compare-and-swap against the fresh row instead of discarding the event", async () => {
    // Another writer moved submitted → exception while we processed
    // "ported"; the event still applies to the fresh row, so the second
    // attempt lands and the milestone alert fires exactly once.
    const { db } = makeDb([
      { data: portRow({ status: "submitted" }), error: null }, // read
      { data: [], error: null }, // CAS 1 lost
      { data: portRow({ status: "exception" }), error: null }, // re-read
      { data: [portRow({ status: "ported" })], error: null }, // CAS 2 wins
      { data: [portRow({ status: "ported", notified_status: "ported" })], error: null } // claim
    ]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db }
    );
    expect(result.ported).toBe(true);
    expect(result.row?.status).toBe("ported");
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    // The fresh row can also make the event stale (terminal) → drop it.
    dispatchMock.mockClear();
    const { db: db2 } = makeDb([
      { data: portRow({ status: "submitted" }), error: null },
      { data: [], error: null },
      { data: portRow({ status: "cancelled" }), error: null } // re-read: terminal
    ]);
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "foc-date-confirmed" } },
      { client: db2 }
    );
    expect(result2).toMatchObject({ handled: true, ported: false });
    expect(result2.row?.status).toBe("cancelled");
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: dropped stale porting status event",
      expect.objectContaining({ priorStatus: "cancelled" })
    );
  });

  it("merges newer same-status fields after losing the CAS to a concurrent delivery", async () => {
    // We carry fresh exception details; a parallel delivery wins the status
    // CAS first but with no details. The retry lands in the same-status
    // path and merges our details in — without re-alerting (already claimed).
    const fresh = [{ code: "PASSCODE_PIN_INVALID", description: "bad pin" }];
    const { db, log } = makeDb([
      { data: portRow({ status: "submitted" }), error: null }, // read
      { data: [], error: null }, // CAS 1 lost
      {
        data: portRow({ status: "exception", status_detail: null, notified_status: "exception" }),
        error: null
      }, // re-read: winner wrote the status, no details
      {
        data: [
          portRow({ status: "exception", status_detail: fresh, notified_status: "exception" })
        ],
        error: null
      } // CAS 2: same-status merge
    ]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "exception", details: fresh } },
      { client: db }
    );
    expect(result.handled).toBe(true);
    expect(result.row?.status_detail).toEqual(fresh);
    expect(log[3].calls.find((c) => c.name === "update")?.args[0]).toMatchObject({
      status: "exception",
      status_detail: fresh
    });
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("gives up (so Telnyx retries) after persistent write interference, and surfaces re-read errors", async () => {
    const contested: Scripted[] = [{ data: portRow({ status: "submitted" }), error: null }];
    for (let i = 0; i < 3; i++) {
      contested.push({ data: [], error: null }); // CAS lost
      contested.push({ data: portRow({ status: "in-process" }), error: null }); // re-read, still applies
    }
    const { db } = makeDb(contested);
    await expect(
      handlePortingStatusChange({ id: "po-1", status: { value: "ported" } }, { client: db })
    ).rejects.toThrow(/gave up after 3 conflicting writes/);
    expect(dispatchMock).not.toHaveBeenCalled();

    const { db: db2 } = makeDb([
      { data: portRow({ status: "submitted" }), error: null },
      { data: [], error: null },
      { data: null, error: { message: "reread exploded" } }
    ]);
    await expect(
      handlePortingStatusChange({ id: "po-1", status: { value: "ported" } }, { client: db2 })
    ).rejects.toThrow(/handlePortingStatusChange: reread exploded/);
  });

  it("flags ported=true only for the delivery that claims the milestone, using the module dispatcher", async () => {
    const { db } = makeDb([
      { data: portRow({ status: "foc-date-confirmed" }), error: null },
      { data: [portRow({ status: "ported" })], error: null }, // status CAS
      { data: [portRow({ status: "ported", notified_status: "ported" })], error: null } // claim
    ]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db }
    );
    expect(result.ported).toBe(true);
    expect(result.row?.notified_status).toBe("ported");
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("finished porting") })
    );

    // Redelivery of an already-alerted ported row → no re-notify, ported=false.
    const { db: db2 } = makeDb([
      { data: portRow({ status: "ported", notified_status: "ported" }), error: null }
    ]);
    dispatchMock.mockClear();
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db2 }
    );
    expect(result2.ported).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();
  });

  it("recovers a missed milestone alert from a crashed delivery, exactly once", async () => {
    // The delivery that wrote `ported` died before notifying: the row says
    // ported but notified_status is still null. This retry carries nothing
    // new (no-op write) yet claims the alert and reports the activation.
    const { db, log } = makeDb([
      { data: portRow({ status: "ported", notified_status: null }), error: null },
      { data: [portRow({ status: "ported", notified_status: "ported" })], error: null } // claim
    ]);
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db }
    );
    expect(result.ported).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(log[1].calls.find((c) => c.name === "update")?.args[0]).toEqual({
      notified_status: "ported"
    });
    expect(log[1].calls).toContainEqual({ name: "eq", args: ["status", "ported"] });
    expect(log[1].calls).toContainEqual({ name: "is", args: ["notified_status", null] });

    // A stale claim (notified_status from an earlier milestone) swaps via eq.
    dispatchMock.mockClear();
    const { db: db2, log: log2 } = makeDb([
      { data: portRow({ status: "cancelled", notified_status: "exception" }), error: null },
      {
        data: [portRow({ status: "cancelled", notified_status: "cancelled" })],
        error: null
      }
    ]);
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "cancelled" } },
      { client: db2 }
    );
    expect(result2.ported).toBe(false); // cancelled, not ported
    expect(dispatchMock).toHaveBeenCalledTimes(1);
    expect(log2[1].calls).toContainEqual({ name: "eq", args: ["notified_status", "exception"] });

    // FOC-confirmed milestone recovery uses its own summary copy.
    dispatchMock.mockClear();
    const { db: db5 } = makeDb([
      { data: portRow({ status: "foc-date-confirmed", notified_status: null }), error: null },
      {
        data: [portRow({ status: "foc-date-confirmed", notified_status: "foc-date-confirmed" })],
        error: null
      }
    ]);
    await handlePortingStatusChange(
      { id: "po-1", status: { value: "foc-date-confirmed" } },
      { client: db5 }
    );
    expect(dispatchMock).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("Port date confirmed") })
    );

    // A parallel retry lost the claim CAS → no duplicate alert. (Both the
    // empty-array and null no-rows shapes.)
    dispatchMock.mockClear();
    const { db: db3 } = makeDb([
      { data: portRow({ status: "ported", notified_status: null }), error: null },
      { data: [], error: null } // claim lost
    ]);
    const result3 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db3 }
    );
    expect(result3.ported).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();

    const { db: db3b } = makeDb([
      { data: portRow({ status: "ported", notified_status: null }), error: null },
      { data: null, error: null }
    ]);
    const result3b = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db3b }
    );
    expect(result3b.ported).toBe(false);
    expect(dispatchMock).not.toHaveBeenCalled();

    // Losing the STATUS CAS to a writer that crashed before claiming: the
    // re-read shows our very transition unclaimed → this delivery claims it.
    dispatchMock.mockClear();
    const { db: db6 } = makeDb([
      { data: portRow({ status: "foc-date-confirmed" }), error: null }, // read
      { data: [], error: null }, // status CAS lost
      { data: portRow({ status: "ported", notified_status: null }), error: null }, // re-read
      { data: [portRow({ status: "ported", notified_status: "ported" })], error: null } // claim
    ]);
    const result6 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db6 }
    );
    expect(result6.ported).toBe(true);
    expect(dispatchMock).toHaveBeenCalledTimes(1);

    // Claim write errors are logged, never thrown (Telnyx should not retry
    // a status that was persisted fine).
    dispatchMock.mockClear();
    const { db: db4 } = makeDb([
      { data: portRow({ status: "ported", notified_status: null }), error: null },
      { data: null, error: { message: "claim exploded" } }
    ]);
    const result4 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "ported" } },
      { client: db4 }
    );
    expect(result4).toMatchObject({ handled: true, ported: false });
    expect(dispatchMock).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: failed to claim milestone alert",
      expect.objectContaining({ error: "claim exploded" })
    );
  });

  it("covers cancelled summary and releases the claim when dispatch fails (Error and non-Error)", async () => {
    const { db, log } = makeDb([
      { data: portRow({ status: "submitted" }), error: null },
      { data: [portRow({ status: "cancelled" })], error: null }, // status CAS
      { data: [portRow({ status: "cancelled", notified_status: "cancelled" })], error: null }, // claim
      { data: null, error: null } // claim release after the dispatch throw
    ]);
    const throwingDispatch = vi.fn(async () => {
      throw new Error("smtp down");
    });
    const result = await handlePortingStatusChange(
      { id: "po-1", status: { value: "cancelled" } },
      { client: db, dispatch: throwingDispatch as never }
    );
    expect(result.handled).toBe(true);
    expect(throwingDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ summary: expect.stringContaining("was cancelled") })
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: status notification failed",
      expect.objectContaining({ error: "smtp down" })
    );
    // The claim is RELEASED so a later delivery re-attempts the alert.
    expect(log[3].calls.find((c) => c.name === "update")?.args[0]).toEqual({
      notified_status: null
    });
    expect(log[3].calls).toContainEqual({ name: "eq", args: ["notified_status", "cancelled"] });
    expect(result.row?.notified_status).toBeNull();

    // Non-Error throw + a prior milestone claim → release restores it, and a
    // release failure is logged loudly.
    const { db: db2, log: log2 } = makeDb([
      {
        data: portRow({ status: "cancelled", notified_status: "exception" }),
        error: null
      }, // read (no-op path: status already cancelled)
      { data: [portRow({ status: "cancelled", notified_status: "cancelled" })], error: null }, // claim
      { data: null, error: { message: "release exploded" } } // release fails
    ]);
    const throwingDispatch2 = vi.fn(async () => {
      throw "wat";
    });
    const result2 = await handlePortingStatusChange(
      { id: "po-1", status: { value: "cancelled" } },
      { client: db2, dispatch: throwingDispatch2 as never }
    );
    expect(logger.warn).toHaveBeenCalledWith(
      "byon: status notification failed",
      expect.objectContaining({ error: "wat" })
    );
    // Release restores the PRE-claim notified_status ("exception").
    expect(log2[2].calls.find((c) => c.name === "update")?.args[0]).toEqual({
      notified_status: "exception"
    });
    expect(result2.row?.notified_status).toBe("exception");
    expect(logger.error).toHaveBeenCalledWith(
      "byon: failed to release milestone claim after alert failure",
      expect.objectContaining({ error: "release exploded" })
    );
  });

  it("uses the default service client when none is injected", async () => {
    const { db } = makeDb([
      { data: portRow({ status: "draft" }), error: null },
      { data: [portRow({ status: "in-process" })], error: null }
    ]);
    defaultClientSpy.mockReturnValue(db);
    const result = await handlePortingStatusChange({
      id: "po-1",
      status: { value: "in-process" }
    });
    expect(result.handled).toBe(true);
    expect(defaultClientSpy).toHaveBeenCalledOnce();
  });
});

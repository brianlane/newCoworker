/**
 * Meta Conversion Leads outbox drain (src/lib/meta/capi-drain.ts):
 * batch claim, per-business connection gating, identifier resolution
 * through lead_submissions, terminal-state bookkeeping, and retry/expiry.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...a: unknown[]) => defaultClientSpy(...a)
}));

const infoSpy = vi.fn();
const warnSpy = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: {
    info: (...a: unknown[]) => infoSpy(...a),
    warn: (...a: unknown[]) => warnSpy(...a)
  }
}));

const getMetaConnection = vi.fn();
vi.mock("@/lib/db/meta-connections", () => ({
  getMetaConnection: (...a: unknown[]) => getMetaConnection(...a)
}));

const buildConversionLeadBody = vi.fn();
const sendConversionLeadBody = vi.fn();
vi.mock("@/lib/meta/capi", () => ({
  CAPI_EVENT_MAX_AGE_MS: 7 * 24 * 60 * 60 * 1000,
  buildConversionLeadBody: (...a: unknown[]) => buildConversionLeadBody(...a),
  sendConversionLeadBody: (...a: unknown[]) => sendConversionLeadBody(...a)
}));

import {
  CAPI_MAX_ATTEMPTS,
  drainMetaCapiEvents
} from "@/lib/meta/capi-drain";

const BIZ = "00000000-0000-0000-0000-000000000001";

const READY_CONNECTION = {
  status: "active",
  is_active: true,
  capi_enabled: true,
  dataset_id: "ds-1",
  pageToken: "page-tok"
};

function outboxRow(over: Record<string, unknown> = {}) {
  return {
    id: "evt-1",
    business_id: BIZ,
    contact_e164: "+16025551234",
    event_name: "Booked",
    event_time: new Date().toISOString(),
    dedupe_key: "ce:1",
    attempts: 0,
    ...over
  };
}

type Scripted = { data?: unknown; error?: unknown };

/**
 * Scripted db keyed by TABLE: each terminal consumes the next result from
 * that table's queue. Updates are recorded (table meta_capi_events).
 */
function makeDb(queues: Record<string, Scripted[]>) {
  const updates: Array<{ id: unknown; fields: Record<string, unknown> }> = [];
  const idx: Record<string, number> = {};
  const next = (table: string): Scripted => {
    const queue = queues[table] ?? [];
    const i = (idx[table] = (idx[table] ?? 0) + 1) - 1;
    return queue[i] ?? { data: null, error: null };
  };
  const from = (table: string) => {
    let pendingUpdate: Record<string, unknown> | null = null;
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "in", "not", "order", "limit"]) {
      builder[m] = () => builder;
    }
    builder["update"] = (fields: Record<string, unknown>) => {
      pendingUpdate = fields;
      return builder;
    };
    builder["eq"] = (column: string, value: unknown) => {
      if (pendingUpdate && column === "id") {
        updates.push({ id: value, fields: pendingUpdate });
      }
      return builder;
    };
    builder["maybeSingle"] = async () => next(table);
    builder["then"] = (resolve: (v: unknown) => unknown) => {
      // An awaited update resolves its own scripted result stream.
      if (pendingUpdate) {
        return Promise.resolve(next(`${table}:update`)).then(resolve);
      }
      return Promise.resolve(next(table)).then(resolve);
    };
    return builder;
  };
  return { db: { from }, updates };
}

beforeEach(() => {
  defaultClientSpy.mockReset();
  infoSpy.mockReset();
  warnSpy.mockReset();
  getMetaConnection.mockReset();
  buildConversionLeadBody.mockReset();
  sendConversionLeadBody.mockReset();
});

describe("drainMetaCapiEvents", () => {
  it("sends a resolvable row and marks it sent", async () => {
    const { db, updates } = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [
        { data: { alias_e164s: ["+16025550000"], email: "jane@x.co" }, error: null }
      ],
      lead_submissions: [
        { data: { leadgen_id: "1993202861289031", email: "jane@x.co" }, error: null }
      ]
    });
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockReturnValue('{"data":[…]}');
    sendConversionLeadBody.mockResolvedValue({ eventsReceived: 1 });

    const summary = await drainMetaCapiEvents(db as never);
    expect(summary).toMatchObject({ claimed: 1, sent: 1, skipped: 0, failed: 0 });
    expect(buildConversionLeadBody).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: "Booked",
        eventId: "ce:1",
        leadgenId: "1993202861289031",
        email: "jane@x.co",
        phoneE164: "+16025551234"
      })
    );
    expect(sendConversionLeadBody).toHaveBeenCalledWith("ds-1", "page-tok", '{"data":[…]}');
    expect(updates).toEqual([
      {
        id: "evt-1",
        fields: expect.objectContaining({ status: "sent", last_error: null })
      }
    ]);
    // sent > 0 → summary log.
    expect(infoSpy).toHaveBeenCalled();
  });

  it("returns an empty summary on batch-read error or zero rows", async () => {
    const err = makeDb({ meta_capi_events: [{ data: null, error: { message: "down" } }] });
    expect(await drainMetaCapiEvents(err.db as never)).toMatchObject({
      claimed: 0,
      sent: 0
    });
    expect(warnSpy).toHaveBeenCalled();

    const empty = makeDb({ meta_capi_events: [{ data: [], error: null }] });
    expect(await drainMetaCapiEvents(empty.db as never)).toMatchObject({ claimed: 0 });

    const nullData = makeDb({ meta_capi_events: [{ data: null, error: null }] });
    expect(await drainMetaCapiEvents(nullData.db as never)).toMatchObject({ claimed: 0 });
  });

  it("expires rows older than the 7-day window before any lookup", async () => {
    const { db, updates } = makeDb({
      meta_capi_events: [
        {
          data: [
            outboxRow({ event_time: new Date(Date.now() - 8 * 24 * 3600e3).toISOString() })
          ],
          error: null
        }
      ]
    });
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    const summary = await drainMetaCapiEvents(db as never);
    expect(summary.expired).toBe(1);
    expect(updates[0].fields.status).toBe("expired");
    expect(buildConversionLeadBody).not.toHaveBeenCalled();
  });

  it("skips every not-CAPI-ready connection shape (and lookup failures)", async () => {
    const badConnections = [
      null,
      { ...READY_CONNECTION, dataset_id: null },
      { ...READY_CONNECTION, capi_enabled: false },
      { ...READY_CONNECTION, is_active: false },
      { ...READY_CONNECTION, status: "pending" },
      { ...READY_CONNECTION, pageToken: null }
    ];
    for (const connection of badConnections) {
      getMetaConnection.mockReset().mockResolvedValue(connection);
      const { db, updates } = makeDb({
        meta_capi_events: [{ data: [outboxRow()], error: null }]
      });
      const summary = await drainMetaCapiEvents(db as never);
      expect(summary.skipped, JSON.stringify(connection)).toBe(1);
      expect(updates[0].fields.status).toBe("skipped");
    }

    // A throwing connection lookup degrades to the same skip — Error and
    // non-Error rejections both.
    getMetaConnection.mockReset().mockRejectedValue(new Error("conn down"));
    const { db } = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }]
    });
    expect((await drainMetaCapiEvents(db as never)).skipped).toBe(1);
    expect(warnSpy).toHaveBeenCalled();

    getMetaConnection.mockReset().mockRejectedValue("conn string boom");
    const stringy = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }]
    });
    expect((await drainMetaCapiEvents(stringy.db as never)).skipped).toBe(1);
  });

  it("defers with a stringified error when the payload builder throws a non-Error", async () => {
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockImplementation(() => {
      throw "build boom";
    });
    const { db, updates } = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: { leadgen_id: "1993202861289031", email: null }, error: null }]
    });
    expect((await drainMetaCapiEvents(db as never)).deferred).toBe(1);
    expect(updates[0].fields).toMatchObject({ attempts: 1, last_error: "build boom" });
  });

  it("skips leads with no Meta-identified submission (phone AND email misses)", async () => {
    const { db, updates } = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: { alias_e164s: null, email: "jane@x.co" }, error: null }],
      lead_submissions: [
        { data: null, error: null }, // by phone: none
        { data: null, error: null } // by email: none
      ]
    });
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    const summary = await drainMetaCapiEvents(db as never);
    expect(summary.skipped).toBe(1);
    expect(updates[0].fields.status).toBe("skipped");
    expect(buildConversionLeadBody).not.toHaveBeenCalled();
  });

  it("resolves through the email fallback and skips when the contact has no email", async () => {
    // Email fallback hit.
    const viaEmail = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: { alias_e164s: null, email: "Jane@X.co" }, error: null }],
      lead_submissions: [
        { data: null, error: null }, // by phone: none
        { data: { leadgen_id: "1993202861289031", email: null }, error: null }
      ]
    });
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockReturnValue("{}");
    sendConversionLeadBody.mockResolvedValue({ eventsReceived: 1 });
    expect((await drainMetaCapiEvents(viaEmail.db as never)).sent).toBe(1);

    // Contact row missing entirely → no aliases, no email → phone miss ends it.
    buildConversionLeadBody.mockReset();
    const noContact = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: null, error: null }]
    });
    expect((await drainMetaCapiEvents(noContact.db as never)).skipped).toBe(1);

    // Contact present but emailless → the email fallback is skipped too.
    const noEmail = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: { alias_e164s: null, email: null }, error: null }],
      lead_submissions: [{ data: null, error: null }]
    });
    expect((await drainMetaCapiEvents(noEmail.db as never)).skipped).toBe(1);
  });

  it("skips when the builder finds no usable identifier in the submission", async () => {
    const { db, updates } = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: { leadgen_id: "bad", email: null }, error: null }]
    });
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockReturnValue(null);
    const summary = await drainMetaCapiEvents(db as never);
    expect(summary.skipped).toBe(1);
    expect(updates[0].fields.status).toBe("skipped");
  });

  it("defers on identifier-resolution read errors (transient), keeping the row pending", async () => {
    for (const scripts of [
      // by-phone query error
      { contacts: [{ data: null, error: null }], lead_submissions: [{ data: null, error: { message: "phone read down" } }] },
      // by-email query error
      {
        contacts: [{ data: { alias_e164s: null, email: "j@x.co" }, error: null }],
        lead_submissions: [
          { data: null, error: null },
          { data: null, error: { message: "email read down" } }
        ]
      }
    ]) {
      getMetaConnection.mockReset().mockResolvedValue(READY_CONNECTION);
      const { db, updates } = makeDb({
        meta_capi_events: [{ data: [outboxRow()], error: null }],
        ...scripts
      });
      const summary = await drainMetaCapiEvents(db as never);
      expect(summary.deferred).toBe(1);
      expect(updates[0].fields).toMatchObject({ attempts: 1 });
      expect(updates[0].fields).not.toHaveProperty("status");
    }
  });

  it("retries transient send failures, then marks failed at the attempt cap", async () => {
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockReturnValue("{}");
    sendConversionLeadBody.mockRejectedValue(new Error("graph 500"));

    const retried = makeDb({
      meta_capi_events: [{ data: [outboxRow({ attempts: 0 })], error: null }],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: { leadgen_id: "1993202861289031", email: null }, error: null }]
    });
    const first = await drainMetaCapiEvents(retried.db as never);
    expect(first.deferred).toBe(1);
    expect(retried.updates[0].fields).toMatchObject({
      attempts: 1,
      last_error: "graph 500"
    });

    const capped = makeDb({
      meta_capi_events: [
        { data: [outboxRow({ attempts: CAPI_MAX_ATTEMPTS - 1 })], error: null }
      ],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: { leadgen_id: "1993202861289031", email: null }, error: null }]
    });
    const last = await drainMetaCapiEvents(capped.db as never);
    expect(last.failed).toBe(1);
    expect(capped.updates[0].fields).toMatchObject({
      status: "failed",
      attempts: CAPI_MAX_ATTEMPTS
    });
    expect(infoSpy).toHaveBeenCalled(); // failed > 0 also logs the summary
  });

  it("substitutes now for an unparseable event_time and logs failed row updates", async () => {
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockReturnValue("{}");
    sendConversionLeadBody.mockResolvedValue({ eventsReceived: 1 });
    const before = Date.now();
    const { db } = makeDb({
      meta_capi_events: [
        { data: [outboxRow({ event_time: "not-a-date" })], error: null },
        // markRow's awaited update result: an error → warn branch.
      ],
      "meta_capi_events:update": [{ data: null, error: { message: "update down" } }],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: { leadgen_id: "1993202861289031", email: null }, error: null }]
    });
    const summary = await drainMetaCapiEvents(db as never);
    expect(summary.sent).toBe(1);
    const input = buildConversionLeadBody.mock.calls[0][0] as { eventTimeMs: number };
    expect(input.eventTimeMs).toBeGreaterThanOrEqual(before);
    expect(warnSpy).toHaveBeenCalledWith(
      "meta capi drain: row update failed",
      expect.objectContaining({ id: "evt-1" })
    );
  });

  it("stringifies non-Error failures and uses the default client when none is injected", async () => {
    getMetaConnection.mockResolvedValue(READY_CONNECTION);
    buildConversionLeadBody.mockReturnValue("{}");
    sendConversionLeadBody.mockRejectedValue("string boom");
    const { db, updates } = makeDb({
      meta_capi_events: [{ data: [outboxRow()], error: null }],
      contacts: [{ data: null, error: null }],
      lead_submissions: [{ data: { leadgen_id: "1993202861289031", email: null }, error: null }]
    });
    defaultClientSpy.mockResolvedValue(db);
    const summary = await drainMetaCapiEvents();
    expect(summary.deferred).toBe(1);
    expect(updates[0].fields.last_error).toBe("string boom");
  });
});

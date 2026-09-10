import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  insertSystemLog,
  recordSystemLog,
  listSystemLogs,
  listSystemLogsAll,
  listSystemLogErrorsAll,
  buildLogSearchFilter,
  buildLogEventFilter,
  quoteLogLikeTerm,
  emailAndDomainFromSystemLog,
  recordFailure
} from "@/lib/db/system-logs";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

const MOCK_ROW = {
  id: 1,
  business_id: "biz-uuid-1",
  source: "aiflow",
  level: "error",
  event: "ai_flow_run_failed",
  message: "telnyx 500",
  payload: { run_id: "run-1" },
  created_at: "2026-06-09T00:00:00Z"
};

function mockDb(overrides: Record<string, unknown> = {}) {
  return {
    from: vi.fn().mockReturnThis(),
    insert: vi.fn().mockResolvedValue({ error: null }),
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    or: vi.fn().mockReturnThis(),
    lt: vi.fn().mockReturnThis(),
    order: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue({ data: [MOCK_ROW], error: null }),
    gte: vi.fn().mockReturnThis(),
    is: vi.fn().mockReturnThis(),
    ...overrides
  };
}

describe("db/system-logs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("insertSystemLog inserts a normalized row", async () => {
    const db = mockDb();
    await insertSystemLog(
      {
        businessId: "biz-uuid-1",
        source: "aiflow",
        level: "error",
        event: "ai_flow_run_failed",
        message: "telnyx 500",
        payload: { run_id: "run-1" }
      },
      db as never
    );
    expect(db.from).toHaveBeenCalledWith("system_logs");
    expect(db.insert).toHaveBeenCalledWith({
      business_id: "biz-uuid-1",
      source: "aiflow",
      level: "error",
      event: "ai_flow_run_failed",
      message: "telnyx 500",
      payload: { run_id: "run-1" }
    });
  });

  it("insertSystemLog defaults business_id to null and payload to {}", async () => {
    const db = mockDb();
    await insertSystemLog(
      { source: "app", level: "info", event: "fleet_sweep" },
      db as never
    );
    expect(db.insert).toHaveBeenCalledWith(
      expect.objectContaining({ business_id: null, payload: {}, message: "" })
    );
  });

  it("insertSystemLog truncates oversized messages", async () => {
    const db = mockDb();
    await insertSystemLog(
      { source: "app", level: "warn", event: "x", message: "a".repeat(5000) },
      db as never
    );
    const inserted = db.insert.mock.calls[0][0] as { message: string };
    expect(inserted.message).toHaveLength(4000);
  });

  it("insertSystemLog throws on insert error", async () => {
    const db = mockDb({ insert: vi.fn().mockResolvedValue({ error: { message: "boom" } }) });
    await expect(
      insertSystemLog({ source: "app", level: "error", event: "x" }, db as never)
    ).rejects.toThrow("insertSystemLog: boom");
  });

  it("recordSystemLog never throws when the insert fails", async () => {
    const db = mockDb({ insert: vi.fn().mockResolvedValue({ error: { message: "down" } }) });
    await expect(
      recordSystemLog({ source: "app", level: "error", event: "x" }, db as never)
    ).resolves.toBeUndefined();
  });

  it("recordSystemLog never throws when client creation fails", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no env"));
    await expect(
      recordSystemLog({ source: "app", level: "info", event: "x" })
    ).resolves.toBeUndefined();
  });

  it("recordSystemLog stringifies non-Error failures", async () => {
    vi.mocked(createSupabaseServiceClient).mockRejectedValue("string blowup");
    await expect(
      recordSystemLog({ source: "app", level: "info", event: "x" })
    ).resolves.toBeUndefined();
  });

  it("insertSystemLog falls back to the service client when none is passed", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await insertSystemLog({ source: "app", level: "info", event: "x" });
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(db.insert).toHaveBeenCalled();
  });

  it("listSystemLogs scopes to business and applies exact level", async () => {
    const db = mockDb();
    const rows = await listSystemLogs("biz-uuid-1", { level: "error" }, db as never);
    expect(rows).toEqual([MOCK_ROW]);
    expect(db.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(db.eq).toHaveBeenCalledWith("level", "error");
  });

  it("listSystemLogs expands minLevel into an in() filter", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { minLevel: "warn" }, db as never);
    expect(db.in).toHaveBeenCalledWith("level", ["warn", "error"]);
  });

  it("listSystemLogs treats minLevel=debug as no level filter", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { minLevel: "debug" }, db as never);
    expect(db.in).not.toHaveBeenCalled();
    expect(db.eq).toHaveBeenCalledTimes(1); // business_id only
  });

  it("listSystemLogs skips the search clause for a whitespace-only search", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { search: "   " }, db as never);
    expect(db.or).not.toHaveBeenCalled();
  });

  it("listSystemLogs still searches when the term is ALL reserved characters", async () => {
    // This used to sanitize to "" and quietly search for nothing. Every one of
    // these characters is now escaped rather than deleted.
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { search: "%_,()" }, db as never);
    expect(db.or).toHaveBeenCalledTimes(1);
  });

  it("listSystemLogs falls back to the service client when none is passed", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const rows = await listSystemLogs("biz-uuid-1");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(rows).toEqual([MOCK_ROW]);
  });

  it("listSystemLogs applies source, escaped search, and before", async () => {
    const db = mockDb();
    await listSystemLogs(
      "biz-uuid-1",
      { source: "aiflow", search: "tel%nyx", before: "2026-06-09T00:00:00Z" },
      db as never
    );
    expect(db.eq).toHaveBeenCalledWith("source", "aiflow");
    // The % is escaped to a literal instead of being deleted, so this no longer
    // silently searches for "telnyx".
    expect(db.or).toHaveBeenCalledWith(
      String.raw`event.ilike."%tel\\%nyx%",message.ilike."%tel\\%nyx%"`
    );
    expect(db.lt).toHaveBeenCalledWith("created_at", "2026-06-09T00:00:00Z");
  });

  it("listSystemLogs applies event substring and since", async () => {
    const db = mockDb();
    await listSystemLogs(
      "biz-uuid-1",
      { event: "email_delivery_failed", since: "2026-09-01T00:00:00Z" },
      db as never
    );
    expect(db.or).toHaveBeenCalledWith(
      String.raw`event.ilike."%email\\_delivery\\_failed%"`
    );
    expect(db.gte).toHaveBeenCalledWith("created_at", "2026-09-01T00:00:00Z");
  });

  it("listSystemLogs skips a whitespace-only event filter", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { event: "   " }, db as never);
    expect(db.or).not.toHaveBeenCalled();
  });

  it("listSystemLogs finds a snake_case event name", async () => {
    // The bug this closes: `ai_flow_run_failed` used to become
    // `aiflowrunfailed` and return zero rows with no warning, which reads
    // exactly like "there were no such failures".
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { search: "ai_flow_run_failed" }, db as never);
    expect(db.or).toHaveBeenCalledWith(
      String.raw`event.ilike."%ai\\_flow\\_run\\_failed%",message.ilike."%ai\\_flow\\_run\\_failed%"`
    );
  });

  it("listSystemLogs returns [] when the query yields null data", async () => {
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(listSystemLogs("biz-uuid-1", {}, db as never)).resolves.toEqual([]);
  });

  it("listSystemLogs caps the limit at 500", async () => {
    const db = mockDb();
    await listSystemLogs("biz-uuid-1", { limit: 999 }, db as never);
    expect(db.limit).toHaveBeenCalledWith(500);
  });

  it("listSystemLogs throws on query error", async () => {
    const db = mockDb({
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } })
    });
    await expect(listSystemLogs("biz-uuid-1", {}, db as never)).rejects.toThrow(
      "listSystemLogs"
    );
  });

  it("listSystemLogErrorsAll filters level=error and joins business name", async () => {
    const withBiz = { ...MOCK_ROW, businesses: { name: "Acme" } };
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [withBiz], error: null }) });
    const rows = await listSystemLogErrorsAll(10, db as never);
    expect(rows[0].businesses?.name).toBe("Acme");
    expect(db.eq).toHaveBeenCalledWith("level", "error");
    expect(db.select).toHaveBeenCalledWith(expect.stringContaining("businesses(name)"));
  });

  it("listSystemLogErrorsAll falls back to the service client and default limit", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const rows = await listSystemLogErrorsAll();
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
    expect(db.limit).toHaveBeenCalledWith(30);
    expect(rows).toEqual([MOCK_ROW]);
  });

  it("listSystemLogErrorsAll returns [] when the query yields null data", async () => {
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(listSystemLogErrorsAll(5, db as never)).resolves.toEqual([]);
  });

  it("listSystemLogErrorsAll excludes muted businesses but keeps platform rows", async () => {
    const db = mockDb();
    await listSystemLogErrorsAll(10, db as never, {
      excludeBusinessIds: ["biz-a", "biz-b"]
    });
    expect(db.or).toHaveBeenCalledWith(
      "business_id.is.null,business_id.not.in.(biz-a,biz-b)"
    );
  });

  it("listSystemLogErrorsAll skips the exclusion clause for an empty list", async () => {
    const db = mockDb();
    await listSystemLogErrorsAll(10, db as never, { excludeBusinessIds: [] });
    expect(db.or).not.toHaveBeenCalled();
  });

  it("listSystemLogErrorsAll throws on error", async () => {
    const db = mockDb({
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } })
    });
    await expect(listSystemLogErrorsAll(10, db as never)).rejects.toThrow(
      "listSystemLogErrorsAll"
    );
  });
});

describe("listSystemLogsAll", () => {
  beforeEach(() => vi.clearAllMocks());

  it("is fleet-wide when businessId is omitted, and joins business name", async () => {
    const withBiz = { ...MOCK_ROW, businesses: { name: "Acme" } };
    const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [withBiz], error: null }) });
    const rows = await listSystemLogsAll({ limit: 10 }, db as never);
    expect(rows[0].businesses?.name).toBe("Acme");
    expect(db.select).toHaveBeenCalledWith(expect.stringContaining("businesses(name)"));
    expect(db.eq).not.toHaveBeenCalledWith("business_id", expect.anything());
    expect(db.limit).toHaveBeenCalledWith(10);
  });

  it("scopes to one business when businessId is set", async () => {
    const db = mockDb();
    await listSystemLogsAll({ businessId: "biz-uuid-1", minLevel: "warn" }, db as never);
    expect(db.eq).toHaveBeenCalledWith("business_id", "biz-uuid-1");
    expect(db.in).toHaveBeenCalledWith("level", ["warn", "error"]);
  });

  it("applies exact level, event, search, since, and before together", async () => {
    const db = mockDb();
    await listSystemLogsAll(
      {
        businessId: "biz-uuid-1",
        level: "error",
        event: "email_delivery_failed",
        search: "telnyx",
        since: "2026-09-01T00:00:00Z",
        before: "2026-09-10T00:00:00Z",
        source: "email"
      },
      db as never
    );
    expect(db.eq).toHaveBeenCalledWith("level", "error");
    expect(db.eq).toHaveBeenCalledWith("source", "email");
    expect(db.or).toHaveBeenCalledWith(
      String.raw`event.ilike."%email\\_delivery\\_failed%"`
    );
    expect(db.or).toHaveBeenCalledWith(
      'event.ilike."%telnyx%",message.ilike."%telnyx%"'
    );
    expect(db.gte).toHaveBeenCalledWith("created_at", "2026-09-01T00:00:00Z");
    expect(db.lt).toHaveBeenCalledWith("created_at", "2026-09-10T00:00:00Z");
  });

  it("caps the limit at 200 and defaults to 50", async () => {
    const db = mockDb();
    await listSystemLogsAll({ limit: 999 }, db as never);
    expect(db.limit).toHaveBeenCalledWith(200);
    const db2 = mockDb();
    await listSystemLogsAll({}, db2 as never);
    expect(db2.limit).toHaveBeenCalledWith(50);
  });

  it("falls back to the service client and returns [] on null data", async () => {
    const db = mockDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await expect(listSystemLogsAll()).resolves.toEqual([MOCK_ROW]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);

    const empty = mockDb({ limit: vi.fn().mockResolvedValue({ data: null, error: null }) });
    await expect(listSystemLogsAll({}, empty as never)).resolves.toEqual([]);
  });

  it("throws on query error", async () => {
    const db = mockDb({
      limit: vi.fn().mockResolvedValue({ data: null, error: { message: "err" } })
    });
    await expect(listSystemLogsAll({}, db as never)).rejects.toThrow("listSystemLogsAll");
  });
});

describe("emailAndDomainFromSystemLog", () => {
  it("prefers payload.to, then email, then recipient", () => {
    expect(
      emailAndDomainFromSystemLog({
        payload: { to: "Owner@Acme.com" },
        message: "other@x.com in the message"
      })
    ).toEqual({ email: "owner@acme.com", domain: "acme.com" });
    expect(
      emailAndDomainFromSystemLog({
        payload: { email: "Name <sales@Acme.com>" },
        message: ""
      })
    ).toEqual({ email: "sales@acme.com", domain: "acme.com" });
    expect(
      emailAndDomainFromSystemLog({
        payload: { recipient: "ops@shop.io" },
        message: ""
      })
    ).toEqual({ email: "ops@shop.io", domain: "shop.io" });
  });

  it("pulls an address out of a sentence in payload or message", () => {
    expect(
      emailAndDomainFromSystemLog({
        payload: { to: "bounced to lead@trades.com on send" },
        message: ""
      })
    ).toEqual({ email: "lead@trades.com", domain: "trades.com" });
    expect(
      emailAndDomainFromSystemLog({
        payload: {},
        message: "Email was not delivered (bounced) to foo@bar.com."
      })
    ).toEqual({ email: "foo@bar.com", domain: "bar.com" });
  });

  it("uses payload.domain when present, and skips a domain with no dot", () => {
    expect(
      emailAndDomainFromSystemLog({
        payload: { to: "a@x.com", domain: "Custom.Host" },
        message: ""
      })
    ).toEqual({ email: "a@x.com", domain: "custom.host" });
    expect(
      emailAndDomainFromSystemLog({
        payload: { to: "a@x.com", domain: "nodot" },
        message: ""
      })
    ).toEqual({ email: "a@x.com", domain: "x.com" });
  });

  it("returns nulls when nothing parseable is present", () => {
    expect(emailAndDomainFromSystemLog({ payload: { to: 12 }, message: "no address" })).toEqual({
      email: null,
      domain: null
    });
    expect(emailAndDomainFromSystemLog({ payload: null, message: "" })).toEqual({
      email: null,
      domain: null
    });
    expect(emailAndDomainFromSystemLog({ payload: { to: "   " }, message: "   " })).toEqual({
      email: null,
      domain: null
    });
    expect(
      emailAndDomainFromSystemLog({ payload: { to: "bounced, no address" }, message: "" })
    ).toEqual({ email: null, domain: null });
  });
});

/**
 * The escaping in buildLogSearchFilter is not guessable from the docs, so these
 * pin the exact shapes that were verified against the live PostgREST instance
 * on 2026-08-04 by comparing row counts:
 *
 *   or=(event.ilike.*ai_flow_run_failed*)          -> 28 rows, but `_` is a
 *                                                     WILDCARD, so the pattern
 *                                                     `ai_flow_run_faile_` also
 *                                                     returned all 28.
 *   or=(event.ilike."*ai\_flow\_run\_faile\_*")    -> 28 rows. Wrong: inside a
 *                                                     quoted value PostgREST
 *                                                     eats one backslash, so the
 *                                                     escape vanished silently.
 *   or=(event.ilike."*ai\\_flow\\_run\\_faile\\_*") -> 0 rows. Correct: the
 *                                                     escape survived and `_`
 *                                                     matched literally.
 *
 * If someone "simplifies" the double backslash away, these go red instead of
 * the search quietly going back to over-matching.
 */
describe("buildLogSearchFilter", () => {
  it("returns null for an empty or whitespace-only search", () => {
    expect(buildLogSearchFilter("")).toBeNull();
    expect(buildLogSearchFilter("   ")).toBeNull();
    expect(quoteLogLikeTerm("")).toBeNull();
    expect(buildLogEventFilter("   ")).toBeNull();
  });

  it("leaves an ordinary term alone apart from quoting", () => {
    expect(buildLogSearchFilter("telnyx")).toBe(
      'event.ilike."%telnyx%",message.ilike."%telnyx%"'
    );
  });

  it("trims the search term", () => {
    expect(buildLogSearchFilter("  telnyx  ")).toBe(
      'event.ilike."%telnyx%",message.ilike."%telnyx%"'
    );
  });

  it("escapes underscores with a DOUBLE backslash so the escape survives quoting", () => {
    expect(buildLogSearchFilter("ai_flow_run_failed")).toBe(
      String.raw`event.ilike."%ai\\_flow\\_run\\_failed%",message.ilike."%ai\\_flow\\_run\\_failed%"`
    );
  });

  it("escapes percent signs the same way", () => {
    expect(buildLogSearchFilter("100%")).toBe(
      String.raw`event.ilike."%100\\%%",message.ilike."%100\\%%"`
    );
  });

  it("quotes the value so commas and parens cannot break the logic tree", () => {
    // Unquoted, this exact input made PostgREST reject the whole request with
    // PGRST100 rather than just narrowing the search.
    const out = buildLogSearchFilter("a,b()");
    expect(out).toBe('event.ilike."%a,b()%",message.ilike."%a,b()%"');
    expect(out?.startsWith('event.ilike."')).toBe(true);
  });

  it("escapes a literal backslash", () => {
    expect(buildLogSearchFilter("a\\b")).toBe(
      String.raw`event.ilike."%a\\\\b%",message.ilike."%a\\\\b%"`
    );
  });

  it("escapes a double quote so it cannot close the quoted value early", () => {
    expect(buildLogSearchFilter('say "hi"')).toBe(
      String.raw`event.ilike."%say \"hi\"%",message.ilike."%say \"hi\"%"`
    );
  });

  it("keeps searching when the term is nothing but reserved characters", () => {
    // The old sanitizer deleted all five and produced an empty term.
    expect(buildLogSearchFilter("%_,()")).not.toBeNull();
  });

  it("buildLogEventFilter is the event-only arm of the same quoting", () => {
    expect(buildLogEventFilter("email_delivery_failed")).toBe(
      String.raw`event.ilike."%email\\_delivery\\_failed%"`
    );
  });
});

  /**
   * The fleet dashboard reads level='error' only, so `error` is a claim that a
   * human should look. A per-minute poll that fails once has already been
   * retried by the time anyone reads it (2026-08-08: one Gmail 400, then 2,880
   * clean runs). These pin which failures earn that claim.
   */
  describe("recordFailure escalation", () => {
    // This block sits outside the suite that owns the shared reset, so it
    // clears its own mocks; without it the call counts below carry over from
    // every earlier test in the file.
    beforeEach(() => vi.clearAllMocks());

    it("logs the first failure in the window as warn, keeping it off the fleet feed", async () => {
      const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const level = await recordFailure({
        businessId: "biz-1",
        source: "email",
        event: "email_coworker_poll_failed",
        message: "400"
      });
      expect(level).toBe("warn");
      expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ level: "warn" }));
    });

    it("escalates to error once another failure is already in the window", async () => {
      const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [MOCK_ROW], error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const level = await recordFailure({
        businessId: "biz-1",
        source: "email",
        event: "email_coworker_poll_failed",
        message: "400 again"
      });
      expect(level).toBe("error");
      expect(db.insert).toHaveBeenCalledWith(expect.objectContaining({ level: "error" }));
    });

    it("scopes the history to this business and this event", async () => {
      const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await recordFailure({ businessId: "biz-1", source: "email", event: "poll_failed" });
      expect(db.eq).toHaveBeenCalledWith("event", "poll_failed");
      expect(db.eq).toHaveBeenCalledWith("business_id", "biz-1");
      expect(db.in).toHaveBeenCalledWith("level", ["warn", "error"]);
      expect(db.is).not.toHaveBeenCalled();
    });

    // A platform-wide event has no tenant, and eq(null) does not match null in
    // PostgREST, so it would silently find no history and never escalate.
    it("matches platform-wide history with is-null, not eq-null", async () => {
      const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      await recordFailure({ source: "cron", event: "sweep_failed" });
      expect(db.is).toHaveBeenCalledWith("business_id", null);
      expect(db.eq).not.toHaveBeenCalledWith("business_id", expect.anything());
    });

    it("escalates when the history cannot be read, rather than going quiet", async () => {
      const db = mockDb({
        limit: vi.fn().mockResolvedValue({ data: null, error: { message: "db down" } })
      });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      const level = await recordFailure({ businessId: "b", source: "email", event: "e" });
      expect(level).toBe("error");
    });

    // PostgREST returns data:null for an empty result on some client versions,
    // which must read as "no prior failure", not as an unreadable history.
    it("treats a null result with no error as no prior failure", async () => {
      const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: null, error: null }) });
      vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
      expect(await recordFailure({ businessId: "b", source: "email", event: "e" })).toBe("warn");
    });

    it("escalates on a non-Error rejection too", async () => {
      vi.mocked(createSupabaseServiceClient).mockRejectedValue("string boom" as never);
      expect(await recordFailure({ businessId: "b", source: "email", event: "e" })).toBe("error");
    });

    it("escalates when the client itself cannot be built", async () => {
      vi.mocked(createSupabaseServiceClient).mockRejectedValue(new Error("no client") as never);
      const level = await recordFailure({ businessId: "b", source: "email", event: "e" });
      expect(level).toBe("error");
    });

    it("honours an explicit window and an injected client", async () => {
      const db = mockDb({ limit: vi.fn().mockResolvedValue({ data: [], error: null }) });
      const level = await recordFailure(
        { businessId: "b", source: "email", event: "e" },
        { windowMinutes: 60 },
        db as never
      );
      expect(level).toBe("warn");
      expect(createSupabaseServiceClient).not.toHaveBeenCalled();
      expect(db.gte).toHaveBeenCalledWith("created_at", expect.any(String));
    });
  });

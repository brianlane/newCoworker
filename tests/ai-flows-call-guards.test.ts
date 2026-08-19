import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_DIAL_WINDOW_HOURS,
  DEFAULT_MAX_DIALS_PER_LEAD,
  callDialGuard
} from "../supabase/functions/_shared/ai_flows/call_guards";
import { CALL_REASON } from "../supabase/functions/_shared/ai_flows/call_outcome_meta";

const NOW = Date.parse("2026-08-06T17:00:00.000Z");
const LEAD = "+16025550123";
const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

/**
 * A stand-in for the parts of the Supabase client this module touches: the
 * `sms_is_opted_out` RPC and one counting query against
 * voice_outbound_dial_log. The query builder records the filters it was given
 * so the tests can assert the cap asks the RIGHT question, not just that it
 * returns a number.
 */
function fakeClient(opts: {
  optedOut?: boolean;
  rpcError?: string;
  count?: number | null;
  countError?: string;
  countThrows?: boolean;
}) {
  const filters: Record<string, unknown> = {};
  const client = {
    rpc: (fn: string, args: Record<string, unknown>) => {
      filters.rpcFn = fn;
      filters.rpcArgs = args;
      return Promise.resolve(
        opts.rpcError
          ? { data: null, error: { message: opts.rpcError } }
          : { data: opts.optedOut === true, error: null }
      );
    },
    from: (table: string) => {
      filters.table = table;
      if (opts.countThrows) {
        throw new Error("connection reset");
      }
      const builder = {
        select: (columns: string, o?: Record<string, unknown>) => {
          filters.select = { columns, ...o };
          return builder;
        },
        eq: (column: string, value: unknown) => {
          filters[`eq_${column}`] = value;
          return builder;
        },
        in: (column: string, values: readonly string[]) => {
          filters[`in_${column}`] = [...values];
          return builder;
        },
        gte: (column: string, value: string) => {
          filters[`gte_${column}`] = value;
          return Promise.resolve(
            opts.countError
              ? { count: null, error: { message: opts.countError } }
              // `count` is passed through EXACTLY as given, including null.
              // Collapsing null to 0 here would hide the null-count branch
              // from the very test written to cover it.
              : { count: opts.count === undefined ? 0 : opts.count, error: null }
          );
        }
      };
      return builder;
    }
  };
  return { client, filters };
}

describe("callDialGuard: consent", () => {
  it("allows a number nobody has opted out", async () => {
    const { client } = fakeClient({ optedOut: false });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: true });
  });

  // The gap this module was written to close: the opt-out check was wired
  // into send_sms only, so a lead who texted STOP could still be CALLED.
  it("refuses a lead who has opted out", async () => {
    const { client, filters } = fakeClient({ optedOut: true });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: false, reason: CALL_REASON.OPTED_OUT });
    expect(filters.rpcFn).toBe("sms_is_opted_out");
    expect(filters.rpcArgs).toEqual({ p_business_id: BIZ, p_sender_e164: LEAD });
  });

  // Fail CLOSED. A consent question that cannot be answered must surface as a
  // retryable failure, never as "go ahead and dial".
  it("throws rather than dialing when the opt-out lookup errors", async () => {
    const { client } = fakeClient({ rpcError: "boom" });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).rejects.toThrow(/sms_is_opted_out/);
  });

  // The planner already resolves a missing number to a clearer reason, so
  // this module declines to spend an RPC on it.
  it("passes an empty number straight through without an RPC", async () => {
    const { client, filters } = fakeClient({ optedOut: true });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: "   ", nowMs: NOW })
    ).resolves.toEqual({ allowed: true });
    expect(filters.rpcFn).toBeUndefined();
  });
});

describe("callDialGuard: per-lead dial cap", () => {
  it("asks only about this business, this number, and this window", async () => {
    const { client, filters } = fakeClient({ count: 0 });
    await callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW });
    expect(filters.table).toBe("voice_outbound_dial_log");
    expect(filters.select).toEqual({ columns: "id", count: "exact", head: true });
    expect(filters.eq_business_id).toBe(BIZ);
    expect(filters.eq_to_e164).toBe(LEAD);
    // A blocked dial never rang anyone, so it must not count toward the cap.
    expect(filters.in_status).toEqual(["placed", "failed"]);
    expect(filters.gte_created_at).toBe(
      new Date(NOW - DEFAULT_DIAL_WINDOW_HOURS * 3_600_000).toISOString()
    );
  });

  it("allows below the cap and refuses at it", async () => {
    const under = fakeClient({ count: DEFAULT_MAX_DIALS_PER_LEAD - 1 });
    await expect(
      callDialGuard(under.client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: true });

    const at = fakeClient({ count: DEFAULT_MAX_DIALS_PER_LEAD });
    await expect(
      callDialGuard(at.client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: false, reason: CALL_REASON.DIAL_CAP });

    const over = fakeClient({ count: DEFAULT_MAX_DIALS_PER_LEAD + 5 });
    await expect(
      callDialGuard(over.client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: false, reason: CALL_REASON.DIAL_CAP });
  });

  it("honors an explicit cap and window", async () => {
    const { client, filters } = fakeClient({ count: 2 });
    await expect(
      callDialGuard(client, {
        businessId: BIZ,
        toE164: LEAD,
        nowMs: NOW,
        maxDials: 2,
        windowHours: 6
      })
    ).resolves.toEqual({ allowed: false, reason: CALL_REASON.DIAL_CAP });
    expect(filters.gte_created_at).toBe(new Date(NOW - 6 * 3_600_000).toISOString());
  });

  // A misconfigured cap should degrade to the previous behavior, not silence
  // a tenant's outbound calling entirely.
  it("treats a non-positive cap as disabled", async () => {
    const { client, filters } = fakeClient({ count: 99 });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW, maxDials: 0 })
    ).resolves.toEqual({ allowed: true });
    expect(filters.table).toBeUndefined();
  });

  // The one deliberate fail-OPEN: the cap guards against duplicate
  // automation, not consent, so a broken count must not take out the feature.
  it("allows the call when the count query errors", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ countError: "timeout" });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("allows the call when the count query throws", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fakeClient({ countThrows: true });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: true });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  // A head+count query returns no rows, so a null count means "none", not
  // "unknown", and must not read as an error.
  it("reads a null count as zero", async () => {
    const { client } = fakeClient({ count: null });
    await expect(
      callDialGuard(client, { businessId: BIZ, toE164: LEAD, nowMs: NOW })
    ).resolves.toEqual({ allowed: true });
  });
});

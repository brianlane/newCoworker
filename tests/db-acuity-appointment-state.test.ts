/**
 * Tests for the Acuity observation shadow
 * (src/lib/db/acuity-appointment-state.ts).
 *
 * This table exists because Acuity exposes no last-modified timestamp, so
 * `CalendarEventInput.updatedIso`, which `eventCanceledDue` gates on, has
 * no provider source. We synthesize it from our own first sighting.
 *
 * The property that matters most, and the one that is easy to get wrong, is
 * STABILITY: every later poll must re-emit the STORED timestamp, never
 * `now()`. Re-stamping would keep pushing the change forward in time, so a
 * cancellation would sit permanently inside the lookback window and refire
 * every tick instead of aging out.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loggerWarn = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: (...a: unknown[]) => loggerWarn(...a), error: vi.fn() }
}));

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  ACUITY_STATE_RETENTION_DAYS,
  readAcuityAppointmentState,
  recordAcuityObservations,
  sweepAcuityAppointmentState
} from "@/lib/db/acuity-appointment-state";

const BIZ = "11111111-1111-4111-8111-111111111111";
const OBSERVED = "2026-08-04T12:00:00.000Z";
const EARLIER = "2026-08-01T09:00:00.000Z";

type Chain = {
  select: ReturnType<typeof vi.fn>;
  upsert: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  in: ReturnType<typeof vi.fn>;
  lt: ReturnType<typeof vi.fn>;
};

/** `selectResult` resolves the select chain; `terminal` the delete/upsert. */
function chain(selectResult: unknown, terminal: unknown = { error: null }) {
  const c: Record<string, unknown> = {};
  const self = () => c;
  c.select = vi.fn(self);
  c.upsert = vi.fn(() => Promise.resolve(terminal));
  c.delete = vi.fn(self);
  c.eq = vi.fn(self);
  c.lt = vi.fn(() => Promise.resolve(terminal));
  c.in = vi.fn(() => Promise.resolve(selectResult));
  c.then = (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve);
  return c as unknown as Chain & PromiseLike<unknown>;
}

function makeDb(c: unknown) {
  return { from: vi.fn(() => c) } as never;
}

function stored(overrides: Record<string, unknown> = {}) {
  return {
    business_id: BIZ,
    appointment_id: "500",
    start_at: "2026-08-05T17:00:00.000Z",
    canceled: false,
    first_seen_canceled_at: null,
    start_changed_at: null,
    ...overrides
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("readAcuityAppointmentState", () => {
  it("short-circuits on an empty id list without querying", async () => {
    const c = chain({ data: [], error: null });
    await expect(readAcuityAppointmentState(BIZ, [], makeDb(c))).resolves.toEqual(new Map());
    expect(c.select).not.toHaveBeenCalled();
  });

  it("keys the rows by appointment id", async () => {
    const c = chain({ data: [stored()], error: null });
    const out = await readAcuityAppointmentState(BIZ, ["500"], makeDb(c));
    expect(out.get("500")).toMatchObject({ appointment_id: "500", canceled: false });
  });

  it("tolerates a null data payload", async () => {
    const c = chain({ data: null, error: null });
    await expect(readAcuityAppointmentState(BIZ, ["500"], makeDb(c))).resolves.toEqual(new Map());
  });

  it("surfaces read errors", async () => {
    const c = chain({ data: null, error: { message: "boom" } });
    await expect(readAcuityAppointmentState(BIZ, ["500"], makeDb(c))).rejects.toThrow(
      /readAcuityAppointmentState: boom/
    );
  });
});

describe("recordAcuityObservations", () => {
  it("returns nothing for no observations", async () => {
    await expect(recordAcuityObservations(BIZ, [], OBSERVED)).resolves.toEqual([]);
    expect(defaultClientSpy).not.toHaveBeenCalled();
  });

  it("reports a first sighting as new, leaving updatedIso to dateCreated", async () => {
    const c = chain({ data: [], error: null });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: false }],
      OBSERVED,
      makeDb(c)
    );
    // A brand new appointment has no modification moment; event_created gates
    // on the appointment's own dateCreated instead.
    expect(out).toEqual([{ appointmentId: "500", kind: "new", updatedIso: null }]);
    expect(c.upsert).toHaveBeenCalled();
  });

  it("stamps a first sighting that is ALREADY canceled", async () => {
    const c = chain({ data: [], error: null });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: true }],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([{ appointmentId: "500", kind: "canceled", updatedIso: OBSERVED }]);
    expect((c.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0][0]).toMatchObject({
      canceled: true,
      first_seen_canceled_at: OBSERVED
    });
  });

  it("stamps the moment an appointment FIRST flips to canceled", async () => {
    const c = chain({ data: [stored()], error: null });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: true }],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([{ appointmentId: "500", kind: "canceled", updatedIso: OBSERVED }]);
  });

  it("RE-EMITS the stored timestamp on later polls, never a fresh now()", async () => {
    // The load-bearing property. Re-stamping would keep the cancellation
    // permanently inside eventCanceledDue's lookback, refiring every tick
    // instead of aging out.
    const c = chain({
      data: [stored({ canceled: true, first_seen_canceled_at: EARLIER })],
      error: null
    });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: true }],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([{ appointmentId: "500", kind: "unchanged", updatedIso: EARLIER }]);
    // Nothing to write: the row already says what we just saw.
    expect(c.upsert).not.toHaveBeenCalled();
  });

  it("detects a reschedule Acuity's API cannot express, and stamps it", async () => {
    const c = chain({ data: [stored()], error: null });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-06T19:00:00.000Z", canceled: false }],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([{ appointmentId: "500", kind: "moved", updatedIso: OBSERVED }]);
    expect((c.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0][0]).toMatchObject({
      start_at: "2026-08-06T19:00:00.000Z",
      start_changed_at: OBSERVED
    });
  });

  it("re-emits a stored move timestamp when nothing changed since", async () => {
    const c = chain({
      data: [stored({ start_changed_at: EARLIER })],
      error: null
    });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: false }],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([{ appointmentId: "500", kind: "unchanged", updatedIso: EARLIER }]);
    expect(c.upsert).not.toHaveBeenCalled();
  });

  it("handles a mixed batch in one pass", async () => {
    const c = chain({
      data: [stored({ appointment_id: "known" })],
      error: null
    });
    const out = await recordAcuityObservations(
      BIZ,
      [
        { appointmentId: "known", startIso: "2026-08-05T17:00:00.000Z", canceled: true },
        { appointmentId: "fresh", startIso: "2026-08-07T17:00:00.000Z", canceled: false }
      ],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([
      { appointmentId: "known", kind: "canceled", updatedIso: OBSERVED },
      { appointmentId: "fresh", kind: "new", updatedIso: null }
    ]);
  });

  it("still reports correct transitions when the write fails", async () => {
    // Losing a flow run is worse than a duplicate one the cal: dedupe keys
    // absorb, so persistence is best-effort and never throws.
    const c = chain({ data: [], error: null }, { error: { message: "write boom" } });
    const out = await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: true }],
      OBSERVED,
      makeDb(c)
    );
    expect(out).toEqual([{ appointmentId: "500", kind: "canceled", updatedIso: OBSERVED }]);
    expect(loggerWarn).toHaveBeenCalledWith(
      "acuity state: persist failed",
      expect.objectContaining({ businessId: BIZ })
    );
  });

  it("does not write at all when nothing changed", async () => {
    const c = chain({ data: [stored()], error: null });
    await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: false }],
      OBSERVED,
      makeDb(c)
    );
    expect(c.upsert).not.toHaveBeenCalled();
  });

  it("logs a non-Error write rejection without throwing", async () => {
    const c = chain({ data: [], error: null });
    (c.upsert as ReturnType<typeof vi.fn>).mockRejectedValue("write exploded");
    await expect(
      recordAcuityObservations(
        BIZ,
        [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: true }],
        OBSERVED,
        makeDb(c)
      )
    ).resolves.toHaveLength(1);
    expect(loggerWarn).toHaveBeenCalledWith(
      "acuity state: persist failed",
      expect.objectContaining({ error: "write exploded" })
    );
  });
});

describe("sweepAcuityAppointmentState", () => {
  it("deletes rows whose appointment started past the retention window", async () => {
    const c = chain({ data: [], error: null });
    const nowMs = Date.parse(OBSERVED);
    await sweepAcuityAppointmentState(BIZ, nowMs, makeDb(c));
    expect(c.delete).toHaveBeenCalled();
    const cutoff = (c.lt as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(Date.parse(cutoff)).toBe(nowMs - ACUITY_STATE_RETENTION_DAYS * 86_400_000);
  });

  it("surfaces sweep errors", async () => {
    const c = chain({ data: [], error: null }, { error: { message: "sweep boom" } });
    await expect(sweepAcuityAppointmentState(BIZ, Date.now(), makeDb(c))).rejects.toThrow(
      /sweepAcuityAppointmentState: sweep boom/
    );
  });
});

describe("default client", () => {
  it("falls back to the service client", async () => {
    const c = chain({ data: [], error: null });
    defaultClientSpy.mockReturnValue(makeDb(c));
    await readAcuityAppointmentState(BIZ, ["500"]);
    await sweepAcuityAppointmentState(BIZ, Date.now());
    // Also covers the write path's own fallback, which resolves the client
    // separately from the read.
    await recordAcuityObservations(
      BIZ,
      [{ appointmentId: "500", startIso: "2026-08-05T17:00:00.000Z", canceled: true }],
      OBSERVED
    );
    expect(defaultClientSpy).toHaveBeenCalledTimes(4);
  });
});

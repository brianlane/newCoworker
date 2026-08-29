import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * schedule_text: the texting coworker's only way to send a text at a future
 * time (src/lib/sms/schedule-text.ts).
 *
 * The incident: R V (KYP Ads, 2026-08-28) asked for a reminder 30 minutes
 * before his Monday strategy call and was told "I'll make sure you get a
 * reminder text at 6:30 PM Eastern". Nothing was queued, because the SMS
 * coworker had no tool that could. The dashboard has had scheduled sends
 * since the tier relaunch; this tool hands the same queue to the agent,
 * under four hard limits that the dashboard does not need:
 *
 *   1. it can only ever text the person in the conversation;
 *   2. it holds exactly ONE queued text per contact (a second schedule
 *      MOVES the first, it never stacks);
 *   3. it refuses once, with the lead time, when an automatic pre-call
 *      reminder flow already covers this tenant, so the model asks before
 *      adding a second reminder text;
 *   4. it pins what it queued onto the contact, so a later turn (a
 *      reschedule, a cancel) can see the promise and move it.
 */

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/plans/sms-tools", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/plans/sms-tools")>();
  return { ...original, smsToolsAllowedForBusiness: vi.fn() };
});
vi.mock("@/lib/sms/opt-outs", () => ({ checkSmsOptOut: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusinessTimezone: vi.fn() }));
vi.mock("@/lib/customer-tools/handlers", () => ({ appendCustomerPinnedNote: vi.fn() }));
// Node's local ICU often emits a PLAIN space where production ICU emits
// U+202F, so the real formatter cannot reproduce the bug here. Inject it.
vi.mock("@/lib/calendar-tools/handlers", () => ({ formatBookingStartLocal: vi.fn() }));

import { scheduleTextArgsSchema, scheduleTextTool } from "@/lib/sms/schedule-text";
import { SCHEDULED_SMS_MIN_LEAD_MS } from "@/lib/plans/sms-tools";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { smsToolsAllowedForBusiness } from "@/lib/plans/sms-tools";
import { checkSmsOptOut } from "@/lib/sms/opt-outs";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { appendCustomerPinnedNote } from "@/lib/customer-tools/handlers";
import { formatBookingStartLocal } from "@/lib/calendar-tools/handlers";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TEXTER = "+14168982100";
/** Friday 2026-08-28 12:00 UTC, so "Monday 6:30 PM Eastern" is 3 days out. */
const NOW = Date.parse("2026-08-28T12:00:00.000Z");
const MONDAY_630_ET = "2026-08-31T18:30:00-04:00";

type ChainResult = { data: unknown; error: { message: string } | null };
const EMPTY: ChainResult = { data: null, error: null };

type TableSpec = { select?: ChainResult; insert?: ChainResult; update?: ChainResult };

/**
 * One table's chainable builder. The terminal result depends on which write
 * verb (if any) opened the chain, so a single spec covers the three shapes
 * this module uses on `scheduled_sms`: list pending, cancel one, insert one.
 */
function tableChain(spec: TableSpec, calls: Record<string, unknown[]>) {
  let op: keyof TableSpec = "select";
  const chain: Record<string, unknown> = {};
  for (const m of ["eq", "neq", "is", "order", "limit"]) {
    chain[m] = vi.fn().mockReturnValue(chain);
  }
  chain.select = vi.fn().mockReturnValue(chain);
  chain.insert = vi.fn((values: unknown) => {
    op = "insert";
    calls.insert.push(values);
    return chain;
  });
  chain.update = vi.fn((values: unknown) => {
    op = "update";
    calls.update.push(values);
    return chain;
  });
  const settle = () => Promise.resolve(spec[op] ?? EMPTY);
  chain.single = vi.fn(settle);
  chain.maybeSingle = vi.fn(settle);
  chain.then = (resolve: (v: ChainResult) => unknown) => settle().then(resolve);
  return chain;
}

let calls: Record<string, unknown[]>;

function mockDb(tables: Record<string, TableSpec>) {
  calls = { insert: [], update: [] };
  const from = vi.fn((table: string) => tableChain(tables[table] ?? {}, calls));
  vi.mocked(createSupabaseServiceClient).mockResolvedValue({
    from
  } as unknown as Awaited<ReturnType<typeof createSupabaseServiceClient>>);
  return from;
}

/** An enabled calendar flow that already texts a reminder 60 minutes out. */
function precallReminderFlow(leadMinutes = 60) {
  return {
    name: "Pre-call reminder (1hr before)",
    enabled: true,
    definition: {
      trigger: { channel: "calendar", on: "event_start", leadMinutes },
      steps: [{ id: "s1", type: "send_sms", to: "{{vars.invitee_phone}}", body: "hi" }]
    }
  };
}

/** The no-automatic-reminder tenant: flows exist, none is an event_start. */
function unrelatedFlow() {
  return {
    name: "Lead follow-up",
    enabled: true,
    definition: { trigger: { channel: "webhook" }, steps: [] }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: true, optedOut: false });
  vi.mocked(getBusinessTimezone).mockResolvedValue("America/Toronto");
  vi.mocked(appendCustomerPinnedNote).mockResolvedValue({ ok: true, data: {} } as never);
  // Production ICU shape: a NARROW NO-BREAK SPACE before PM.
  vi.mocked(formatBookingStartLocal).mockImplementation(
    (iso: string, timeZone: string) =>
      `Monday, August 31, 2026 at ${iso.includes("22:00") ? "6:00" : "6:30"}\u202fPM ` +
      (timeZone === "UTC" ? "UTC" : "EDT")
  );
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scheduleTextArgsSchema", () => {
  it("requires an E.164 phone (the model must pass the current texter)", () => {
    expect(scheduleTextArgsSchema.safeParse({ phone: "416-898-2100" }).success).toBe(false);
    expect(
      scheduleTextArgsSchema.safeParse({
        phone: TEXTER,
        sendAtIso: MONDAY_630_ET,
        text: "Reminder: your call is in 30 minutes."
      }).success
    ).toBe(true);
  });

  it("defaults the action to schedule", () => {
    const parsed = scheduleTextArgsSchema.parse({ phone: TEXTER });
    expect(parsed.action).toBe("schedule");
  });

  it("accepts cancel", () => {
    expect(scheduleTextArgsSchema.parse({ phone: TEXTER, action: "cancel" }).action).toBe("cancel");
  });
});

describe("plan gate", () => {
  it("refuses on a Starter tenant and tells the model to decline, not promise", async () => {
    vi.mocked(smsToolsAllowedForBusiness).mockResolvedValue(false);
    mockDb({});
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("tier_not_allowed");
    expect(result.message).toMatch(/cannot/i);
    expect(calls.insert).toHaveLength(0);
  });
});

describe("scheduling", () => {
  it("queues the text, binds it to the texter, and pins it to the contact", async () => {
    mockDb({
      ai_flows: { select: { data: [unrelatedFlow()], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1", send_at: "2026-08-31T22:30:00.000Z" }, error: null }
      }
    });

    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder: your call with James is in 30 minutes."
    });

    expect(result.ok).toBe(true);
    expect(calls.insert).toHaveLength(1);
    expect(calls.insert[0]).toMatchObject({
      business_id: BIZ,
      to_e164: TEXTER,
      body: "Reminder: your call with James is in 30 minutes.",
      send_at: new Date(MONDAY_630_ET).toISOString(),
      // Stamped so this tool can never see, move, or cancel a text the
      // OWNER queued from the dashboard composer to the same number.
      created_by: "sms_coworker"
    });
    // The confirmable label the model is told to quote back, in the
    // business timezone with the zone named (SMS_TIMEZONE_LINE).
    const data = result.data as { sendAtLocal: string };
    expect(data.sendAtLocal).toMatch(/Monday/);
    expect(data.sendAtLocal).toMatch(/6:30/);
    expect(data.sendAtLocal).toMatch(/EDT/);
    // Pinned so a later turn (a reschedule) can see the standing promise.
    expect(appendCustomerPinnedNote).toHaveBeenCalledWith(
      BIZ,
      TEXTER,
      expect.stringContaining("6:30"),
      "sms",
      "text"
    );
  });

  it("truncates a long body in the pinned note (pinned notes have a cap)", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    const long = "R".repeat(400);
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: long
    });
    expect(result.ok).toBe(true);
    // The QUEUED body is untouched; only the note is shortened.
    expect(calls.insert[0]).toMatchObject({ body: long });
    const note = vi.mocked(appendCustomerPinnedNote).mock.calls[0][2];
    expect(note).toContain("...");
    expect(note.length).toBeLessThan(long.length);
  });

  it("falls back to UTC when the business has no timezone", async () => {
    vi.mocked(getBusinessTimezone).mockResolvedValue(null);
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.ok).toBe(true);
    expect((result.data as { sendAtLocal: string }).sendAtLocal).toMatch(/UTC/);
  });

  it("MOVES the one queued text instead of stacking a second", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: {
          data: [{ id: "old-1", send_at: "2026-08-31T22:00:00.000Z", body: "older" }],
          error: null
        },
        update: { data: [{ id: "old-1" }], error: null },
        insert: { data: { id: "sched-2" }, error: null }
      }
    });

    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });

    expect(result.ok).toBe(true);
    expect(calls.update[0]).toMatchObject({ status: "canceled" });
    expect(calls.insert).toHaveLength(1);
    const data = result.data as { replacedSendAtLocal?: string };
    expect(data.replacedSendAtLocal).toMatch(/6:00/);
  });

  it("refuses once when an automatic pre-call reminder already covers the tenant", async () => {
    mockDb({
      ai_flows: { select: { data: [unrelatedFlow(), precallReminderFlow(60)], error: null } },
      scheduled_sms: { select: { data: [], error: null } }
    });

    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("automatic_reminder_exists");
    expect((result.data as { leadMinutes: number }).leadMinutes).toBe(60);
    expect(result.message).toMatch(/confirmed/);
    expect(calls.insert).toHaveLength(0);
  });

  it("queues anyway once the texter has confirmed they want both", async () => {
    mockDb({
      ai_flows: { select: { data: [precallReminderFlow(60)], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });

    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder",
      confirmed: true
    });

    expect(result.ok).toBe(true);
    expect(calls.insert).toHaveLength(1);
  });

  it("ignores disabled and zero-lead calendar flows when looking for a reminder", async () => {
    mockDb({
      ai_flows: { select: { data: [precallReminderFlow(0)], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.ok).toBe(true);
  });

  it("treats an unreadable flow list as no automatic reminder", async () => {
    mockDb({
      ai_flows: { select: { data: null, error: { message: "boom" } } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.ok).toBe(true);
  });
});

describe("what the owner queued is not the agent's to move (Bugbot, high)", () => {
  it("scopes its one pending row to rows it created", async () => {
    const from = mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    // The lookup must carry created_by; without it an owner-composed send to
    // the same number is "the one pending row" and gets overwritten.
    const chain = from.mock.results.find((r) => r.type === "return")?.value as Record<
      string,
      { mock: { calls: unknown[][] } }
    >;
    const eqArgs = chain.eq.mock.calls;
    expect(eqArgs).toContainEqual(["created_by", "sms_coworker"]);
  });
});

describe("a failed move never drops the standing reminder (Bugbot, high)", () => {
  it("inserts before retiring the old row, so a failed insert keeps the original", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: {
          data: [{ id: "old-1", send_at: "2026-08-31T22:00:00.000Z", body: "older" }],
          error: null
        },
        insert: { data: null, error: { message: "constraint" } }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.detail).toBe("queue_failed");
    // Nothing was cancelled: the 6:00 reminder they already had still stands.
    expect(calls.update).toHaveLength(0);
  });

  it("retires the new row and says so when the old one will not cancel", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: {
          data: [{ id: "old-1", send_at: "2026-08-31T22:00:00.000Z", body: "older" }],
          error: null
        },
        insert: { data: { id: "new-1" }, error: null },
        // Zero rows matched: the cancel did not land.
        update: { data: [], error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("move_failed");
    // Both the old cancel attempt and the compensating one for the new row.
    expect(calls.update).toHaveLength(2);
    expect(result.message).toMatch(/still stands/);
  });
});

describe("moving an already-confirmed reminder (Bugbot, medium)", () => {
  it("does not re-ask about the automatic reminder when one is already queued", async () => {
    mockDb({
      ai_flows: { select: { data: [precallReminderFlow(60)], error: null } },
      scheduled_sms: {
        select: {
          data: [{ id: "old-1", send_at: "2026-08-31T22:30:00.000Z", body: "older" }],
          error: null
        },
        insert: { data: { id: "new-1" }, error: null },
        update: { data: [{ id: "old-1" }], error: null }
      }
    });
    // No `confirmed` flag: they confirmed when the first one was queued.
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect(result.ok).toBe(true);
    expect(calls.insert).toHaveLength(1);
  });
});

describe("the send time must carry its offset (Bugbot, medium)", () => {
  it("refuses a naive local time rather than reading it as the server clock", async () => {
    mockDb({});
    for (const naive of ["2026-08-31T18:30:00", "2026-08-31 18:30", "2026-08-31T18:30:00.000"]) {
      const result = await scheduleTextTool(BIZ, {
        phone: TEXTER,
        action: "schedule",
        sendAtIso: naive,
        text: "Reminder"
      });
      expect(result.detail, naive).toBe("invalid_time");
    }
    expect(calls.insert).toHaveLength(0);
  });

  it("accepts Z and both offset spellings", async () => {
    for (const iso of [
      "2026-08-31T22:30:00Z",
      "2026-08-31T18:30:00-04:00",
      "2026-08-31T18:30:00-0400"
    ]) {
      mockDb({
        ai_flows: { select: { data: [], error: null } },
        scheduled_sms: {
          select: { data: [], error: null },
          insert: { data: { id: "sched-1" }, error: null }
        }
      });
      expect((await scheduleTextTool(BIZ, {
        phone: TEXTER,
        action: "schedule",
        sendAtIso: iso,
        text: "Reminder"
      })).ok, iso).toBe(true);
    }
  });
});

describe("the quoted time label must not blow the SMS segment budget", () => {
  it("strips the narrow no-break space Intl hides before PM", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    const label = (result.data as { sendAtLocal: string }).sendAtLocal;
    // The model is told to quote this VERBATIM into a text. One character
    // outside GSM-7 re-encodes the whole message as UCS-2, cutting the
    // segment budget from 153 to 67 with nothing visibly different.
    expect(label).not.toMatch(/[\u202f\u00a0]/);
    expect(label).toContain("6:30 PM EDT");
    // Stronger than the two-character check above: anything non-ASCII at all
    // would force the same re-encode.
    expect(label).toMatch(/^[ -~]*$/);
  });

  it("strips it from the pinned note and the replaced-time label too", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: {
          data: [{ id: "old-1", send_at: "2026-08-31T22:00:00.000Z", body: "older" }],
          error: null
        },
        insert: { data: { id: "new-1" }, error: null },
        update: { data: [{ id: "old-1" }], error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder"
    });
    expect((result.data as { replacedSendAtLocal: string }).replacedSendAtLocal).not.toMatch(
      /[\u202f\u00a0]/
    );
    const note = vi.mocked(appendCustomerPinnedNote).mock.calls[0][2];
    expect(note).not.toMatch(/[\u202f\u00a0]/);
  });
});

describe("refusals that must not become a promise", () => {
  async function schedule(over: Record<string, unknown> = {}) {
    return scheduleTextTool(BIZ, {
      phone: TEXTER,
      action: "schedule",
      sendAtIso: MONDAY_630_ET,
      text: "Reminder",
      ...over
    } as Parameters<typeof scheduleTextTool>[1]);
  }

  it("needs both a time and a body", async () => {
    mockDb({});
    expect((await schedule({ sendAtIso: undefined })).detail).toBe("invalid_args");
    expect((await schedule({ text: undefined })).detail).toBe("invalid_args");
    expect((await schedule({ text: "   " })).detail).toBe("invalid_args");
  });

  it("rejects an unparseable time", async () => {
    mockDb({});
    expect((await schedule({ sendAtIso: "monday evening" })).detail).toBe("invalid_time");
  });

  it("rejects a time inside the sweep's own cadence", async () => {
    mockDb({});
    const tooSoon = new Date(NOW + SCHEDULED_SMS_MIN_LEAD_MS - 1000).toISOString();
    expect((await schedule({ sendAtIso: tooSoon })).detail).toBe("too_soon");
  });

  it("rejects a time past the queue's horizon", async () => {
    mockDb({});
    const tooFar = new Date(NOW + 91 * 24 * 60 * 60 * 1000).toISOString();
    expect((await schedule({ sendAtIso: tooFar })).detail).toBe("too_far");
  });

  it("refuses for an opted-out contact", async () => {
    vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: true, optedOut: true });
    mockDb({});
    const result = await schedule();
    expect(result.detail).toBe("opted_out");
    expect(calls.insert).toHaveLength(0);
  });

  it("fails closed when the opt-out list cannot be read", async () => {
    vi.mocked(checkSmsOptOut).mockResolvedValue({ ok: false, error: "down" });
    mockDb({});
    expect((await schedule()).detail).toBe("opt_out_unknown");
  });

  it("never claims success when the insert fails", async () => {
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: null, error: { message: "constraint" } }
      }
    });
    const result = await schedule();
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("queue_failed");
    expect(result.message).toMatch(/never say it is scheduled/i);
  });

  it("still reports success when only the pinned note fails", async () => {
    vi.mocked(appendCustomerPinnedNote).mockResolvedValue({
      ok: false,
      detail: "note_too_long"
    } as never);
    mockDb({
      ai_flows: { select: { data: [], error: null } },
      scheduled_sms: {
        select: { data: [], error: null },
        insert: { data: { id: "sched-1" }, error: null }
      }
    });
    expect((await schedule()).ok).toBe(true);
  });
});

describe("canceling", () => {
  it("cancels the queued text and pins the cancellation", async () => {
    mockDb({
      scheduled_sms: {
        select: {
          data: [{ id: "old-1", send_at: "2026-08-31T22:30:00.000Z", body: "Reminder" }],
          error: null
        },
        update: { data: [{ id: "old-1" }], error: null }
      }
    });

    const result = await scheduleTextTool(BIZ, { phone: TEXTER, action: "cancel" });

    expect(result.ok).toBe(true);
    expect(calls.update[0]).toMatchObject({ status: "canceled" });
    expect((result.data as { canceledSendAtLocal: string }).canceledSendAtLocal).toMatch(/6:30/);
    expect(appendCustomerPinnedNote).toHaveBeenCalledWith(
      BIZ,
      TEXTER,
      expect.stringContaining("Canceled"),
      "sms",
      "text"
    );
  });

  it("says plainly when there was nothing queued", async () => {
    mockDb({ scheduled_sms: { select: { data: [], error: null } } });
    const result = await scheduleTextTool(BIZ, { phone: TEXTER, action: "cancel" });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("nothing_scheduled");
    expect(calls.update).toHaveLength(0);
  });

  it("does not claim a cancel the write did not land (zero rows matched)", async () => {
    mockDb({
      scheduled_sms: {
        select: { data: [{ id: "old-1", send_at: "2026-08-31T22:30:00.000Z" }], error: null },
        update: { data: [], error: null }
      }
    });
    const result = await scheduleTextTool(BIZ, { phone: TEXTER, action: "cancel" });
    expect(result.ok).toBe(false);
    expect(result.detail).toBe("cancel_failed");
  });

  it("surfaces a cancel that errored", async () => {
    mockDb({
      scheduled_sms: {
        select: { data: [{ id: "old-1", send_at: "2026-08-31T22:30:00.000Z" }], error: null },
        update: { data: null, error: { message: "boom" } }
      }
    });
    expect((await scheduleTextTool(BIZ, { phone: TEXTER, action: "cancel" })).detail).toBe(
      "cancel_failed"
    );
  });

  it("treats an unreadable queue as nothing scheduled", async () => {
    mockDb({ scheduled_sms: { select: { data: null, error: { message: "boom" } } } });
    expect((await scheduleTextTool(BIZ, { phone: TEXTER, action: "cancel" })).detail).toBe(
      "nothing_scheduled"
    );
  });
});

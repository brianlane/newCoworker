/**
 * Meeting types: storage rules (normalization, caps, the two
 * self-contradicting states) and the inheritance resolver that decides
 * what actually applies to one booking.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));

import {
  DEFAULT_MEETING_NAME,
  DEFAULT_MEETING_SLUG,
  MAX_MEETING_TYPES,
  createMeetingType,
  ensureDefaultMeetingType,
  deleteMeetingType,
  effectiveTypeSettings,
  getEnabledMeetingType,
  listMeetingTypes,
  updateMeetingType,
  visibleMeetingTypes,
  type BookingMeetingTypeRow
} from "@/lib/booking-page/meeting-types";
import { BookingPageValidationError, type BookingPageRow } from "@/lib/booking-page/db";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockClientFactory = vi.mocked(createSupabaseServiceClient);

function typeRow(over: Partial<BookingMeetingTypeRow> = {}): BookingMeetingTypeRow {
  return {
    id: "mt-1",
    business_id: BIZ,
    name: "Discovery call",
    slug: "discovery-call",
    description: null,
    duration_minutes: 60,
    intake_questions: null,
    assignment_mode: null,
    employee_id: null,
    payment_required: false,
    payment_amount_cents: null,
    payment_currency: "usd",
    enabled: true,
    hidden: false,
    sort_order: 0,
    created_at: "2026-07-27T00:00:00Z",
    updated_at: "2026-07-27T00:00:00Z",
    ...over
  };
}

function pageRow(over: Partial<BookingPageRow> = {}): BookingPageRow {
  return {
    id: "page-1",
    business_id: BIZ,
    token: `ncb_${"a".repeat(64)}`,
    enabled: true,
    allowed_durations: [15, 30],
    min_notice_minutes: 120,
    max_advance_days: 14,
    buffer_minutes: 0,
    max_daily_bookings: null,
    require_staff_on_shift: false,
    description: "Page blurb",
    waitlist_enabled: true,
    waitlist_offer_ttl_minutes: 60,
    slug: "new-coworker",
    title: "Book a call",
    send_confirmation_email: true,
    reminders_enabled: true,
    reminder_email_hours: 24,
    reminder_sms_hours: 2,
    assignment_mode: "any",
    employee_id: null,
    notify_assignee: true,
    intake_questions: [
      { id: "page-q", label: "Page question", type: "text", required: false }
    ],
    payment_required: false,
    payment_amount_cents: null,
    payment_currency: "usd",
    created_at: "2026-07-24T00:00:00Z",
    updated_at: "2026-07-24T00:00:00Z",
    ...over
  } as BookingPageRow;
}

/** What the page hands to a meeting that was inheriting it. */
const PAGE_QUESTIONS = [
  { id: "page-q", label: "Page question", type: "text", required: false, enabled: true }
];

type QueryResult = { data?: unknown; error?: { message: string } | null };

/** Chainable supabase fake: records calls, resolves queued results in order. */
function fakeDb(results: QueryResult[]) {
  let call = 0;
  const next = () => results[Math.min(call++, results.length - 1)] ?? { data: null, error: null };
  const calls: Array<{ method: string; args: unknown[] }> = [];

  function builder(): Record<string, unknown> {
    const b: Record<string, unknown> = {};
    for (const method of ["select", "eq", "order", "insert", "update", "delete"]) {
      b[method] = vi.fn((...args: unknown[]) => {
        calls.push({ method, args });
        return b;
      });
    }
    b.maybeSingle = vi.fn(() => Promise.resolve(next()));
    b.single = vi.fn(() => Promise.resolve(next()));
    b.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve(next()).then(resolve, reject);
    return b;
  }

  const client = { from: vi.fn(() => builder()) };
  return { client: client as never, calls };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listMeetingTypes / visibleMeetingTypes", () => {
  it("reads the business's types in the owner's display order", async () => {
    const { client, calls } = fakeDb([{ data: [typeRow()], error: null }]);
    expect(await listMeetingTypes(BIZ, client)).toHaveLength(1);
    expect(calls.find((c) => c.method === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(calls.filter((c) => c.method === "order").map((c) => c.args[0])).toEqual([
      "sort_order",
      "created_at"
    ]);
  });

  it("answers [] on a null payload, and throws a read failure", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await listMeetingTypes(BIZ, client)).toEqual([]);

    const { client: failing } = fakeDb([{ data: null, error: { message: "rls" } }]);
    await expect(listMeetingTypes(BIZ, failing)).rejects.toThrow("listMeetingTypes: rls");
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ data: [], error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await listMeetingTypes(BIZ);
    expect(mockClientFactory).toHaveBeenCalled();
  });

  it("lists only enabled, non-hidden types on the picker", () => {
    // Hidden is the secret-event case: bookable by direct link, off the menu.
    const types = [
      typeRow({ id: "a" }),
      typeRow({ id: "b", hidden: true }),
      typeRow({ id: "c", enabled: false }),
      typeRow({ id: "d", enabled: false, hidden: true })
    ];
    expect(visibleMeetingTypes(types).map((t) => t.id)).toEqual(["a"]);
  });
});

describe("getEnabledMeetingType", () => {
  it("resolves an enabled type by slug, scoped to the business", async () => {
    const { client, calls } = fakeDb([{ data: typeRow(), error: null }]);
    expect(await getEnabledMeetingType(BIZ, "discovery-call", client)).toMatchObject({
      slug: "discovery-call"
    });
    const eqs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["business_id", BIZ]);
    expect(eqs).toContainEqual(["slug", "discovery-call"]);
    // Disabled types fail closed at the query, like an unknown slug.
    expect(eqs).toContainEqual(["enabled", true]);
  });

  it("fails closed on a malformed slug without touching the database", async () => {
    const { client } = fakeDb([{ data: typeRow(), error: null }]);
    expect(await getEnabledMeetingType(BIZ, "NOT A SLUG", client)).toBeNull();
    expect(await getEnabledMeetingType(BIZ, "", client)).toBeNull();
    expect((client as unknown as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled();
  });

  it("answers null when nothing matches, and throws a read failure", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    expect(await getEnabledMeetingType(BIZ, "discovery-call", client)).toBeNull();

    const { client: failing } = fakeDb([{ data: null, error: { message: "rls" } }]);
    await expect(getEnabledMeetingType(BIZ, "discovery-call", failing)).rejects.toThrow(
      "getEnabledMeetingType: rls"
    );
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ data: null, error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await getEnabledMeetingType(BIZ, "discovery-call");
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("ensureDefaultMeetingType", () => {
  it("gives a fresh page its first meeting, carrying the page's identity", async () => {
    const { client, calls } = fakeDb([
      { data: [], error: null },
      // createMeetingType re-reads the list for its cap check.
      { data: [], error: null },
      { data: typeRow({ intake_questions: PAGE_QUESTIONS }), error: null }
    ]);
    const result = await ensureDefaultMeetingType(pageRow({ title: "Free strategy call" }), client);
    expect(result.pageQuestionsCleared).toBe(true);
    const insert = calls.find((c) => c.method === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      business_id: BIZ,
      name: "Free strategy call",
      slug: DEFAULT_MEETING_SLUG,
      description: "Page blurb",
      // The shortest offered duration is what the picker defaulted to.
      duration_minutes: 15
    });
    // An explicit list, never null: inheriting questions the dashboard no
    // longer shows would surprise the owner.
    expect(insert.intake_questions).toEqual(PAGE_QUESTIONS);
    // And the page's copy goes, or a SECOND meeting created later would
    // inherit a list nothing in the dashboard shows.
    expect(calls.find((c) => c.method === "update")?.args[0]).toEqual({ intake_questions: [] });
  });

  it("leaves the page alone when it had no questions to hand over", async () => {
    const { client, calls } = fakeDb([
      { data: [], error: null },
      { data: [], error: null },
      { data: typeRow(), error: null }
    ]);
    await ensureDefaultMeetingType(pageRow({ intake_questions: [] }), client);
    expect(calls.some((c) => c.method === "update")).toBe(false);
  });

  it("falls back to the default name and duration on a bare page", async () => {
    const { client, calls } = fakeDb([
      { data: [], error: null },
      { data: [], error: null },
      { data: typeRow(), error: null }
    ]);
    await ensureDefaultMeetingType(
      pageRow({ title: "   ", allowed_durations: [], description: null, intake_questions: [] }),
      client
    );
    expect(calls.find((c) => c.method === "insert")?.args[0]).toMatchObject({
      name: DEFAULT_MEETING_NAME,
      duration_minutes: 30,
      description: null
    });
  });

  it("is idempotent: a page with any meeting is left alone", async () => {
    const { client, calls } = fakeDb([{ data: [typeRow({ id: "existing" })], error: null }]);
    expect((await ensureDefaultMeetingType(pageRow({ intake_questions: [] }), client)).meetingType?.id).toBe(
      "existing"
    );
    expect(calls.some((c) => c.method === "insert")).toBe(false);
  });

  it("loses the create race gracefully: the winner's meeting serves", async () => {
    const { client } = fakeDb([
      { data: [], error: null },
      { data: [], error: null },
      // The insert loses on the per-business slug index...
      { data: null, error: { message: 'duplicate key "uq_booking_meeting_types_business_slug"' } },
      // ...so the re-read answers with what the other tab created.
      { data: [typeRow({ id: "winner" })], error: null }
    ]);
    expect(
      (await ensureDefaultMeetingType(pageRow({ intake_questions: [] }), client)).meetingType?.id
    ).toBe("winner");
  });

  it("answers null when the race leaves genuinely nothing", async () => {
    const { client } = fakeDb([
      { data: [], error: null },
      { data: [], error: null },
      { data: null, error: { message: "insert denied" } },
      { data: [], error: null }
    ]);
    expect((await ensureDefaultMeetingType(pageRow(), client)).meetingType).toBeNull();
  });

  it("copies the page's questions onto a meeting still inheriting them", async () => {
    // The delicate case: a meeting stored null, so the public page resolves
    // the page's list for it. Clearing the page first would silently stop
    // asking those visitors anything.
    const { client, calls } = fakeDb([
      { data: [typeRow({ id: "legacy", intake_questions: null })], error: null },
      { error: null },
      { error: null }
    ]);
    const result = await ensureDefaultMeetingType(pageRow(), client);
    expect(result.pageQuestionsCleared).toBe(true);
    const updates = calls.filter((c) => c.method === "update").map((c) => c.args[0]);
    expect(updates).toEqual([{ intake_questions: PAGE_QUESTIONS }, { intake_questions: [] }]);
  });

  it("keeps the page's copy when a meeting cannot take its own", async () => {
    const { client, calls } = fakeDb([
      { data: [typeRow({ id: "legacy", intake_questions: null })], error: null },
      { error: { message: "update denied" } }
    ]);
    const result = await ensureDefaultMeetingType(pageRow(), client);
    // The page's list is the only record of what that meeting asks until
    // the copy lands, so it stays and the next load retries.
    expect(result.pageQuestionsCleared).toBe(false);
    expect(calls.filter((c) => c.method === "update")).toHaveLength(1);
  });

  it("reports the page as unchanged when the clear itself fails", async () => {
    const { client } = fakeDb([
      { data: [typeRow({ intake_questions: PAGE_QUESTIONS })], error: null },
      { error: { message: "clear denied" } }
    ]);
    expect((await ensureDefaultMeetingType(pageRow(), client)).pageQuestionsCleared).toBe(false);
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ data: [typeRow()], error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await ensureDefaultMeetingType(pageRow({ intake_questions: [] }));
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("createMeetingType", () => {
  const NEW = { name: " Discovery call ", slug: "discovery-call", durationMinutes: 60 };

  it("normalizes and appends the type at the end of the list", async () => {
    const { client, calls } = fakeDb([
      { data: [typeRow({ id: "existing" })], error: null },
      { data: typeRow(), error: null }
    ]);
    await createMeetingType(BIZ, { ...NEW, description: "  Thirty minutes  " }, client);
    const insert = calls.find((c) => c.method === "insert")?.args[0] as Record<string, unknown>;
    expect(insert).toMatchObject({
      business_id: BIZ,
      name: "Discovery call",
      slug: "discovery-call",
      duration_minutes: 60,
      description: "Thirty minutes",
      sort_order: 1
    });
  });

  it("requires a name, link, and duration", async () => {
    const { client } = fakeDb([{ data: [], error: null }]);
    for (const patch of [
      { slug: "x-y", durationMinutes: 30 },
      { name: "X", durationMinutes: 30 },
      { name: "X", slug: "x-y" }
    ]) {
      await expect(createMeetingType(BIZ, patch, client)).rejects.toThrow(
        /needs a name, link, and duration/
      );
    }
    // A blank name is caught by the field validator first, which says the
    // more useful thing.
    await expect(
      createMeetingType(BIZ, { name: "  ", slug: "x-y", durationMinutes: 30 }, client)
    ).rejects.toThrow(/Meeting name must be/);
  });

  it("refuses a full catalog", async () => {
    const many = Array.from({ length: MAX_MEETING_TYPES }, (_, i) => typeRow({ id: `t${i}` }));
    const { client } = fakeDb([{ data: many, error: null }]);
    await expect(createMeetingType(BIZ, NEW, client)).rejects.toThrow(/up to 10 meeting types/);
  });

  it("maps a duplicate link to an owner-facing message, other errors stay generic", async () => {
    const { client } = fakeDb([
      { data: [], error: null },
      { data: null, error: { message: 'duplicate key "uq_booking_meeting_types_business_slug"' } }
    ]);
    await expect(createMeetingType(BIZ, NEW, client)).rejects.toThrow(
      /meeting link is already taken/
    );

    const { client: other } = fakeDb([
      { data: [], error: null },
      { data: null, error: { message: "connection reset" } }
    ]);
    await expect(createMeetingType(BIZ, NEW, other)).rejects.toThrow(
      "createMeetingType: connection reset"
    );
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([
      { data: [], error: null },
      { data: typeRow(), error: null }
    ]);
    mockClientFactory.mockResolvedValue(client);
    await createMeetingType(BIZ, NEW);
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("meeting type validation", () => {
  it("refuses junk in every field", async () => {
    const { client } = fakeDb([{ data: [typeRow()], error: null }]);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ name: "" }, /Meeting name must be/],
      [{ name: "x".repeat(200) }, /Meeting name must be/],
      [{ slug: "NOT A SLUG" }, /Meeting link must be/],
      [{ slug: "manage" }, /Meeting link must be/],
      [{ description: "x".repeat(600) }, /Description must be/],
      [{ durationMinutes: 0 }, /Duration must be/],
      [{ durationMinutes: 1000 }, /Duration must be/],
      [{ durationMinutes: 30.5 }, /Duration must be/],
      [{ intakeQuestions: "not-a-list" }, /Questions must be a list/],
      [{ assignmentMode: "pooled" }, /Unknown assignment mode/],
      [{ paymentAmountCents: 10 }, /Price must be/],
      [{ paymentAmountCents: 6_000_000 }, /Price must be/],
      [{ paymentCurrency: "btc" }, /Unsupported currency/],
      [{ sortOrder: -1 }, /Sort order must be/],
      [{ sortOrder: 1000 }, /Sort order must be/]
    ];
    for (const [patch, message] of cases) {
      await expect(updateMeetingType(BIZ, "mt-1", patch, client)).rejects.toThrow(message);
    }
  });

  it("refuses the two self-contradicting states, on the RESULTING row", async () => {
    // Fixed with nobody named behaves like an unassigned meeting.
    const { client } = fakeDb([{ data: [typeRow()], error: null }]);
    await expect(
      updateMeetingType(BIZ, "mt-1", { assignmentMode: "fixed" }, client)
    ).rejects.toThrow(/Pick the employee this meeting books/);

    // Clearing the employee on a type ALREADY fixed is the same mistake.
    const { client: fixed } = fakeDb([
      { data: [typeRow({ assignment_mode: "fixed", employee_id: "m-ana" })], error: null }
    ]);
    await expect(
      updateMeetingType(BIZ, "mt-1", { employeeId: null }, fixed)
    ).rejects.toThrow(/Pick the employee this meeting books/);

    // Requiring payment with no price refuses every booking silently.
    const { client: unpaid } = fakeDb([{ data: [typeRow()], error: null }]);
    await expect(
      updateMeetingType(BIZ, "mt-1", { paymentRequired: true }, unpaid)
    ).rejects.toThrow(/Set a price to require payment/);

    const { client: paid } = fakeDb([
      { data: [typeRow({ payment_required: true, payment_amount_cents: 5000 })], error: null }
    ]);
    await expect(
      updateMeetingType(BIZ, "mt-1", { paymentAmountCents: null }, paid)
    ).rejects.toThrow(/Set a price to require payment/);
  });

  it("accepts the coherent versions of both", async () => {
    const { client } = fakeDb([
      { data: [typeRow()], error: null },
      { data: typeRow(), error: null }
    ]);
    await expect(
      updateMeetingType(
        BIZ,
        "mt-1",
        { assignmentMode: "fixed", employeeId: "m-ana", paymentRequired: true, paymentAmountCents: 5000 },
        client
      )
    ).resolves.toBeTruthy();
  });
});

describe("updateMeetingType", () => {
  it("writes the patch scoped to (business, id)", async () => {
    const { client, calls } = fakeDb([
      { data: [typeRow()], error: null },
      { data: typeRow({ name: "Renamed" }), error: null }
    ]);
    await updateMeetingType(BIZ, "mt-1", { name: "Renamed", hidden: true }, client);
    const update = calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>;
    expect(update).toMatchObject({ name: "Renamed", hidden: true });
    const eqs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["business_id", BIZ]);
    expect(eqs).toContainEqual(["id", "mt-1"]);
  });

  it("stores questions NORMALIZED, and null to restore inheritance", async () => {
    const { client, calls } = fakeDb([
      { data: [typeRow()], error: null },
      { data: typeRow(), error: null }
    ]);
    await updateMeetingType(
      BIZ,
      "mt-1",
      {
        intakeQuestions: [
          { id: "topic", label: " Topic? ", type: "text", required: true },
          { id: "junk!", label: "dropped", type: "text", required: false }
        ]
      },
      client
    );
    expect(
      (calls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>)
        .intake_questions
    ).toEqual([
      { id: "topic", label: "Topic?", type: "text", required: true, enabled: true }
    ]);

    const { client: clearing, calls: clearCalls } = fakeDb([
      { data: [typeRow()], error: null },
      { data: typeRow(), error: null }
    ]);
    await updateMeetingType(BIZ, "mt-1", { intakeQuestions: null }, clearing);
    expect(
      (clearCalls.find((c) => c.method === "update")?.args[0] as Record<string, unknown>)
        .intake_questions
    ).toBeNull();
  });

  it("clears a blanked description, and writes the remaining knobs", async () => {
    const { client, calls } = fakeDb([
      { data: [typeRow()], error: null },
      { data: typeRow(), error: null }
    ]);
    await updateMeetingType(
      BIZ,
      "mt-1",
      {
        description: "   ",
        paymentRequired: true,
        paymentAmountCents: 5000,
        paymentCurrency: "usd",
        enabled: false,
        sortOrder: 3
      },
      client
    );
    expect(calls.find((c) => c.method === "update")?.args[0]).toMatchObject({
      description: null,
      payment_required: true,
      payment_amount_cents: 5000,
      payment_currency: "usd",
      enabled: false,
      sort_order: 3
    });
  });

  it("refuses an id that is not this business's", async () => {
    const { client } = fakeDb([{ data: [typeRow({ id: "other" })], error: null }]);
    await expect(updateMeetingType(BIZ, "mt-1", { name: "X" }, client)).rejects.toThrow(
      /no longer exists/
    );
  });

  it("maps a duplicate link, and uses the service client by default", async () => {
    const { client } = fakeDb([
      { data: [typeRow()], error: null },
      { data: null, error: { message: 'duplicate key "uq_booking_meeting_types_business_slug"' } }
    ]);
    await expect(
      updateMeetingType(BIZ, "mt-1", { slug: "taken-slug" }, client)
    ).rejects.toThrow(/meeting link is already taken/);

    const { client: other } = fakeDb([
      { data: [typeRow()], error: null },
      { data: null, error: { message: "boom" } }
    ]);
    await expect(updateMeetingType(BIZ, "mt-1", { name: "X" }, other)).rejects.toThrow(
      "updateMeetingType: boom"
    );

    const { client: fallback } = fakeDb([
      { data: [typeRow()], error: null },
      { data: typeRow(), error: null }
    ]);
    mockClientFactory.mockResolvedValue(fallback);
    await updateMeetingType(BIZ, "mt-1", { name: "X" });
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("deleteMeetingType", () => {
  it("deletes scoped to (business, id) and surfaces a failure", async () => {
    const { client, calls } = fakeDb([{ error: null }]);
    await deleteMeetingType(BIZ, "mt-1", client);
    expect(calls.some((c) => c.method === "delete")).toBe(true);
    const eqs = calls.filter((c) => c.method === "eq").map((c) => c.args);
    expect(eqs).toContainEqual(["business_id", BIZ]);
    expect(eqs).toContainEqual(["id", "mt-1"]);

    const { client: failing } = fakeDb([{ error: { message: "denied" } }]);
    await expect(deleteMeetingType(BIZ, "mt-1", failing)).rejects.toThrow(
      "deleteMeetingType: denied"
    );
  });

  it("uses the service client by default", async () => {
    const { client } = fakeDb([{ error: null }]);
    mockClientFactory.mockResolvedValue(client);
    await deleteMeetingType(BIZ, "mt-1");
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("effectiveTypeSettings", () => {
  it("is the page itself when there is no type (today's flow)", () => {
    const eff = effectiveTypeSettings(pageRow(), null, 30);
    expect(eff).toMatchObject({
      durationMinutes: 30,
      title: "Book a call",
      description: "Page blurb",
      assignmentMode: "any",
      paymentRequired: false
    });
    expect(eff.questions.map((q) => q.id)).toEqual(["page-q"]);

    // A page with no custom title reports null, so the caller renders its
    // own localized default.
    expect(effectiveTypeSettings(pageRow({ title: "  " }), null, 30).title).toBeNull();
  });

  it("a bare type takes its duration and name, inheriting everything else", () => {
    const eff = effectiveTypeSettings(
      pageRow({ assignment_mode: "fixed", employee_id: "m-page" }),
      typeRow(),
      30
    );
    // The type's duration REPLACES whatever the visitor's picker said.
    expect(eff.durationMinutes).toBe(60);
    expect(eff.title).toBe("Discovery call");
    expect(eff.description).toBe("Page blurb");
    expect(eff.questions.map((q) => q.id)).toEqual(["page-q"]);
    expect(eff.assignmentMode).toBe("fixed");
    expect(eff.employeeId).toBe("m-page");
  });

  it("its own description and questions override the page's", () => {
    const eff = effectiveTypeSettings(
      pageRow(),
      typeRow({
        description: "Just this meeting",
        intake_questions: [{ id: "topic", label: "Topic?", type: "text", required: true }]
      }),
      30
    );
    expect(eff.description).toBe("Just this meeting");
    expect(eff.questions.map((q) => q.id)).toEqual(["topic"]);
  });

  it("an EMPTY question list means this meeting asks nothing, not inherit", () => {
    // The distinction the nullable column exists for.
    const eff = effectiveTypeSettings(pageRow(), typeRow({ intake_questions: [] }), 30);
    expect(eff.questions).toEqual([]);
  });

  it("assignment travels with the mode: own person, or the page's entirely", () => {
    const own = effectiveTypeSettings(
      pageRow({ assignment_mode: "fixed", employee_id: "m-page" }),
      typeRow({ assignment_mode: "fixed", employee_id: "m-ana" }),
      30
    );
    expect(own).toMatchObject({ assignmentMode: "fixed", employeeId: "m-ana" });

    // A type that declares round_robin must NOT borrow the page's person.
    const rr = effectiveTypeSettings(
      pageRow({ assignment_mode: "fixed", employee_id: "m-page" }),
      typeRow({ assignment_mode: "round_robin" }),
      30
    );
    expect(rr).toMatchObject({ assignmentMode: "round_robin", employeeId: null });
  });

  it("payment overrides upward only: a type can charge, never undercut", () => {
    const charges = effectiveTypeSettings(
      pageRow(),
      typeRow({ payment_required: true, payment_amount_cents: 5000, payment_currency: "cad" }),
      30
    );
    expect(charges).toMatchObject({
      paymentRequired: true,
      paymentAmountCents: 5000,
      paymentCurrency: "cad"
    });

    // The page charges and the type says nothing: the page still wins.
    const inherited = effectiveTypeSettings(
      pageRow({ payment_required: true, payment_amount_cents: 2500 }),
      typeRow(),
      30
    );
    expect(inherited).toMatchObject({ paymentRequired: true, paymentAmountCents: 2500 });
  });

  it("tolerates an undefined questions column (a row read before the migration)", () => {
    const eff = effectiveTypeSettings(
      pageRow(),
      typeRow({ intake_questions: undefined as never }),
      30
    );
    expect(eff.questions.map((q) => q.id)).toEqual(["page-q"]);
  });
});

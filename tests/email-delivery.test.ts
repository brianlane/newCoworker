/**
 * Resend delivery receipts (src/lib/email/delivery.ts).
 *
 * The interesting assertions are the ordering ones. Receipts race, and the
 * bug this whole feature exists to prevent is a `bounced` being overwritten
 * by a `sent` that was already in flight, which would put an undelivered
 * alert back on the "we told them" pile.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import {
  applyEmailDeliveryStatus,
  applyEmailDeliveryStatusByRecipient,
  emailDeliveryOutranks,
  EMAIL_DELIVERY_FAILURES,
  isEmailDeliveryFailure,
  resendEventToStatus,
  type EmailDeliveryStatus
} from "@/lib/email/delivery";

/**
 * Pins the module-private fallback window as a LITERAL: Resend retries a
 * transiently-refused message for up to 72 hours before reporting the
 * bounce, so the window must stay comfortably above that. Asserting against
 * the exported constant would be a tautology.
 */
const RECIPIENT_WINDOW_MS = 4 * 24 * 60 * 60 * 1000;

type Chain = {
  select: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  eq: ReturnType<typeof vi.fn>;
  ilike: ReturnType<typeof vi.fn>;
  gte: ReturnType<typeof vi.fn>;
  or: ReturnType<typeof vi.fn>;
  order: ReturnType<typeof vi.fn>;
  limit: ReturnType<typeof vi.fn>;
};

function chain(terminal?: unknown): Chain & PromiseLike<unknown> {
  const c = {
    select: vi.fn(() => c),
    update: vi.fn(() => c),
    eq: vi.fn(() => c),
    ilike: vi.fn(() => c),
    gte: vi.fn(() => c),
    or: vi.fn(() => c),
    order: vi.fn(() => c),
    limit: vi.fn(() => c),
    then: (resolve: (v: unknown) => unknown) => Promise.resolve(terminal).then(resolve)
  };
  return c as never;
}

const BIZ = "11111111-1111-4111-8111-111111111111";
const MID = "re_abc123";

/**
 * Two separate chains, because the lookup and the write are two `.from()`
 * calls with different terminals. Returned together so a test can assert on
 * either half.
 */
function makeDb(read: unknown, update: unknown) {
  let n = 0;
  return { from: vi.fn(() => (n++ === 0 ? read : update)) } as never;
}

/** A db whose existing row is `current` and whose update writes `updated`. */
function dbWith(current: EmailDeliveryStatus | null, updated: unknown = [{ id: "row-1" }]) {
  const read = chain({
    data: current === undefined ? [] : [{ id: "row-1", business_id: BIZ, delivery_status: current }],
    error: null
  });
  const write = chain({ data: updated, error: null });
  return { db: makeDb(read, write), read, write };
}

describe("resendEventToStatus", () => {
  it.each([
    ["email.sent", "sent"],
    ["email.delivery_delayed", "delayed"],
    ["email.delivered", "delivered"],
    ["email.complained", "complained"],
    ["email.bounced", "bounced"],
    ["email.failed", "failed"]
  ])("maps %s", (type, expected) => {
    expect(resendEventToStatus(type)).toBe(expected);
  });

  it("ignores event types this column does not model", () => {
    // Engagement, not delivery: folding these in would make an unopened but
    // delivered email look worse than a delivered one.
    expect(resendEventToStatus("email.opened")).toBeNull();
    expect(resendEventToStatus("email.clicked")).toBeNull();
    // And anything Resend adds later.
    expect(resendEventToStatus("email.scheduled")).toBeNull();
  });
});

describe("isEmailDeliveryFailure", () => {
  it("counts a spam complaint as a failure", () => {
    // It technically arrived, but it poisons the sending domain for every
    // other tenant, so it has to surface as loudly as a bounce.
    expect(isEmailDeliveryFailure("complained")).toBe(true);
    expect(EMAIL_DELIVERY_FAILURES).toContain("complained");
  });

  it("does not count the states that mean it is still on its way", () => {
    expect(isEmailDeliveryFailure("sent")).toBe(false);
    expect(isEmailDeliveryFailure("delayed")).toBe(false);
    expect(isEmailDeliveryFailure("delivered")).toBe(false);
  });
});

describe("emailDeliveryOutranks", () => {
  it("accepts anything over an unknown current state", () => {
    expect(emailDeliveryOutranks("sent", null)).toBe(true);
    expect(emailDeliveryOutranks("bounced", undefined)).toBe(true);
  });

  it("lets a delivered receipt overtake a delayed one", () => {
    // The common recovery sequence. If `delayed` won, a mail that arrived
    // fine would sit on the failure report forever.
    expect(emailDeliveryOutranks("delivered", "delayed")).toBe(true);
    expect(emailDeliveryOutranks("delayed", "delivered")).toBe(false);
  });

  it("never lets a late sent/delivered receipt mask a bounce", () => {
    expect(emailDeliveryOutranks("sent", "bounced")).toBe(false);
    expect(emailDeliveryOutranks("delivered", "bounced")).toBe(false);
    expect(emailDeliveryOutranks("bounced", "delivered")).toBe(true);
  });

  it("refuses an identical repeat", () => {
    expect(emailDeliveryOutranks("delivered", "delivered")).toBe(false);
  });
});

describe("applyEmailDeliveryStatus", () => {
  beforeEach(() => {
    defaultClientSpy.mockReset();
  });

  it("writes the receipt onto the row the provider id names", async () => {
    const { db, read, write } = dbWith("sent");
    const result = await applyEmailDeliveryStatus(
      {
        providerMessageId: MID,
        status: "delivered",
        timestamp: "2026-08-26T06:00:00.000Z"
      },
      db
    );
    expect(result).toEqual({ outcome: "applied", businessId: BIZ });
    expect(write.update).toHaveBeenCalledWith({
      delivery_status: "delivered",
      delivery_error_code: null,
      delivery_error_message: null,
      delivery_updated_at: "2026-08-26T06:00:00.000Z"
    });
    expect(read.eq).toHaveBeenCalledWith("provider_message_id", MID);
    expect(write.eq).toHaveBeenCalledWith("id", "row-1");
  });

  it("takes the newest OUTBOUND match rather than assuming the id is unique", async () => {
    // provider_message_id is not unique in production: a live scan on
    // 2026-08-26 found duplicated Gmail-style ids. maybeSingle would throw on
    // the second row and lose the receipt silently.
    const { db, read } = dbWith("sent");
    await applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" }, db);
    expect(read.eq).toHaveBeenCalledWith("direction", "outbound");
    expect(read.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(read.limit).toHaveBeenCalledWith(1);
  });

  it("keeps the bounce reason on a failure and clears it otherwise", async () => {
    const failed = dbWith("sent");
    await applyEmailDeliveryStatus(
      {
        providerMessageId: MID,
        status: "bounced",
        errorCode: "HardBounce",
        errorMessage: "The recipient does not exist",
        timestamp: "2026-08-26T06:00:00.000Z"
      },
      failed.db
    );
    expect(failed.write.update).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_status: "bounced",
        delivery_error_code: "HardBounce",
        delivery_error_message: "The recipient does not exist"
      })
    );

    // A non-failure carrying a stale reason must not keep it: a later failure
    // has to be able to REPLACE an earlier one's reason, so the column is
    // authored on every write rather than appended to.
    const ok = dbWith(null);
    await applyEmailDeliveryStatus(
      {
        providerMessageId: MID,
        status: "delivered",
        errorCode: "HardBounce",
        errorMessage: "stale",
        timestamp: "2026-08-26T06:00:00.000Z"
      },
      ok.db
    );
    expect(ok.write.update).toHaveBeenCalledWith(
      expect.objectContaining({ delivery_error_code: null, delivery_error_message: null })
    );
  });

  it("stamps now when the receipt carried no usable timestamp", async () => {
    const { db, write } = dbWith(null);
    const before = Date.now();
    await applyEmailDeliveryStatus({ providerMessageId: MID, status: "sent" }, db);
    const written = write.update.mock.calls[0][0].delivery_updated_at as string;
    expect(Date.parse(written)).toBeGreaterThanOrEqual(before);
  });

  it("guards the update on rank so a concurrent receipt cannot lose the race silently", async () => {
    const { db, write } = dbWith("sent");
    await applyEmailDeliveryStatus({ providerMessageId: MID, status: "bounced" }, db);
    // Everything strictly below `bounced`, so the UPDATE only matches a row
    // still in one of those states when Postgres locks it.
    expect(write.or).toHaveBeenCalledWith(
      "delivery_status.is.null,delivery_status.in.(sent,delayed,delivered,complained)"
    );
  });

  it("guards on null alone for the lowest-ranked receipt", async () => {
    const { db, write } = dbWith(null);
    await applyEmailDeliveryStatus({ providerMessageId: MID, status: "sent" }, db);
    expect(write.or).toHaveBeenCalledWith("delivery_status.is.null");
  });

  it("reports stale without writing when the row already holds a higher state", async () => {
    const { db, write } = dbWith("bounced");
    const result = await applyEmailDeliveryStatus(
      { providerMessageId: MID, status: "sent" },
      db
    );
    expect(result).toEqual({ outcome: "stale", businessId: BIZ });
    expect(write.update).not.toHaveBeenCalled();
  });

  it("reports stale when the guarded update matched no row", async () => {
    // The read said `sent`, but a concurrent invocation moved the row past us
    // before our UPDATE ran. PostgREST returns no error for a zero-row update,
    // so the returned rows are the only signal.
    for (const updated of [[], null]) {
      const { db } = dbWith("sent", updated);
      expect(
        await applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" }, db)
      ).toEqual({ outcome: "stale", businessId: BIZ });
    }
  });

  it("treats an unmatched provider id as routine, not an error", async () => {
    // Resend fires receipts for every message on the account, including mail
    // sent by paths that do not log to email_log at all.
    const db = makeDb(chain({ data: [], error: null }), chain({ data: [], error: null }));
    expect(
      await applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" }, db)
    ).toEqual({ outcome: "not_found", businessId: null });

    // A null body means the same thing and must not throw either.
    const nullDb = makeDb(chain({ data: null, error: null }), chain({ data: [], error: null }));
    expect(
      await applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" }, nullDb)
    ).toEqual({ outcome: "not_found", businessId: null });
  });

  it("throws when the lookup fails", async () => {
    const db = makeDb(chain({ data: null, error: { message: "read boom" } }), chain());
    await expect(
      applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" }, db)
    ).rejects.toThrow("applyEmailDeliveryStatus: read boom");
  });

  it("throws when the update fails", async () => {
    const failing = makeDb(
      chain({ data: [{ id: "row-1", business_id: BIZ, delivery_status: null }], error: null }),
      chain({ data: null, error: { message: "write boom" } })
    );
    await expect(
      applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" }, failing)
    ).rejects.toThrow("applyEmailDeliveryStatus: write boom");
  });

  it("falls back to the service client when no client is injected", async () => {
    const { db } = dbWith(null);
    defaultClientSpy.mockReturnValue(db);
    expect(
      await applyEmailDeliveryStatus({ providerMessageId: MID, status: "delivered" })
    ).toEqual({ outcome: "applied", businessId: BIZ });
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

describe("applyEmailDeliveryStatusByRecipient", () => {
  // The live case this exists for: a pitch relayed to Resend by Gmail's
  // send-as SMTP setting, logged under its Gmail id, bounced under Resend's.
  const input = {
    to: "info@virginiaautoservice.com",
    subject: "Virginia Auto Service: the calls that come in after you close",
    status: "bounced" as const,
    errorCode: "Permanent",
    errorMessage: "hard bounce",
    timestamp: "2026-08-26T15:00:47.000Z"
  };

  beforeEach(() => {
    defaultClientSpy.mockReset();
  });

  it("attributes a receipt to the newest recent outbound row for the recipient and subject", async () => {
    const { db, read, write } = dbWith("sent");
    const before = Date.now();
    expect(await applyEmailDeliveryStatusByRecipient(input, db)).toEqual({
      outcome: "applied",
      businessId: BIZ
    });
    expect(read.ilike).toHaveBeenCalledWith("to_email", "info@virginiaautoservice.com");
    expect(read.eq).toHaveBeenCalledWith("subject", input.subject);
    expect(read.eq).toHaveBeenCalledWith("direction", "outbound");
    expect(read.order).toHaveBeenCalledWith("created_at", { ascending: false });
    expect(read.limit).toHaveBeenCalledWith(1);
    // Bounded recency: recipient + subject is a heuristic key, so an old row
    // with the same pair must never be claimed by a fresh receipt.
    const cutoff = read.gte.mock.calls[0] as [string, string];
    expect(cutoff[0]).toBe("created_at");
    expect(Date.parse(cutoff[1])).toBeGreaterThanOrEqual(
      before - RECIPIENT_WINDOW_MS
    );
    expect(Date.parse(cutoff[1])).toBeLessThanOrEqual(Date.now() - RECIPIENT_WINDOW_MS);
    expect(write.update).toHaveBeenCalledWith(
      expect.objectContaining({
        delivery_status: "bounced",
        delivery_error_code: "Permanent",
        delivery_error_message: "hard bounce"
      })
    );
  });

  it("escapes ILIKE wildcards so an address is matched literally", async () => {
    // `_` is a single-character wildcard in ILIKE; unescaped, john_doe@x.com
    // would also claim receipts for johnXdoe@x.com.
    const { db, read } = dbWith("sent");
    await applyEmailDeliveryStatusByRecipient(
      { ...input, to: "john_doe%1@x.com" },
      db
    );
    expect(read.ilike).toHaveBeenCalledWith("to_email", "john\\_doe\\%1@x.com");
  });

  it("reports not_found when nothing recent matches", async () => {
    for (const data of [[], null]) {
      const db = makeDb(chain({ data, error: null }), chain());
      expect(await applyEmailDeliveryStatusByRecipient(input, db)).toEqual({
        outcome: "not_found",
        businessId: null
      });
    }
  });

  it("reports stale without writing when the row already holds a higher state", async () => {
    const { db, write } = dbWith("failed");
    expect(await applyEmailDeliveryStatusByRecipient(input, db)).toEqual({
      outcome: "stale",
      businessId: BIZ
    });
    expect(write.update).not.toHaveBeenCalled();
  });

  it("throws with its own label when the lookup or the write fails", async () => {
    const readFail = makeDb(chain({ data: null, error: { message: "read boom" } }), chain());
    await expect(applyEmailDeliveryStatusByRecipient(input, readFail)).rejects.toThrow(
      "applyEmailDeliveryStatusByRecipient: read boom"
    );

    const writeFail = makeDb(
      chain({ data: [{ id: "row-1", business_id: BIZ, delivery_status: null }], error: null }),
      chain({ data: null, error: { message: "write boom" } })
    );
    await expect(applyEmailDeliveryStatusByRecipient(input, writeFail)).rejects.toThrow(
      "applyEmailDeliveryStatusByRecipient: write boom"
    );
  });

  it("falls back to the service client when no client is injected", async () => {
    const { db } = dbWith(null);
    defaultClientSpy.mockReturnValue(db);
    expect(await applyEmailDeliveryStatusByRecipient(input)).toEqual({
      outcome: "applied",
      businessId: BIZ
    });
    expect(defaultClientSpy).toHaveBeenCalled();
  });
});

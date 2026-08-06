/**
 * The send that actually lands INSIDE the conversation.
 *
 * PR #1201 gave the flow schema `replyToEmailLogId` and the trigger scope its
 * `message_ref`. Nothing consumes either yet: a flow can declare a reply and
 * still open a brand new thread beside the original, which is exactly the
 * complaint about the dashboard Reply button.
 *
 * Two halves, both hermetic:
 *   1. the inbound row keeps the identity (`thread_id`, `message_ref`), because
 *      a reply cannot be threaded against a row that never stored it;
 *   2. /api/aiflows/send-owner-email loads that row, hands the `thread`
 *      argument to sendFromMailboxConnection, and CLAIMS the thread, so the
 *      autonomous email coworker owns every later message on it.
 *
 * That last call is the hinge of the whole feature. Without it the coworker's
 * ownership filter still excludes the thread and turn two goes back to paging
 * a human.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/email/owner-mailbox", () => ({ sendFromMailboxConnection: vi.fn() }));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({ getWorkspaceOAuthConnection: vi.fn() }));
vi.mock("@/lib/email-coworker/threads", () => ({ rememberSentThread: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/db/email-log", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  recordOutboundAssistantEmail: vi.fn()
}));

import { recordInboundTriggerEmail } from "@/lib/db/email-log";
import { getEmailLogThreadIdentity } from "@/lib/db/email-log";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

type Captured = { insert?: Record<string, unknown> };

function fakeDb(captured: Captured, selectRow: Record<string, unknown> | null = null) {
  const builder: Record<string, unknown> = {};
  for (const m of ["select", "eq", "order", "limit"]) {
    builder[m] = vi.fn(() => builder);
  }
  builder.insert = vi.fn((row: Record<string, unknown>) => {
    captured.insert = row;
    // recordInboundTriggerEmail now returns the new row id, so the insert
    // chain continues into .select().single().
    return {
      select: () => ({ single: () => Promise.resolve({ data: { id: "elog-1" }, error: null }) })
    };
  });
  builder.maybeSingle = vi.fn(() => Promise.resolve({ data: selectRow, error: null }));
  return { from: vi.fn(() => builder) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("an inbound trigger email keeps what a reply needs", () => {
  it("persists the provider thread id and the RFC Message-Id", async () => {
    const captured: Captured = {};
    await recordInboundTriggerEmail(
      {
        businessId: BIZ,
        fromEmail: "james@kypads.com",
        subject: "Introductions",
        bodyText: "Brian, King - connecting you two.",
        runId: null,
        flowId: "f1",
        providerMessageId: "m1",
        threadId: "199abc4d5e6f7890",
        messageRef: "<CAJ=intro@mail.gmail.com>"
      },
      fakeDb(captured)
    );
    expect(captured.insert).toMatchObject({
      provider_message_id: "m1",
      thread_id: "199abc4d5e6f7890",
      message_ref: "<CAJ=intro@mail.gmail.com>"
    });
  });

  it("writes nulls rather than empty strings when the provider gave neither", async () => {
    // A blank identifier is worse than a missing one: it reads as real and
    // threads a reply against nothing.
    const captured: Captured = {};
    await recordInboundTriggerEmail(
      {
        businessId: BIZ,
        fromEmail: "a@b.c",
        subject: "s",
        bodyText: "body",
        runId: null,
        flowId: "f1",
        providerMessageId: "m2"
      },
      fakeDb(captured)
    );
    expect(captured.insert).toMatchObject({ thread_id: null, message_ref: null });
  });
});

describe("the reply target resolves to a threadable identity", () => {
  it("reads back the thread id and Message-Id for an email_log row", async () => {
    const row = {
      id: "e1",
      thread_id: "199abc4d5e6f7890",
      message_ref: "<CAJ=intro@mail.gmail.com>",
      provider_message_id: "m1"
    };
    const identity = await getEmailLogThreadIdentity(BIZ, "e1", fakeDb({}, row));
    expect(identity).toEqual({
      threadId: "199abc4d5e6f7890",
      inReplyToMessageRef: "<CAJ=intro@mail.gmail.com>",
      providerMessageId: "m1",
      replyAllRecipients: []
    });
  });

  it("answers null for a row that never stored a thread, so the send stays unthreaded", async () => {
    const identity = await getEmailLogThreadIdentity(
      BIZ,
      "e2",
      fakeDb({}, { id: "e2", thread_id: null, message_ref: null, provider_message_id: "m2" })
    );
    expect(identity).toBeNull();
  });

  it("answers null for a row that does not exist rather than throwing", async () => {
    expect(await getEmailLogThreadIdentity(BIZ, "gone", fakeDb({}, null))).toBeNull();
  });

  it("answers null on a read failure, so a threading problem never blocks the send", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = {
      from: vi.fn(() => {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) b[m] = vi.fn(() => b);
        b.maybeSingle = vi.fn(() => Promise.resolve({ data: null, error: { message: "rls" } }));
        return b;
      })
    } as never;
    expect(await getEmailLogThreadIdentity(BIZ, "e3", failing)).toBeNull();
    expect(err).toHaveBeenCalledWith("getEmailLogThreadIdentity", "rls");
    err.mockRestore();
  });

  it("falls back to the service client when the caller passes none", async () => {
    const row = { id: "e4", thread_id: "t4", message_ref: null, provider_message_id: null };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(fakeDb({}, row));
    // A row with only a thread id still threads: Gmail files by threadId, and
    // the other two fields are additive.
    expect(await getEmailLogThreadIdentity(BIZ, "e4")).toEqual({
      threadId: "t4",
      replyAllRecipients: []
    });
  });
});

describe("a reply reaches everyone who was on the original", () => {
  it("returns the To and Cc addresses, deduped and without display names", () => {
    // The exemplar: James introduces Brian and King. James is From; King is
    // only on To. A reply addressed to From alone reaches the person who did
    // the favor and never the lead.
    const row = {
      id: "e5",
      thread_id: "t5",
      message_ref: null,
      provider_message_id: null,
      to_email: "Brian Lane <brian@newcoworker.com>, King <king@clinic.example.com>",
      cc_email: "king@clinic.example.com"
    };
    return getEmailLogThreadIdentity(BIZ, "e5", fakeDb({}, row)).then((identity) => {
      expect(identity?.replyAllRecipients).toEqual([
        "brian@newcoworker.com",
        "king@clinic.example.com"
      ]);
    });
  });

  it("ignores header junk that is not an address", () => {
    const row = {
      id: "e6",
      thread_id: "t6",
      message_ref: null,
      provider_message_id: null,
      to_email: "undisclosed-recipients:;, , real@example.com",
      cc_email: null
    };
    return getEmailLogThreadIdentity(BIZ, "e6", fakeDb({}, row)).then((identity) => {
      expect(identity?.replyAllRecipients).toEqual(["real@example.com"]);
    });
  });
});

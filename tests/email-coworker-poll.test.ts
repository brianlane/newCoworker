/**
 * The email coworker's poll and its rails: owned threads only, never
 * answering the mailbox's own mail, seen-before-turn (so a crash cannot
 * double-answer), and the daily turn budget that hands a circling thread
 * to a human.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/voice-tools/connections", () => ({ resolveEmailConnection: vi.fn() }));
vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn(), recordFailure: vi.fn() }));
vi.mock("@/lib/email-coworker/mailbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-coworker/mailbox")>()),
  fetchInboxWithThreads: vi.fn(),
  fetchMailboxAddress: vi.fn()
}));
vi.mock("@/lib/email-coworker/threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/email-coworker/threads")>()),
  listActiveThreads: vi.fn(),
  filterUnseenMessages: vi.fn(),
  claimMessage: vi.fn(),
  markThreadHandedOff: vi.fn(),
  recordThreadTurn: vi.fn()
}));
vi.mock("@/lib/email-coworker/turn", () => ({ runEmailCoworkerTurn: vi.fn() }));
vi.mock("@/lib/db/email-log", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/db/email-log")>()),
  threadsAnsweredByFlow: vi.fn()
}));
vi.mock("@/lib/outreach/reply", () => ({ noteProspectReply: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { pollEmailCoworker, isSelfSender } from "@/lib/email-coworker/poll";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveEmailConnection } from "@/lib/voice-tools/connections";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { recordFailure, recordSystemLog } from "@/lib/db/system-logs";
import { fetchInboxWithThreads, fetchMailboxAddress } from "@/lib/email-coworker/mailbox";
import {
  EMAIL_COWORKER_MAX_TURNS_PER_DAY,
  filterUnseenMessages,
  listActiveThreads,
  claimMessage,
  markThreadHandedOff,
  recordThreadTurn
} from "@/lib/email-coworker/threads";
import { runEmailCoworkerTurn } from "@/lib/email-coworker/turn";
import { threadsAnsweredByFlow } from "@/lib/db/email-log";
import { noteProspectReply } from "@/lib/outreach/reply";

const BIZ = "11111111-1111-4111-8111-111111111111";
/** The dashboard login, which need NOT be the connected mailbox. */
const OWNER_EMAIL = "founder@newcoworker.com";
/** The mailbox the assistant actually corresponds from. */
const MAILBOX_EMAIL = "team@newcoworker.com";

const mockClientFactory = vi.mocked(createSupabaseServiceClient);
const mockConn = vi.mocked(resolveEmailConnection);
const mockDispatch = vi.mocked(dispatchUrgentNotification);
const mockSystemLog = vi.mocked(recordSystemLog);
const mockRecordFailure = vi.mocked(recordFailure);
const mockFetch = vi.mocked(fetchInboxWithThreads);
const mockMailboxAddress = vi.mocked(fetchMailboxAddress);
const mockList = vi.mocked(listActiveThreads);
const mockUnseen = vi.mocked(filterUnseenMessages);
const mockClaim = vi.mocked(claimMessage);
const mockHandoff = vi.mocked(markThreadHandedOff);
const mockRecordTurn = vi.mocked(recordThreadTurn);
const mockTurn = vi.mocked(runEmailCoworkerTurn);
const mockNoteReply = vi.mocked(noteProspectReply);

const THREAD = {
  id: "row-1",
  businessId: BIZ,
  provider: "google" as const,
  threadId: "thread-9",
  subject: "NC Discovery Call w/ Liz",
  correspondentEmail: "beth@lizdev.com",
  lastSentMessageRef: null,
  turns: 0,
  turnsDay: null,
  handedOff: false
};

function message(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "m-1",
    threadId: "thread-9",
    fromEmail: "beth@lizdev.com",
    subject: "Re: NC Discovery Call w/ Liz",
    bodyText: "Monday at 12:00 PM EST works.",
    messageRef: "<beth-1@mail>",
    ...over
  } as never;
}

/** businesses lookups (owner_email, timezone) the poll makes per business. */
function businessDb() {
  const maybeSingle = vi
    .fn()
    .mockResolvedValue({ data: { owner_email: OWNER_EMAIL, timezone: "America/Phoenix" } });
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  return { from: vi.fn(() => ({ select })) } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockClientFactory.mockResolvedValue(businessDb());
  mockConn.mockResolvedValue({
    provider: "google",
    connectionId: "c-1",
    providerConfigKey: "google"
  } as never);
  // A FRESH copy per test: the poll updates the thread's in-pass turn
  // count in place (so several replies in one pass spend one budget), and
  // a shared object would leak that mutation into the next test.
  mockList.mockResolvedValue([{ ...THREAD }]);
  mockFetch.mockResolvedValue([message()]);
  mockMailboxAddress.mockResolvedValue(MAILBOX_EMAIL);
  mockUnseen.mockImplementation(async (_biz, ids) => ids);
  vi.mocked(threadsAnsweredByFlow).mockResolvedValue(new Set());
  mockClaim.mockResolvedValue(true);
  mockHandoff.mockResolvedValue(undefined);
  mockRecordTurn.mockResolvedValue(undefined);
  mockTurn.mockResolvedValue({ ok: true, reply: "Booked.", handoff: false, sent: true });
  mockNoteReply.mockResolvedValue("not_a_prospect");
  mockDispatch.mockResolvedValue({ results: [] } as never);
  mockSystemLog.mockResolvedValue(undefined as never);
  mockRecordFailure.mockResolvedValue("warn" as never);
});

describe("pollEmailCoworker", () => {
  it("answers a reply on an owned thread and counts the turn", async () => {
    const out = await pollEmailCoworker(businessDb());
    expect(out).toMatchObject({ businesses: 1, threads: 1, messages: 1, replied: 1, handedOff: 0 });
    expect(mockTurn).toHaveBeenCalledTimes(1);
    const args = mockTurn.mock.calls[0][0];
    expect(args.thread.threadId).toBe("thread-9");
    expect(args.businessTimezone).toBe("America/Phoenix");
    expect(mockRecordTurn).toHaveBeenCalledWith("row-1", {}, 0, expect.anything());
  });

  it("tells the outreach ledger about the reply, so no follow-up talks over it", async () => {
    // A cold-outreach prospect answering has to be recorded before the next
    // Prospecting sweep, which otherwise chases them purely on silence.
    await pollEmailCoworker(businessDb());
    // Both the sender AND the address we originally mailed, because people
    // answer from a different mailbox than the one on their website.
    expect(mockNoteReply).toHaveBeenCalledWith(
      BIZ,
      ["beth@lizdev.com", "beth@lizdev.com"],
      "Monday at 12:00 PM EST works.",
      expect.anything()
    );
  });

  it("is a cheap no-op when no business owns an active thread", async () => {
    mockList.mockResolvedValue([]);
    expect(await pollEmailCoworker(businessDb())).toEqual({
      businesses: 0,
      threads: 0,
      messages: 0,
      replied: 0,
      handedOff: 0
    });
    expect(mockConn).not.toHaveBeenCalled();
  });

  it("ignores mail outside the owned threads (the whole safety model)", async () => {
    mockFetch.mockResolvedValue([
      message({ id: "m-other", threadId: "some-newsletter" }),
      message({ id: "m-no-thread", threadId: "" })
    ]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.messages).toBe(0);
    expect(mockTurn).not.toHaveBeenCalled();
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("never auto-answers a conversation we have already replied to", async () => {
    /**
     * Live, Aug 10 2026. The triage flow replied to James's introduction and
     * CLAIMED the thread, which retroactively made the triggering message
     * eligible here: still inside the lookback window, now on an owned thread,
     * never seen by the coworker itself. James got the flow's reply at 10:26
     * and an off-script second one at 10:27.
     *
     * Keyed on the THREAD on Brian's instruction: once we have written on a
     * conversation, every further reply goes through the flow's approval gate
     * instead of out unseen. Gating the first email to a stranger and then
     * sending the rest unread is not what an approval is for.
     */
    vi.mocked(threadsAnsweredByFlow).mockResolvedValue(new Set(["thread-9"]));
    mockFetch.mockResolvedValue([message({ id: "m-1", threadId: "thread-9" })]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.messages).toBe(0);
    expect(mockTurn).not.toHaveBeenCalled();
    // Not merely unanswered: it must not be claimed either, or the coworker
    // would record a turn it never took.
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("still carries a thread it owns, turn after turn", async () => {
    // The guard must not silence the coworker on its OWN conversations. Its
    // replies are outbound too, so a rule keyed on "any outbound row" would
    // have stopped it after its first answer and broken the multi-turn budget
    // the whole surface is built around.
    vi.mocked(threadsAnsweredByFlow).mockResolvedValue(new Set(["other-thread"]));
    mockFetch.mockResolvedValue([message({ id: "m-2", threadId: "thread-9" })]);
    await pollEmailCoworker(businessDb());
    expect(mockTurn).toHaveBeenCalledTimes(1);
    expect(mockTurn.mock.calls[0][0].message.id).toBe("m-2");
  });

  it("never answers the CONNECTED MAILBOX's own message (no talking to itself)", async () => {
    // The mailbox address, not the dashboard login: HQ signs in as one
    // address and corresponds from another, and using the login alone let
    // the coworker answer its own sent copy.
    mockFetch.mockResolvedValue([message({ fromEmail: MAILBOX_EMAIL.toUpperCase() })]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.messages).toBe(0);
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it("also treats the dashboard login as us, and survives an unreadable profile", async () => {
    mockFetch.mockResolvedValue([message({ fromEmail: OWNER_EMAIL })]);
    expect((await pollEmailCoworker(businessDb())).messages).toBe(0);

    // Provider refuses the profile: the login fallback still guards.
    mockMailboxAddress.mockRejectedValue(new Error("scope missing"));
    mockFetch.mockResolvedValue([message({ fromEmail: OWNER_EMAIL })]);
    expect((await pollEmailCoworker(businessDb())).messages).toBe(0);

    // Null profile + a genuine correspondent still gets answered.
    mockMailboxAddress.mockResolvedValue(null);
    mockFetch.mockResolvedValue([message()]);
    expect((await pollEmailCoworker(businessDb())).replied).toBe(1);
  });

  it("skips messages already evaluated", async () => {
    mockUnseen.mockResolvedValue([]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.messages).toBe(0);
    expect(mockTurn).not.toHaveBeenCalled();
  });

  it("claims each message immediately BEFORE its own turn", async () => {
    // Per message, not per batch: a pass that dies partway must leave the
    // replies it never reached unclaimed so a later tick still answers them.
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    const order: string[] = [];
    mockClaim.mockImplementation(async (_biz, id) => {
      order.push(`claim:${id}`);
      return true;
    });
    mockTurn.mockImplementation(async ({ message: m }) => {
      order.push(`turn:${m.id}`);
      return { ok: true, reply: "ok", handoff: false, sent: true };
    });
    await pollEmailCoworker(businessDb());
    expect(order).toEqual(["claim:m-1", "turn:m-1", "claim:m-2", "turn:m-2"]);
  });

  it("leaves later replies unclaimed when a turn throws mid-batch", async () => {
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    mockTurn.mockRejectedValueOnce(new Error("engine exploded"));
    await pollEmailCoworker(businessDb());
    // Only the message we actually attempted was consumed.
    expect(mockClaim.mock.calls.map((c) => c[1])).toEqual(["m-1"]);
  });

  it("skips a message another overlapping pass already claimed", async () => {
    // The claim is atomic, so the loser of the race must not also answer.
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    mockClaim.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(1);
    expect(mockTurn.mock.calls.map((c) => c[0].message.id)).toEqual(["m-2"]);
  });

  it("hands a circling thread to a human at the daily cap and alerts the owner once", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockList.mockResolvedValue([
      { ...THREAD, turns: EMAIL_COWORKER_MAX_TURNS_PER_DAY, turnsDay: today }
    ]);
    const out = await pollEmailCoworker(businessDb());
    expect(out).toMatchObject({ replied: 0, handedOff: 1 });
    expect(mockTurn).not.toHaveBeenCalled();
    expect(mockHandoff).toHaveBeenCalledWith("row-1", expect.anything());
    expect(mockDispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "email_coworker_handoff" })
    );
  });

  it("alerts the owner ONCE when a batch carries several replies on a capped thread", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockList.mockResolvedValue([
      { ...THREAD, turns: EMAIL_COWORKER_MAX_TURNS_PER_DAY, turnsDay: today }
    ]);
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.handedOff).toBe(1);
    expect(mockHandoff).toHaveBeenCalledTimes(1);
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("leaves the rest of a batch alone once a thread is handed off, but still claims it", async () => {
    mockList.mockResolvedValue([{ ...THREAD, handedOff: true }]);
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(0);
    expect(mockTurn).not.toHaveBeenCalled();
    // The claim still lands: a thread a human took over must not get an
    // automated answer from the AiFlow side either.
    expect(mockClaim.mock.calls.map((c) => c[1])).toEqual(["m-1", "m-2"]);
  });

  it("still hands off when the owner alert itself fails, and names a subject-less thread", async () => {
    const today = new Date().toISOString().slice(0, 10);
    mockList.mockResolvedValue([
      { ...THREAD, subject: null, turns: EMAIL_COWORKER_MAX_TURNS_PER_DAY, turnsDay: today }
    ]);
    mockDispatch.mockRejectedValue(new Error("smtp down"));
    const out = await pollEmailCoworker(businessDb());
    expect(out.handedOff).toBe(1);
    expect(mockHandoff).toHaveBeenCalled();
    const alert = mockDispatch.mock.calls[0][0];
    expect(alert.summary).toContain("(no subject)");
    expect(String(alert.emailBody)).toContain("(no subject)");
    expect(String(alert.smsBody)).toContain("(no subject)");
  });

  it("spends the budget across several replies in ONE pass", async () => {
    // Two replies land on the same thread between ticks: the second must
    // count against the first's spend, not restart from zero.
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    await pollEmailCoworker(businessDb());
    expect(mockRecordTurn.mock.calls.map((c) => c[2])).toEqual([0, 1]);
  });

  it("yesterday's turns do not count against today's budget", async () => {
    mockList.mockResolvedValue([
      { ...THREAD, turns: EMAIL_COWORKER_MAX_TURNS_PER_DAY, turnsDay: "2020-01-01" }
    ]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(1);
    expect(mockHandoff).not.toHaveBeenCalled();
  });

  it("keeps the reply when the turn-count write fails (already sent)", async () => {
    // The mail is out: aborting here would both lose the count and skip the
    // remaining businesses, so the failure is logged and the pass continues.
    // Both throw shapes, since a driver can reject with a bare string.
    mockRecordTurn.mockRejectedValueOnce(new Error("update denied"));
    expect((await pollEmailCoworker(businessDb())).replied).toBe(1);

    mockRecordTurn.mockRejectedValueOnce("update denied");
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(1);
    expect(mockRecordFailure).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_coworker_poll_failed" })
    );
  });

  it("hands the thread over when the turn escalates, alerting the owner once", async () => {
    mockFetch.mockResolvedValue([message({ id: "m-1" }), message({ id: "m-2" })]);
    mockTurn.mockResolvedValueOnce({ ok: true, reply: "A colleague will follow up.", handoff: true, sent: true });
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(1);
    expect(out.handedOff).toBe(1);
    // The escalation reply went out, then the thread changed hands: the
    // second message in the batch gets no autonomous turn.
    expect(mockTurn).toHaveBeenCalledTimes(1);
    expect(mockHandoff).toHaveBeenCalledWith("row-1", expect.anything());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
    expect(mockDispatch.mock.calls[0][0].payload).toMatchObject({ reason: "escalated" });
  });

  it("hands over a sentinel-only escalation without counting a reply or a turn", async () => {
    mockTurn.mockResolvedValue({ ok: true, reply: "", handoff: true, sent: false });
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(0);
    expect(out.handedOff).toBe(1);
    expect(mockRecordTurn).not.toHaveBeenCalled();
    expect(mockHandoff).toHaveBeenCalledWith("row-1", expect.anything());
    expect(mockDispatch).toHaveBeenCalledTimes(1);
  });

  it("still hands over when the escalation bookkeeping fails", async () => {
    mockTurn.mockResolvedValue({ ok: true, reply: "A colleague will follow up.", handoff: true, sent: true });
    mockHandoff.mockRejectedValueOnce(new Error("update denied"));
    mockDispatch.mockRejectedValue(new Error("smtp down"));
    expect((await pollEmailCoworker(businessDb())).handedOff).toBe(1);

    // Non-Error throw shape, and a subject-less thread in the alert copy.
    mockList.mockResolvedValue([{ ...THREAD, subject: null }]);
    mockHandoff.mockRejectedValueOnce("update denied");
    const out = await pollEmailCoworker(businessDb());
    expect(out.handedOff).toBe(1);
    const alert = mockDispatch.mock.calls.at(-1)![0];
    expect(alert.summary).toContain("(no subject)");
    expect(String(alert.emailBody)).toContain("(no subject)");
    expect(String(alert.smsBody)).toContain("(no subject)");
  });

  it("logs a failed turn and moves on", async () => {
    mockTurn.mockResolvedValue({ ok: false, detail: "over_cap" });
    const out = await pollEmailCoworker(businessDb());
    expect(out.replied).toBe(0);
    expect(mockSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_coworker_turn_failed" })
    );
  });

  it("skips a business whose mailbox is disconnected", async () => {
    mockConn.mockResolvedValue(null as never);
    const out = await pollEmailCoworker(businessDb());
    expect(out.businesses).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(out.replied).toBe(0);
  });

  it("isolates a per-business failure so other businesses still run", async () => {
    const other = { ...THREAD, id: "row-2", businessId: "22222222-2222-4222-8222-222222222222" };
    mockList.mockResolvedValue([THREAD, other]);
    mockFetch
      .mockRejectedValueOnce(new Error("mailbox on fire"))
      .mockResolvedValueOnce([message()]);
    const out = await pollEmailCoworker(businessDb());
    expect(out.businesses).toBe(2);
    expect(out.replied).toBe(1);
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({ event: "email_coworker_poll_failed" })
    );
  });

  it("tolerates a non-Error throw and unreadable business metadata", async () => {
    mockFetch.mockRejectedValueOnce("string boom");
    await pollEmailCoworker(businessDb());
    expect(mockRecordFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "email_coworker_poll_failed",
        message: expect.stringContaining("string boom")
      })
    );

    // owner_email / timezone reads that throw must not stop the reply.
    vi.clearAllMocks();
    mockConn.mockResolvedValue({
      provider: "google",
      connectionId: "c-1",
      providerConfigKey: "google"
    } as never);
    mockList.mockResolvedValue([{ ...THREAD }]);
    mockFetch.mockResolvedValue([message()]);
    mockUnseen.mockImplementation(async (_biz, ids) => ids);
    mockTurn.mockResolvedValue({ ok: true, reply: "ok", handoff: false, sent: true });
    const throwingDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockRejectedValue(new Error("no row"))
          }))
        }))
      }))
    } as never;
    const out = await pollEmailCoworker(throwingDb);
    expect(out.replied).toBe(1);
    expect(mockTurn.mock.calls[0][0].businessTimezone).toBeNull();
  });

  it("reads non-string metadata as absent", async () => {
    const oddDb = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn().mockResolvedValue({ data: { owner_email: 42, timezone: "  " } })
          }))
        }))
      }))
    } as never;
    const out = await pollEmailCoworker(oddDb);
    expect(out.replied).toBe(1);
    expect(mockTurn.mock.calls[0][0].businessTimezone).toBeNull();
  });

  it("falls back to the service client", async () => {
    mockList.mockResolvedValue([]);
    await pollEmailCoworker();
    expect(mockClientFactory).toHaveBeenCalled();
  });
});

describe("isSelfSender: the coworker must not answer its own mail", () => {
  /**
   * Live, Aug 7 2026. HQ signs in as newcoworkerteam@gmail.com and
   * corresponds from the send-as alias team@newcoworker.com. The Cloudflare
   * catch-all forwards that alias back into the same mailbox, so a reply
   * arrives as genuinely RECEIVED mail on a thread the coworker owns, and it
   * answered itself.
   *
   * Both sources feeding `selfAddresses` return the ACCOUNT address here (the
   * Gmail profile and businesses.owner_email, verified against production),
   * so plain set membership could never have caught the alias.
   */
  const OURS = new Set(["newcoworkerteam@gmail.com"]);

  it("catches the send-as alias that neither self-address source reports", () => {
    expect(isSelfSender("team@newcoworker.com", OURS)).toBe(true);
    expect(isSelfSender("contact@newcoworker.com", OURS)).toBe(true);
    expect(isSelfSender("  Team@NewCoworker.com  ", OURS)).toBe(true);
  });

  it("still catches the addresses the set does know", () => {
    expect(isSelfSender("newcoworkerteam@gmail.com", OURS)).toBe(true);
  });

  it("never swallows a real correspondent, which is the worse failure", () => {
    expect(isSelfSender("james@kypads.com", OURS)).toBe(false);
    expect(isSelfSender("fullvanair@gmail.com", OURS)).toBe(false);
    // Suffix matching would be a real bug: these are not our domain.
    expect(isSelfSender("someone@notnewcoworker.com", OURS)).toBe(false);
    expect(isSelfSender("someone@newcoworker.com.evil.test", OURS)).toBe(false);
  });

  it("degrades safely on junk", () => {
    expect(isSelfSender("", OURS)).toBe(false);
    expect(isSelfSender("   ", OURS)).toBe(false);
    expect(isSelfSender("not-an-address", OURS)).toBe(false);
    // An empty set still leaves the domain rule working.
    expect(isSelfSender("team@newcoworker.com", new Set())).toBe(true);
  });
});

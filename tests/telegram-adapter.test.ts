import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Telegram's entry in the shared coworker queue.
 *
 * The turn assembly is `runOwnerSurfaceTurn` and is tested there; the queue
 * mechanics are the shared worker's and are tested there. What is pinned
 * here is what Telegram does with each verdict, and the identity check that
 * runs immediately before the turn.
 *
 * That re-check is the interesting part. A binding can be removed, or a
 * roster row deactivated, between a message arriving and its turn running,
 * and a former teammate must lose their powers at the second boundary as
 * well as the first.
 */

vi.mock("@/lib/db/coworker-chat", () => ({
  completeCoworkerJob: vi.fn(),
  failCoworkerJob: vi.fn(),
  getCoworkerConversationById: vi.fn(),
  listCoworkerMessages: vi.fn()
}));
vi.mock("@/lib/db/coworker-connections", () => ({ getActiveCoworkerConnection: vi.fn() }));
vi.mock("@/lib/db/coworker-identities", () => ({ findChannelIdentity: vi.fn() }));
vi.mock("@/lib/coworker-channels/tier-gate", () => ({
  coworkerChannelAllowedForBusiness: vi.fn()
}));
vi.mock("@/lib/owner-surfaces/run-turn", () => ({ runOwnerSurfaceTurn: vi.fn() }));
vi.mock("@/lib/owner-surfaces/speaker", () => ({ resolveSurfaceSpeaker: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/telegram/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/telegram/client")>()),
  telegramSendMessage: vi.fn()
}));
vi.mock("@/lib/dashboard-chat/email-blocks", () => ({ fulfillOwnerEmailBlocks: vi.fn() }));
vi.mock("@/lib/dashboard-chat/schedule-memory-capture", () => ({
  scheduleCaptureOwnerRuleInline: vi.fn()
}));
vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn(async () => "en")
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { telegramChannelAdapter } from "@/lib/telegram/adapter";
import {
  completeCoworkerJob,
  failCoworkerJob,
  getCoworkerConversationById,
  listCoworkerMessages
} from "@/lib/db/coworker-chat";
import { getActiveCoworkerConnection } from "@/lib/db/coworker-connections";
import { findChannelIdentity } from "@/lib/db/coworker-identities";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { runOwnerSurfaceTurn } from "@/lib/owner-surfaces/run-turn";
import { resolveSurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { getBusiness } from "@/lib/db/businesses";
import { telegramSendMessage } from "@/lib/telegram/client";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";

const BIZ = "11111111-1111-4111-8111-111111111111";

const JOB = {
  id: "job-1",
  business_id: BIZ,
  channel: "telegram" as const,
  conversation_id: "conv-1",
  attempts: 1
};

const CONVERSATION = {
  id: "conv-1",
  business_id: BIZ,
  channel: "telegram",
  external_conversation_id: "4242",
  external_user_id: "4242",
  user_display_name: "Dana Ruiz",
  thread_key: null
};

const HISTORY = [
  { id: 5, role: "assistant", content: "earlier reply" },
  { id: 7, role: "user", content: "how many leads today?" }
];

const run = () => telegramChannelAdapter.runJob(JOB as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoworkerConversationById).mockResolvedValue(CONVERSATION as never);
  vi.mocked(getActiveCoworkerConnection).mockResolvedValue({
    business_id: BIZ,
    credential: "123:AA",
    is_active: true
  } as never);
  vi.mocked(getBusiness).mockResolvedValue({
    id: BIZ,
    owner_email: "owner@x.co",
    timezone: "America/Toronto",
    tier: "standard"
  } as never);
  vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(listCoworkerMessages).mockResolvedValue(HISTORY as never);
  vi.mocked(findChannelIdentity).mockResolvedValue({
    is_owner: true,
    verified_phone_e164: "+15145188192",
    employee_id: null
  } as never);
  vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
    kind: "owner",
    name: "Amy",
    readFailed: false
  });
  vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
    kind: "reply",
    reply: "Four today.",
    unclipped: "Four today."
  });
  vi.mocked(telegramSendMessage).mockResolvedValue({ messageId: "99", chatId: "4242" });
  vi.mocked(fulfillOwnerEmailBlocks).mockImplementation(
    async ({ content }) => ({ content }) as never
  );
});

describe("the happy path", () => {
  it("answers, then commits the job atomically", async () => {
    expect(await run()).toBe(true);
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("Four today.");
    expect(completeCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ jobId: "job-1", content: "Four today.", externalTs: "99" })
    );
  });

  it("escapes the reply before sending it under HTML parse mode", async () => {
    // An unescaped `<` makes Telegram reject the whole message, which loses
    // the answer rather than garbling it.
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "reply",
      reply: "Dana <dana@x.co> asked",
      unclipped: "Dana <dana@x.co> asked"
    });
    await run();
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("&lt;dana@x.co&gt;");
  });

  it("fulfils EMAIL_SEND against the UNCLIPPED answer, then clips", async () => {
    // Clipping first can cut a block into an unparseable fragment that then
    // reaches the owner as raw JSON.
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "reply",
      reply: "short",
      unclipped: "the whole thing"
    });
    await run();
    expect(fulfillOwnerEmailBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ content: "the whole thing", source: "telegram_assistant" })
    );
  });

  it("captures durable owner rules, but only from the owner", async () => {
    await run();
    expect(scheduleCaptureOwnerRuleInline).toHaveBeenCalled();

    vi.clearAllMocks();
    vi.mocked(getCoworkerConversationById).mockResolvedValue(CONVERSATION as never);
    vi.mocked(getActiveCoworkerConnection).mockResolvedValue({
      business_id: BIZ,
      credential: "123:AA",
      is_active: true
    } as never);
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
    vi.mocked(listCoworkerMessages).mockResolvedValue(HISTORY as never);
    vi.mocked(findChannelIdentity).mockResolvedValue({ is_owner: false } as never);
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "teammate",
      name: "Dana",
      readFailed: false
    });
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "reply",
      reply: "ok",
      unclipped: "ok"
    });
    vi.mocked(telegramSendMessage).mockResolvedValue({ messageId: "1", chatId: "4242" });
    await run();
    expect(scheduleCaptureOwnerRuleInline).not.toHaveBeenCalled();
    // A teammate's answer never goes through owner email fulfilment either.
    expect(fulfillOwnerEmailBlocks).not.toHaveBeenCalled();
  });
});

describe("who is speaking is re-checked at turn time", () => {
  it("passes BOTH the binding's verified phone and the account reference", async () => {
    // Load-bearing, not belt-and-braces. A teammate who enrolled by sharing
    // a contact card has a binding with the phone and NO employee id, so
    // the roster is consulted fresh every turn. externalRef alone would
    // resolve that person to a stranger; the phone alone would miss anyone
    // who enrolled with a code.
    await run();
    expect(resolveSurfaceSpeaker).toHaveBeenCalledWith(BIZ, {
      phoneE164: "+15145188192",
      externalRef: { channel: "telegram", externalUserId: "4242" }
    });
  });

  it("says nothing and stops retrying when the binding is gone", async () => {
    vi.mocked(findChannelIdentity).mockResolvedValue(null);
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "customer",
      name: null,
      readFailed: false
    });
    expect(await run()).toBe(false);
    expect(telegramSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "not_linked", terminal: true })
    );
  });

  it("keeps a FAILED READ retryable, unlike a removed binding", async () => {
    // A removed binding cannot change on a retry; an unreadable roster can.
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "customer",
      name: null,
      readFailed: true
    });
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "identity_unreadable", terminal: false })
    );
  });
});

describe("verdicts that are not a reply", () => {
  it("posts the over-cap line and closes the job as done", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({ kind: "over_cap" });
    expect(await run()).toBe(true);
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("limit");
    expect(completeCoworkerJob).toHaveBeenCalled();
  });

  it("says NOTHING when the owner switched the surface off", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "silent",
      reason: "staff_mode_off"
    });
    expect(await run()).toBe(false);
    expect(telegramSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "staff_mode_off", terminal: true })
    );
  });

  it("stays silent on a terminal failure rather than answering a non-question", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      detail: "no_input",
      code: "no_input",
      terminal: true
    });
    expect(await run()).toBe(false);
    expect(telegramSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_input", terminal: true })
    );
  });

  it("requeues a retryable failure without posting anything", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      detail: "upstream 503",
      code: "model_failed"
    });
    expect(await run()).toBe(false);
    expect(telegramSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "model_failed", terminal: false })
    );
  });

  it("apologises once on the LAST attempt, instead of failing silently forever", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      detail: "boom",
      code: "model_failed"
    });
    expect(await telegramChannelAdapter.runJob({ ...JOB, attempts: 3 } as never)).toBe(false);
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("went wrong");
    expect(completeCoworkerJob).toHaveBeenCalled();
  });

  it("requeues when Telegram refuses the finished answer", async () => {
    vi.mocked(telegramSendMessage).mockRejectedValue(new Error("chat not found"));
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "post_failed", terminal: false })
    );
  });
});

describe("things that stop the job before a turn", () => {
  it("errors terminally when the conversation is gone", async () => {
    vi.mocked(getCoworkerConversationById).mockResolvedValue(null);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "conversation_missing", terminal: true })
    );
  });

  it("errors terminally when the connection is gone or paused", async () => {
    vi.mocked(getActiveCoworkerConnection).mockResolvedValue(null);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_connection", terminal: true })
    );
  });

  it("posts an honest line on a starter tenant, because silence reads as broken", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await run()).toBe(false);
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("Standard");
    expect(completeCoworkerJob).toHaveBeenCalled();
    expect(runOwnerSurfaceTurn).not.toHaveBeenCalled();
  });

  it("delivers anyway when the tier check itself is down", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue(new Error("db down"));
    expect(await run()).toBe(true);
  });

  it("falls back to English when the locale lookup itself fails", async () => {
    vi.mocked(resolveOwnerUiLocaleForEmail).mockRejectedValue(new Error("locale down"));
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await run()).toBe(false);
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("Standard");
  });

  it("handles an entirely empty history without a phantom cutoff", async () => {
    vi.mocked(listCoworkerMessages).mockResolvedValue([] as never);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_user_message", terminal: true })
    );
  });

  it("labels an unnamed speaker without a dangling space", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "owner",
      name: null,
      readFailed: false
    });
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].userLabel).toBe(
      "Telegram from owner"
    );
  });

  it("errors terminally when the window holds no user message", async () => {
    vi.mocked(listCoworkerMessages).mockResolvedValue([
      { id: 1, role: "assistant", content: "only me" }
    ] as never);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_user_message", terminal: true })
    );
  });

  it("still runs when the business row cannot be read", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("biz down"));
    expect(await run()).toBe(true);
  });

  it("defaults the locale to English when there is no owner email on file", async () => {
    // No address means no stored UI language choice; guessing from anything
    // else would be guessing.
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, tier: "standard" } as never);
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await run()).toBe(false);
    expect(vi.mocked(telegramSendMessage).mock.calls[0][1].text).toContain("Standard");
  });
});

describe("what reaches the turn", () => {
  it("answers the newest user line and replays only what came before it", async () => {
    vi.mocked(listCoworkerMessages).mockResolvedValue([
      { id: 1, role: "user", content: "first" },
      { id: 2, role: "assistant", content: "answer" },
      { id: 3, role: "user", content: "second" },
      { id: 4, role: "assistant", content: "trailing" }
    ] as never);
    await run();
    const args = vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0];
    expect(args.history.map((m) => m.content)).toEqual(["first", "answer", "second"]);
    expect(args.surfaceKey).toBe("telegram");
  });

  it("hands over the business row it already read, sparing a second lookup", async () => {
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].businessMeta).toEqual({
      timezone: "America/Toronto",
      tier: "standard",
      ownerEmail: "owner@x.co"
    });
  });

  it("names the speaker by their display name, not their numeric id", async () => {
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].speakerRef).toBe("Dana Ruiz");
  });

  it("falls back to the account id when Telegram gave no name", async () => {
    vi.mocked(getCoworkerConversationById).mockResolvedValue({
      ...CONVERSATION,
      user_display_name: null
    } as never);
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].speakerRef).toBe("id:4242");
  });
});

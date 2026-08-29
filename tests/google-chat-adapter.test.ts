import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Chat's entry in the shared coworker queue.
 *
 * The turn assembly and the queue mechanics are tested where they live. What
 * is pinned here is the part specific to this channel: the answer goes back
 * into the THREAD the question was asked in, and the roster is re-checked at
 * turn time so a teammate deactivated between the message arriving and its
 * turn running loses their powers at the second boundary too.
 */

vi.mock("@/lib/db/coworker-chat", () => ({
  completeCoworkerJob: vi.fn(),
  failCoworkerJob: vi.fn(),
  getCoworkerConversationById: vi.fn(),
  listCoworkerMessages: vi.fn()
}));
vi.mock("@/lib/db/coworker-connections", () => ({ getActiveCoworkerConnection: vi.fn() }));
vi.mock("@/lib/coworker-channels/tier-gate", () => ({
  coworkerChannelAllowedForBusiness: vi.fn()
}));
vi.mock("@/lib/owner-surfaces/run-turn", () => ({ runOwnerSurfaceTurn: vi.fn() }));
vi.mock("@/lib/owner-surfaces/speaker", () => ({ resolveSurfaceSpeaker: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/google-chat/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/google-chat/client")>()),
  googleChatSendMessage: vi.fn()
}));
vi.mock("@/lib/dashboard-chat/email-blocks", () => ({ fulfillOwnerEmailBlocks: vi.fn() }));
vi.mock("@/lib/dashboard-chat/schedule-memory-capture", () => ({
  scheduleCaptureOwnerRuleInline: vi.fn()
}));
vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn(async () => "en")
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { googleChatChannelAdapter } from "@/lib/google-chat/adapter";
import {
  completeCoworkerJob,
  failCoworkerJob,
  getCoworkerConversationById,
  listCoworkerMessages
} from "@/lib/db/coworker-chat";
import { getActiveCoworkerConnection } from "@/lib/db/coworker-connections";
import { coworkerChannelAllowedForBusiness } from "@/lib/coworker-channels/tier-gate";
import { runOwnerSurfaceTurn } from "@/lib/owner-surfaces/run-turn";
import { resolveSurfaceSpeaker } from "@/lib/owner-surfaces/speaker";
import { getBusiness } from "@/lib/db/businesses";
import { googleChatSendMessage } from "@/lib/google-chat/client";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";
import { GOOGLE_CHAT_REPLY_MAX_CHARS } from "@/lib/google-chat/chat";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SPACE = "spaces/AAQA1234";
const THREAD = `${SPACE}/threads/T1`;

const JOB = {
  id: "job-1",
  business_id: BIZ,
  channel: "google_chat" as const,
  conversation_id: "conv-1",
  attempts: 1
};

const CONVERSATION = {
  id: "conv-1",
  business_id: BIZ,
  channel: "google_chat",
  external_conversation_id: SPACE,
  thread_key: THREAD,
  external_user_id: "users/108765",
  user_display_name: "Dana Ruiz",
  user_email: "dana@acme.com"
};

const HISTORY = [
  { id: 5, role: "assistant", content: "earlier reply" },
  { id: 7, role: "user", content: "how many leads today?" }
];

const run = (job: Partial<typeof JOB> = {}) =>
  googleChatChannelAdapter.runJob({ ...JOB, ...job } as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoworkerConversationById).mockResolvedValue(CONVERSATION as never);
  vi.mocked(getActiveCoworkerConnection).mockResolvedValue({
    business_id: BIZ,
    is_active: true,
    credential: "",
    external_workspace_id: SPACE
  } as never);
  vi.mocked(getBusiness).mockResolvedValue({
    id: BIZ,
    owner_email: "owner@acme.com",
    timezone: "America/Toronto",
    tier: "standard"
  } as never);
  vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(listCoworkerMessages).mockResolvedValue(HISTORY as never);
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
  vi.mocked(googleChatSendMessage).mockResolvedValue({
    messageName: `${SPACE}/messages/m9`,
    thread: THREAD
  });
  vi.mocked(fulfillOwnerEmailBlocks).mockImplementation(
    async ({ content }) => ({ content }) as never
  );
});

describe("the happy path", () => {
  it("answers INTO the thread the question was asked in", async () => {
    // A space-level reply to a threaded question reads as the app talking
    // over the top of whatever else is going on in the room.
    expect(await run()).toBe(true);
    const [target, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(target).toEqual({ space: SPACE, thread: THREAD });
    expect(message.text).toBe("Four today.");
    expect(completeCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "Four today.",
        externalTs: `${SPACE}/messages/m9`,
        historyMaxMessageId: 7
      })
    );
  });

  it("posts at space level for a conversation with no thread", async () => {
    vi.mocked(getCoworkerConversationById).mockResolvedValue({
      ...CONVERSATION,
      thread_key: null
    } as never);
    await run();
    expect(vi.mocked(googleChatSendMessage).mock.calls[0][0]).toEqual({
      space: SPACE,
      thread: null
    });
  });

  it("runs the turn on the google_chat surface, with the roster verdict", async () => {
    await run();
    expect(runOwnerSurfaceTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        surfaceKey: "google_chat",
        speakerLabel: "Owner",
        userLabel: "Google Chat from owner Amy"
      })
    );
  });

  it("labels a teammate as a teammate", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "teammate",
      name: "Dana",
      readFailed: false
    });
    await run();
    expect(runOwnerSurfaceTurn).toHaveBeenCalledWith(
      expect.objectContaining({ speakerLabel: "Teammate" })
    );
  });

  it("fulfils EMAIL_SEND against the UNCLIPPED answer, for the owner only", async () => {
    // Clipping first can cut a block into an unparseable fragment that
    // reaches the speaker as raw JSON.
    const long = `x${"y".repeat(GOOGLE_CHAT_REPLY_MAX_CHARS + 500)}`;
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "reply",
      reply: long.slice(0, 10),
      unclipped: long
    });
    await run();
    expect(fulfillOwnerEmailBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ content: long, source: "google_chat_assistant" })
    );
    const [, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toHaveLength(GOOGLE_CHAT_REPLY_MAX_CHARS);
  });

  it("never runs a teammate's answer through the owner's email fulfilment", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "teammate",
      name: "Dana",
      readFailed: false
    });
    await run();
    expect(fulfillOwnerEmailBlocks).not.toHaveBeenCalled();
    expect(scheduleCaptureOwnerRuleInline).not.toHaveBeenCalled();
  });

  it("captures an owner rule from the exchange", async () => {
    await run();
    expect(scheduleCaptureOwnerRuleInline).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerMessage: "how many leads today?",
        assistantReply: "Four today."
      })
    );
  });
});

describe("describing the speaker to the model", () => {
  it("falls back through name, then address, then a plain description", async () => {
    // Three fallbacks because all three states really occur: somebody
    // placed by a link code has no address, and Chat does not always send a
    // display name either. "undefined" reaching the prompt would be worse
    // than saying nothing.
    for (const [conversation, expected] of [
      [{ user_display_name: "Dana Ruiz", user_email: "dana@acme.com" }, "Dana Ruiz"],
      [{ user_display_name: null, user_email: "dana@acme.com" }, "dana@acme.com"],
      [{ user_display_name: null, user_email: null }, "a team member"]
    ] as const) {
      vi.clearAllMocks();
      vi.mocked(getCoworkerConversationById).mockResolvedValue({
        ...CONVERSATION,
        ...conversation
      } as never);
      vi.mocked(listCoworkerMessages).mockResolvedValue(HISTORY as never);
      vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(true);
      vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
        kind: "owner",
        name: "Amy",
        readFailed: false
      });
      vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
        kind: "reply",
        reply: "ok",
        unclipped: "ok"
      });
      vi.mocked(googleChatSendMessage).mockResolvedValue({ messageName: "m", thread: null });
      vi.mocked(getActiveCoworkerConnection).mockResolvedValue({
        business_id: BIZ,
        is_active: true
      } as never);
      await run();
      expect(runOwnerSurfaceTurn).toHaveBeenCalledWith(
        expect.objectContaining({ speakerRef: expected })
      );
    }
  });

  it("leaves the label unadorned when the speaker has no name", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "teammate",
      name: null,
      readFailed: false
    });
    await run();
    expect(runOwnerSurfaceTurn).toHaveBeenCalledWith(
      expect.objectContaining({ userLabel: "Google Chat from team member" })
    );
  });
});

describe("verdicts that are not a reply", () => {
  it.each([
    ["the conversation is gone", () => vi.mocked(getCoworkerConversationById).mockResolvedValue(null), "conversation_missing"],
    ["the connection is gone", () => vi.mocked(getActiveCoworkerConnection).mockResolvedValue(null), "no_connection"],
    ["there is no user message", () => vi.mocked(listCoworkerMessages).mockResolvedValue([{ id: 1, role: "assistant", content: "x" }] as never), "no_user_message"],
    ["the history is empty entirely", () => vi.mocked(listCoworkerMessages).mockResolvedValue([] as never), "no_user_message"]
  ])("fails TERMINALLY when %s", async (_label, arrange, errorCode) => {
    arrange();
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode, terminal: true })
    );
    expect(googleChatSendMessage).not.toHaveBeenCalled();
  });

  it("refuses a speaker the roster no longer places, TERMINALLY", async () => {
    // The second boundary. A roster row can be deactivated between a
    // message arriving and its turn running, and a former teammate must
    // lose their powers here too.
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "customer",
      name: null,
      readFailed: false
    });
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "not_linked", terminal: true })
    );
  });

  it("RETRIES when the identity read itself failed", async () => {
    // Not the same thing at all: an unreadable roster says nothing about
    // this person, so the job comes back rather than being closed out.
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

  it("says so plainly when the plan does not include this channel", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await run()).toBe(false);
    const [, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toContain("Standard and Enterprise");
    expect(runOwnerSurfaceTurn).not.toHaveBeenCalled();
  });

  it("runs the turn when the tier check ERRORS, rather than refusing", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue(new Error("down"));
    expect(await run()).toBe(true);
  });

  it("tells the speaker when the business is over its cap", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({ kind: "over_cap" });
    expect(await run()).toBe(true);
    const [, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toContain("limit");
  });

  it("says NOTHING at all on a silent verdict", async () => {
    // The surface is switched off. Answering would be the bug.
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "silent",
      reason: "staff_mode_off"
    });
    expect(await run()).toBe(false);
    expect(googleChatSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "staff_mode_off", terminal: true })
    );
  });

  it("closes a terminal failure out without answering", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      code: "no_prompt",
      detail: "missing",
      terminal: true
    });
    expect(await run()).toBe(false);
    expect(googleChatSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_prompt", terminal: true })
    );
  });

  it("retries a soft failure quietly, and only APOLOGISES on the last attempt", async () => {
    // Apologising on attempt one would mean three apologies for one hiccup.
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      code: "model_error",
      detail: "502",
      terminal: false
    });
    expect(await run({ attempts: 1 })).toBe(false);
    expect(googleChatSendMessage).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "model_error", terminal: false })
    );

    vi.clearAllMocks();
    vi.mocked(googleChatSendMessage).mockResolvedValue({
      messageName: `${SPACE}/messages/m9`,
      thread: THREAD
    });
    expect(await run({ attempts: 3 })).toBe(false);
    const [, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toContain("went wrong");
    expect(completeCoworkerJob).toHaveBeenCalled();
  });

  it("retries rather than losing the answer when the post itself fails", async () => {
    vi.mocked(googleChatSendMessage).mockRejectedValue(new Error("http_503"));
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "post_failed", terminal: false })
    );
    expect(completeCoworkerJob).not.toHaveBeenCalled();
  });

  it("answers in the owner's chosen language, not the speaker's", async () => {
    vi.mocked(resolveOwnerUiLocaleForEmail).mockResolvedValue("es" as never);
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({ kind: "over_cap" });
    await run();
    const [, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toContain("límite");
  });

  it("falls back to English when the business has no owner email", async () => {
    vi.mocked(getBusiness).mockResolvedValue({ id: BIZ, owner_email: null } as never);
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({ kind: "over_cap" });
    await run();
    expect(resolveOwnerUiLocaleForEmail).not.toHaveBeenCalled();
    const [, message] = vi.mocked(googleChatSendMessage).mock.calls[0];
    expect(message.text).toContain("limit");
  });

  it("survives the business read failing outright", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("down"));
    expect(await run()).toBe(true);
  });

  it("survives the locale read failing", async () => {
    vi.mocked(resolveOwnerUiLocaleForEmail).mockRejectedValue(new Error("down"));
    expect(await run()).toBe(true);
  });
});

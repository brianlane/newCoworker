import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Teams' entry in the shared coworker queue.
 *
 * The turn assembly and the queue mechanics are tested where they live. What
 * is pinned here is the part that is specific to this channel: a reply needs
 * BOTH halves of a conversation reference, and the second half (the regional
 * service URL) is captured from an inbound activity rather than known in
 * advance. A connection without it is connected and undeliverable, which is
 * a state no other channel has.
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
vi.mock("@/lib/teams/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/teams/client")>()),
  teamsSendActivity: vi.fn()
}));
vi.mock("@/lib/dashboard-chat/email-blocks", () => ({ fulfillOwnerEmailBlocks: vi.fn() }));
vi.mock("@/lib/dashboard-chat/schedule-memory-capture", () => ({
  scheduleCaptureOwnerRuleInline: vi.fn()
}));
vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn(async () => "en")
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { teamsChannelAdapter } from "@/lib/teams/adapter";
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
import { teamsSendActivity } from "@/lib/teams/client";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { resolveOwnerUiLocaleForEmail } from "@/lib/i18n/owner-locale";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SERVICE_URL = "https://smba.trafficmanager.net/amer/";

const JOB = {
  id: "job-1",
  business_id: BIZ,
  channel: "teams" as const,
  conversation_id: "conv-1",
  attempts: 1
};

const CONVERSATION = {
  id: "conv-1",
  business_id: BIZ,
  channel: "teams",
  external_conversation_id: "19:abc@thread.tacv2",
  external_user_id: "obj-1",
  user_display_name: "Dana Ruiz",
  user_email: "dana@acme.com"
};

const HISTORY = [
  { id: 5, role: "assistant", content: "earlier reply" },
  { id: 7, role: "user", content: "how many leads today?" }
];

const run = () => teamsChannelAdapter.runJob(JOB as never);

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getCoworkerConversationById).mockResolvedValue(CONVERSATION as never);
  vi.mocked(getActiveCoworkerConnection).mockResolvedValue({
    business_id: BIZ,
    is_active: true,
    credential: "",
    alert_target_id: "19:abc@thread.tacv2",
    alert_target_name: SERVICE_URL
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
  vi.mocked(teamsSendActivity).mockResolvedValue({ activityId: "act-9" });
  vi.mocked(fulfillOwnerEmailBlocks).mockImplementation(
    async ({ content }) => ({ content }) as never
  );
});

describe("the happy path", () => {
  it("answers into the captured conversation and commits the job", async () => {
    expect(await run()).toBe(true);
    const [reference, activity] = vi.mocked(teamsSendActivity).mock.calls[0];
    expect(reference).toEqual({
      serviceUrl: SERVICE_URL,
      conversationId: "19:abc@thread.tacv2"
    });
    expect(activity.text).toBe("Four today.");
    expect(completeCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Four today.", externalTs: "act-9" })
    );
  });

  it("does NOT require a stored credential, because Teams has none", async () => {
    // The bot authenticates with our own Azure app credentials, so the
    // connection row's credential is an empty string by design. A channel
    // that treated that as "needs reconnect" would never answer at all.
    expect(await run()).toBe(true);
  });

  it("fulfils EMAIL_SEND against the unclipped answer, for the owner only", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "reply",
      reply: "short",
      unclipped: "the whole thing"
    });
    await run();
    expect(fulfillOwnerEmailBlocks).toHaveBeenCalledWith(
      expect.objectContaining({ content: "the whole thing", source: "teams_assistant" })
    );
    expect(scheduleCaptureOwnerRuleInline).toHaveBeenCalled();
  });

  it("withholds owner-only post-processing from a teammate", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "teammate",
      name: "Dana",
      readFailed: false
    });
    await run();
    expect(fulfillOwnerEmailBlocks).not.toHaveBeenCalled();
    expect(scheduleCaptureOwnerRuleInline).not.toHaveBeenCalled();
  });
});

describe("the conversation reference is the thing that can be missing", () => {
  it("errors terminally when no service url was ever captured", async () => {
    // Connected but undeliverable: the tenant installed the app and nobody
    // has messaged it, so there is no regional endpoint to reply through.
    // Terminal, because a retry cannot conjure one; only a human messaging
    // the bot can.
    vi.mocked(getActiveCoworkerConnection).mockResolvedValue({
      business_id: BIZ,
      is_active: true,
      credential: "",
      alert_target_id: "19:abc@thread.tacv2",
      alert_target_name: null
    } as never);
    expect(await run()).toBe(false);
    expect(teamsSendActivity).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_service_url", terminal: true })
    );
  });

  it("errors terminally when the connection is gone or paused", async () => {
    vi.mocked(getActiveCoworkerConnection).mockResolvedValue(null);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_connection", terminal: true })
    );
  });

  it("errors terminally when the conversation is gone", async () => {
    vi.mocked(getCoworkerConversationById).mockResolvedValue(null);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "conversation_missing", terminal: true })
    );
  });
});

describe("who is speaking is re-checked at turn time", () => {
  it("passes the stored address AND the account reference", async () => {
    await run();
    expect(resolveSurfaceSpeaker).toHaveBeenCalledWith(BIZ, {
      email: "dana@acme.com",
      externalRef: { channel: "teams", externalUserId: "obj-1" }
    });
  });

  it("says nothing when the roster row was deactivated since the message", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "customer",
      name: null,
      readFailed: false
    });
    expect(await run()).toBe(false);
    expect(teamsSendActivity).not.toHaveBeenCalled();
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "not_linked", terminal: true })
    );
  });

  it("keeps an unreadable roster retryable, unlike a removed one", async () => {
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
  it("posts the over-cap line and closes the job", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({ kind: "over_cap" });
    expect(await run()).toBe(true);
    expect(vi.mocked(teamsSendActivity).mock.calls[0][1].text).toContain("limit");
  });

  it("says nothing when the owner switched the surface off", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "silent",
      reason: "staff_mode_off"
    });
    expect(await run()).toBe(false);
    expect(teamsSendActivity).not.toHaveBeenCalled();
  });

  it("stays silent on a terminal failure", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      detail: "no_input",
      code: "no_input",
      terminal: true
    });
    expect(await run()).toBe(false);
    expect(teamsSendActivity).not.toHaveBeenCalled();
  });

  it("requeues a retryable failure without posting", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      detail: "boom",
      code: "model_failed"
    });
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "model_failed", terminal: false })
    );
  });

  it("apologises once on the last attempt", async () => {
    vi.mocked(runOwnerSurfaceTurn).mockResolvedValue({
      kind: "failed",
      detail: "boom",
      code: "model_failed"
    });
    expect(await teamsChannelAdapter.runJob({ ...JOB, attempts: 3 } as never)).toBe(false);
    expect(vi.mocked(teamsSendActivity).mock.calls[0][1].text).toContain("went wrong");
  });

  it("requeues when Teams refuses the finished answer", async () => {
    vi.mocked(teamsSendActivity).mockRejectedValue(new Error("forbidden"));
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "post_failed", terminal: false })
    );
  });

  it("posts an honest line on a starter tenant", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await run()).toBe(false);
    expect(vi.mocked(teamsSendActivity).mock.calls[0][1].text).toContain("Standard");
    expect(runOwnerSurfaceTurn).not.toHaveBeenCalled();
  });

  it("delivers anyway when the tier check is down", async () => {
    vi.mocked(coworkerChannelAllowedForBusiness).mockRejectedValue(new Error("db down"));
    expect(await run()).toBe(true);
  });

  it("errors terminally when the window holds no user message", async () => {
    vi.mocked(listCoworkerMessages).mockResolvedValue([] as never);
    expect(await run()).toBe(false);
    expect(failCoworkerJob).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_user_message", terminal: true })
    );
  });
});

describe("what reaches the turn", () => {
  it("answers the newest user line and replays what came before it", async () => {
    vi.mocked(listCoworkerMessages).mockResolvedValue([
      { id: 1, role: "user", content: "first" },
      { id: 2, role: "assistant", content: "answer" },
      { id: 3, role: "user", content: "second" },
      { id: 4, role: "assistant", content: "trailing" }
    ] as never);
    await run();
    const args = vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0];
    expect(args.history.map((m) => m.content)).toEqual(["first", "answer", "second"]);
    expect(args.surfaceKey).toBe("teams");
  });

  it("hands over the business row it already read", async () => {
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].businessMeta).toEqual({
      timezone: "America/Toronto",
      tier: "standard",
      ownerEmail: "owner@acme.com"
    });
  });

  it("names the speaker by display name, then address, then a generic label", async () => {
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].speakerRef).toBe("Dana Ruiz");

    vi.mocked(getCoworkerConversationById).mockResolvedValue({
      ...CONVERSATION,
      user_display_name: null
    } as never);
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[1][0].speakerRef).toBe("dana@acme.com");

    vi.mocked(getCoworkerConversationById).mockResolvedValue({
      ...CONVERSATION,
      user_display_name: null,
      user_email: null
    } as never);
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[2][0].speakerRef).toBe("a team member");
  });

  it("still runs when the business row cannot be read", async () => {
    vi.mocked(getBusiness).mockRejectedValue(new Error("biz down"));
    expect(await run()).toBe(true);
  });

  it("labels an unnamed speaker without a dangling space", async () => {
    vi.mocked(resolveSurfaceSpeaker).mockResolvedValue({
      kind: "owner",
      name: null,
      readFailed: false
    });
    await run();
    expect(vi.mocked(runOwnerSurfaceTurn).mock.calls[0][0].userLabel).toBe("Teams from owner");
  });

  it.each([
    ["there is no owner email on file", () => vi.mocked(getBusiness).mockResolvedValue({ id: BIZ } as never)],
    [
      "the locale lookup itself fails",
      () => vi.mocked(resolveOwnerUiLocaleForEmail).mockRejectedValue(new Error("locale down"))
    ]
  ])("falls back to English when %s", async (_label, arrange) => {
    arrange();
    vi.mocked(coworkerChannelAllowedForBusiness).mockResolvedValue(false);
    expect(await run()).toBe(false);
    expect(vi.mocked(teamsSendActivity).mock.calls[0][1].text).toContain("Standard");
  });
});

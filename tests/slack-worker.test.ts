/**
 * Tests for the Slack reply worker (src/lib/slack/worker.ts).
 *
 * The behaviors worth pinning: the tier chokepoint is terminal WITH an
 * honest line (Slack silence reads as broken), owner-power tools require
 * the verified owner on top of the per-surface toggle, EMAIL_SEND blocks
 * are fulfilled before anything reaches the workspace, streaming degrades
 * to a plain post on any refusal, and failures split terminal vs
 * retryable exactly as the reclaim expects.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/slack-connections", () => ({ getActiveSlackConnection: vi.fn() }));
vi.mock("@/lib/db/slack-chat", () => ({
  claimSlackJob: vi.fn(),
  completeSlackJob: vi.fn(),
  failSlackJob: vi.fn(),
  getSlackConversationById: vi.fn(),
  listSlackMessages: vi.fn(),
  reclaimStaleSlackJobs: vi.fn(),
  updateSlackConversationIdentity: vi.fn()
}));
vi.mock("@/lib/slack/client", () => ({
  slackPostMessage: vi.fn(),
  slackSetAssistantStatus: vi.fn(),
  slackStartStream: vi.fn(),
  slackStopStream: vi.fn(),
  slackAppendStream: vi.fn(),
  slackUsersInfo: vi.fn()
}));
vi.mock("@/lib/slack/tier-gate", () => ({ slackAllowedForBusiness: vi.fn() }));
vi.mock("@/lib/owner-surfaces/staff-mode", () => ({ staffModeEnabled: vi.fn() }));
vi.mock("@/lib/db/businesses", () => ({ getBusiness: vi.fn() }));
vi.mock("@/lib/db/agent-tool-settings", () => ({ getAgentToolStates: vi.fn() }));
vi.mock("@/lib/db/whatsapp-connections", () => ({ getPublicWhatsAppConnection: vi.fn() }));
vi.mock("@/lib/db/chat-usage", () => ({ getChatSpendSnapshotForBusiness: vi.fn() }));
vi.mock("@/lib/dashboard-chat/inline-turn", () => ({ runInlineChatTurn: vi.fn() }));
vi.mock("@/lib/dashboard-chat/context-blocks", () => ({
  buildBusinessContextBlock: vi.fn(async () => "CONTEXT"),
  buildIntegrationsStatusLine: vi.fn(async () => "INTEGRATIONS")
}));
vi.mock("@/lib/dashboard-chat/schedule-memory-capture", () => ({
  scheduleCaptureOwnerRuleInline: vi.fn()
}));
// Sentinels, because these assertions are about WHICH persona the worker
// selected, not how it is worded. Mocked at the library that owns them now
// rather than through the dashboard chat route.
vi.mock("@/lib/owner-surfaces/preambles", () => ({
  EMAIL_TOOL_DISABLED_PREAMBLE: "EMAIL_DISABLED",
  EMAIL_TOOL_ENABLED_PREAMBLE: "EMAIL_ENABLED",
  OWNER_PREAMBLE: "OWNER_PREAMBLE"
}));
// The EMAIL_SEND sentinels are real, not stubbed: the owner preambles
// interpolate them into the prompt, so a stub would silently replace the
// protocol the model is taught with "undefined".
vi.mock("@/lib/dashboard-chat/email-blocks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/dashboard-chat/email-blocks")>()),
  fulfillOwnerEmailBlocks: vi.fn()
}));
vi.mock("@/lib/booking-page/prompt-line", () => ({
  bookingLinkPromptLine: vi.fn(async () => "BOOKING_LINK")
}));
vi.mock("@/lib/i18n/owner-locale", () => ({
  resolveOwnerUiLocaleForEmail: vi.fn(async () => "en")
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { processSlackJobs } from "@/lib/slack/worker";
import { getActiveSlackConnection } from "@/lib/db/slack-connections";
import {
  claimSlackJob,
  completeSlackJob,
  failSlackJob,
  getSlackConversationById,
  listSlackMessages,
  reclaimStaleSlackJobs,
  updateSlackConversationIdentity
} from "@/lib/db/slack-chat";
import {
  slackPostMessage,
  slackSetAssistantStatus,
  slackStartStream,
  slackStopStream,
  slackAppendStream,
  slackUsersInfo
} from "@/lib/slack/client";
import { slackAllowedForBusiness } from "@/lib/slack/tier-gate";
import { staffModeEnabled } from "@/lib/owner-surfaces/staff-mode";
import { getBusiness } from "@/lib/db/businesses";
import { getAgentToolStates } from "@/lib/db/agent-tool-settings";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import { scheduleCaptureOwnerRuleInline } from "@/lib/dashboard-chat/schedule-memory-capture";
import { fulfillOwnerEmailBlocks } from "@/lib/dashboard-chat/email-blocks";

const BIZ = "11111111-1111-4111-8111-111111111111";

const JOB = {
  id: "job-1",
  business_id: BIZ,
  conversation_id: "conv-1",
  attempts: 1
};

const CONVERSATION = {
  id: "conv-1",
  business_id: BIZ,
  team_id: "T-1",
  channel_id: "D-1",
  thread_ts: null,
  slack_user_id: "U-1",
  user_display_name: null,
  user_email: null,
  is_owner: false
};

const CONNECTION = { business_id: BIZ, bot_user_id: "U-BOT", botToken: "xoxb-1", is_active: true };

const HISTORY = [
  { id: 5, role: "assistant", content: "earlier reply", slack_ts: "1.0" },
  { id: 7, role: "user", content: "what's tomorrow look like?", slack_ts: "2.0" }
];

function claimOnce(job = JOB) {
  vi.mocked(claimSlackJob).mockResolvedValueOnce(job as never).mockResolvedValue(null);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(reclaimStaleSlackJobs).mockResolvedValue(0);
  vi.mocked(claimSlackJob).mockResolvedValue(null);
  vi.mocked(getSlackConversationById).mockResolvedValue(CONVERSATION as never);
  vi.mocked(getActiveSlackConnection).mockResolvedValue(CONNECTION as never);
  vi.mocked(getBusiness).mockResolvedValue({
    id: BIZ,
    owner_email: "owner@x.co",
    timezone: "America/Phoenix",
    tier: "standard"
  } as never);
  vi.mocked(slackAllowedForBusiness).mockResolvedValue(true);
  vi.mocked(staffModeEnabled).mockResolvedValue(true);
  vi.mocked(slackUsersInfo).mockResolvedValue({
    displayName: "Dave",
    email: "dave@x.co",
    isBot: false
  });
  vi.mocked(updateSlackConversationIdentity).mockResolvedValue(undefined);
  vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValue({
    spendMicros: 0,
    effectiveCapMicros: 10_000_000
  } as never);
  vi.mocked(listSlackMessages).mockResolvedValue(HISTORY as never);
  vi.mocked(getAgentToolStates).mockImplementation(
    async (_biz: string, _agent: string, keys: readonly string[]) =>
      Object.fromEntries(keys.map((k) => [k, true]))
  );
  vi.mocked(getPublicWhatsAppConnection).mockResolvedValue({ is_active: true } as never);
  vi.mocked(slackSetAssistantStatus).mockResolvedValue(true);
  vi.mocked(slackStartStream).mockResolvedValue({ channel: "D-1", ts: "3.0" });
  vi.mocked(slackAppendStream).mockResolvedValue(true);
  vi.mocked(slackStopStream).mockResolvedValue(true);
  vi.mocked(slackPostMessage).mockResolvedValue({ ok: true, ts: "3.1", channel: "D-1" });
  vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: true, content: "Tomorrow is clear." } as never);
  vi.mocked(fulfillOwnerEmailBlocks).mockImplementation(async ({ content }) => ({ content }) as never);
  vi.mocked(completeSlackJob).mockResolvedValue(undefined);
  vi.mocked(failSlackJob).mockResolvedValue(undefined);
});

describe("processSlackJobs", () => {
  it("reclaims, drains the queue, and reports the batch", async () => {
    claimOnce();
    vi.mocked(reclaimStaleSlackJobs).mockResolvedValue(2);
    const result = await processSlackJobs();
    expect(result).toEqual({ reclaimed: 2, processed: 1, failed: 0 });
  });

  it("survives a reclaim failure, a claim failure, and a job crash", async () => {
    vi.mocked(reclaimStaleSlackJobs).mockRejectedValue(new Error("rpc down"));
    vi.mocked(claimSlackJob).mockRejectedValue(new Error("claim down"));
    expect(await processSlackJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0 });

    vi.mocked(reclaimStaleSlackJobs).mockResolvedValue(0);
    claimOnce();
    vi.mocked(getSlackConversationById).mockRejectedValue(new Error("boom"));
    const result = await processSlackJobs();
    expect(result.failed).toBe(1);
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "worker_crash", terminal: false })
    );

    // The crash-path failSlackJob failing too must not take the batch down.
    claimOnce();
    vi.mocked(failSlackJob).mockRejectedValue(new Error("also down"));
    expect((await processSlackJobs()).failed).toBe(1);
  });
});

describe("one job, terminal shapes", () => {
  it("errors terminally when the conversation or connection is gone", async () => {
    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue(null);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "conversation_missing", terminal: true })
    );

    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue(CONVERSATION as never);
    vi.mocked(getActiveSlackConnection).mockResolvedValue(null);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_connection", terminal: true })
    );
  });

  it("posts the upgrade line and errors terminally on a starter tenant", async () => {
    claimOnce();
    vi.mocked(slackAllowedForBusiness).mockResolvedValue(false);
    await processSlackJobs();
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ text: expect.stringContaining("Standard and Enterprise") })
    );
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "tier_blocked", terminal: true })
    );
    expect(vi.mocked(runInlineChatTurn)).not.toHaveBeenCalled();
  });

  it("fails the tier check open on a read blip", async () => {
    claimOnce();
    vi.mocked(slackAllowedForBusiness).mockRejectedValue(new Error("db blip"));
    await processSlackJobs();
    expect(vi.mocked(runInlineChatTurn)).toHaveBeenCalled();
  });

  it("drops a bot speaker terminally and a message-less history too", async () => {
    claimOnce();
    vi.mocked(slackUsersInfo).mockResolvedValue({ displayName: "B", email: null, isBot: true });
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "bot_user", terminal: true })
    );

    claimOnce();
    vi.mocked(slackUsersInfo).mockResolvedValue({
      displayName: "Dave",
      email: "d@x.co",
      isBot: false
    });
    vi.mocked(listSlackMessages).mockResolvedValue([
      { id: 5, role: "assistant", content: "only me", slack_ts: "1.0" }
    ] as never);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_user_message", terminal: true })
    );
  });

  it("answers the over-cap case honestly without a model call", async () => {
    claimOnce();
    vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValue({
      spendMicros: 10_000_001,
      effectiveCapMicros: 10_000_000
    } as never);
    await processSlackJobs();
    expect(vi.mocked(runInlineChatTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining("AI budget"), slackTs: "3.1" })
    );
  });
});

describe("identity and tool powers", () => {
  it("team member: owner-power tools stay off even when toggled on", async () => {
    claimOnce();
    await processSlackJobs();
    const args = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(args.spendSurface).toBe("slack_chat");
    expect(args.includeCreationTools).toBe(false);
    expect(args.systemInstruction).toContain("TEAM MEMBER");
    expect(args.systemInstruction).not.toContain("OWNER_PREAMBLE");
    expect(args.systemInstruction).not.toContain("EMAIL_ENABLED");
    expect(args.actionToolGates).toMatchObject({
      send_sms: true,
      manage_employee: false,
      flag_contact_spam: false,
      set_contact_reply_mode: false,
      update_notification_preferences: false,
      edit_aiflow: false,
      generate_image: false
    });
    expect(vi.mocked(updateSlackConversationIdentity)).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ isOwner: false })
    );
    expect(vi.mocked(scheduleCaptureOwnerRuleInline)).not.toHaveBeenCalled();
    expect(vi.mocked(fulfillOwnerEmailBlocks)).not.toHaveBeenCalled();
  });

  it("verified owner: full persona, owner powers, email fulfilment, memory capture", async () => {
    claimOnce();
    vi.mocked(slackUsersInfo).mockResolvedValue({
      displayName: "Amy",
      email: "Owner@X.co",
      isBot: false
    });
    vi.mocked(fulfillOwnerEmailBlocks).mockResolvedValue({ content: "Sent it." } as never);
    await processSlackJobs();
    const args = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(args.systemInstruction).toContain("OWNER_PREAMBLE");
    expect(args.systemInstruction).toContain("EMAIL_ENABLED");
    expect(args.actionToolGates).toMatchObject({
      manage_employee: true,
      update_notification_preferences: true
    });
    expect(vi.mocked(fulfillOwnerEmailBlocks)).toHaveBeenCalledWith(
      expect.objectContaining({ source: "slack_assistant", agentKey: "slack" })
    );
    expect(vi.mocked(scheduleCaptureOwnerRuleInline)).toHaveBeenCalled();
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ content: "Sent it." })
    );
  });

  it("bridge tools: declared for the verified owner, never for a teammate", async () => {
    claimOnce();
    await processSlackJobs();
    const teamArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(teamArgs.extraTools).toBeNull();
    expect(teamArgs.systemInstruction).not.toContain("DIRECT BUSINESS TOOLS");

    vi.mocked(runInlineChatTurn).mockClear();
    claimOnce();
    vi.mocked(slackUsersInfo).mockResolvedValue({
      displayName: "Amy",
      email: "owner@x.co",
      isBot: false
    });
    await processSlackJobs();
    const ownerArgs = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(ownerArgs.maxToolSteps).toBe(6);
    expect(ownerArgs.systemInstruction).toContain("DIRECT BUSINESS TOOLS");
    const names = (ownerArgs.extraTools?.declarations ?? []).map(
      (d: { name: string }) => d.name
    );
    expect(names).toContain("get_sms_thread");
    expect(names).toContain("update_business_knowledge");
  });

  it("owner with the email toggle off gets the disabled preamble", async () => {
    claimOnce();
    vi.mocked(slackUsersInfo).mockResolvedValue({
      displayName: "Amy",
      email: "owner@x.co",
      isBot: false
    });
    vi.mocked(getAgentToolStates).mockImplementation(
      async (_biz: string, _agent: string, keys: readonly string[]) =>
        Object.fromEntries(keys.map((k) => [k, k !== "send_email"]))
    );
    await processSlackJobs();
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].systemInstruction).toContain(
      "EMAIL_DISABLED"
    );
  });

  it("re-resolves an empty cached email so an owner can graduate later", async () => {
    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue({
      ...CONVERSATION,
      user_email: "",
      is_owner: false
    } as never);
    vi.mocked(slackUsersInfo).mockResolvedValue({
      displayName: "Amy",
      email: "owner@x.co",
      isBot: false
    });
    await processSlackJobs();
    expect(vi.mocked(slackUsersInfo)).toHaveBeenCalled();
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].systemInstruction).toContain(
      "OWNER_PREAMBLE"
    );
  });

  it("reuses the cached identity and degrades to TEAM when the lookup fails", async () => {
    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue({
      ...CONVERSATION,
      user_email: "dave@x.co",
      user_display_name: "Dave",
      is_owner: true
    } as never);
    await processSlackJobs();
    expect(vi.mocked(slackUsersInfo)).not.toHaveBeenCalled();
    expect(vi.mocked(runInlineChatTurn).mock.calls[0][0].systemInstruction).toContain(
      "OWNER_PREAMBLE"
    );

    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue(CONVERSATION as never);
    vi.mocked(slackUsersInfo).mockRejectedValue(new Error("slack down"));
    await processSlackJobs();
    expect(vi.mocked(runInlineChatTurn).mock.calls[1][0].systemInstruction).toContain(
      "TEAM MEMBER"
    );
  });
});

describe("streaming and posting", () => {
  it("streams the final text and commits with the stream's ts", async () => {
    claimOnce();
    vi.mocked(runInlineChatTurn).mockImplementation(async (args: { onTextDelta?: (t: string) => void }) => {
      args.onTextDelta?.("Tomorrow is clear.");
      return { ok: true, content: "Tomorrow is clear." } as never;
    });
    await processSlackJobs();
    expect(vi.mocked(slackAppendStream)).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "D-1", ts: "3.0" },
      "Tomorrow is clear."
    );
    expect(vi.mocked(slackStopStream)).toHaveBeenCalledWith(
      "xoxb-1",
      { channel: "D-1", ts: "3.0" },
      "Tomorrow is clear."
    );
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ slackTs: "3.0", historyMaxMessageId: 7 })
    );
  });

  it("withholds streaming when a potential EMAIL_SEND marker appears", async () => {
    claimOnce();
    vi.mocked(runInlineChatTurn).mockImplementation(async (args: { onTextDelta?: (t: string) => void }) => {
      args.onTextDelta?.('<<EMAIL_SEND>>{"to":"x"}<<END_EMAIL_SEND>>');
      return { ok: true, content: "Sent." } as never;
    });
    await processSlackJobs();
    expect(vi.mocked(slackAppendStream)).not.toHaveBeenCalled();
    expect(vi.mocked(slackStopStream)).toHaveBeenCalled();
  });

  it("degrades to a plain post when the stream never starts or stop fails", async () => {
    claimOnce();
    vi.mocked(slackStartStream).mockResolvedValue(null);
    await processSlackJobs();
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ text: "Tomorrow is clear." })
    );
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ slackTs: "3.1" })
    );

    claimOnce();
    vi.mocked(slackStartStream).mockResolvedValue({ channel: "D-1", ts: "3.0" });
    vi.mocked(slackStopStream).mockResolvedValue(false);
    await processSlackJobs();
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledTimes(2);
  });

  it("threads replies for mention conversations", async () => {
    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue({
      ...CONVERSATION,
      channel_id: "C-9",
      thread_ts: "200.1"
    } as never);
    vi.mocked(slackStartStream).mockResolvedValue(null);
    await processSlackJobs();
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ channel: "C-9", thread_ts: "200.1" })
    );
  });

  it("requeues when the post fails", async () => {
    claimOnce();
    vi.mocked(slackStartStream).mockResolvedValue(null);
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: false, error: "channel_not_found" });
    const result = await processSlackJobs();
    expect(result.failed).toBe(1);
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "post_failed", terminal: false })
    );
  });
});

describe("turn failure", () => {
  it("requeues silently before the last attempt", async () => {
    claimOnce();
    vi.mocked(runInlineChatTurn).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "boom"
    } as never);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "model_failed", terminal: false })
    );
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
  });

  it("tells the thread on the final attempt and closes the job", async () => {
    claimOnce({ ...JOB, attempts: 3 });
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: false, error: "model_failed" } as never);
    const result = await processSlackJobs();
    expect(result.failed).toBe(1);
    expect(vi.mocked(slackPostMessage)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ text: expect.stringContaining("Something went wrong") })
    );
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalled();
  });
});

describe("failure-tolerant plumbing (coverage of the catch arrows)", () => {
  it("survives every best-effort read failing at once", async () => {
    claimOnce();
    vi.mocked(getBusiness).mockRejectedValue(new Error("biz down"));
    vi.mocked(updateSlackConversationIdentity).mockRejectedValue(new Error("cache down"));
    vi.mocked(getChatSpendSnapshotForBusiness).mockRejectedValue(new Error("spend down"));
    vi.mocked(getPublicWhatsAppConnection).mockRejectedValue(new Error("wa down"));
    const result = await processSlackJobs();
    expect(result.processed).toBe(1);
    const args = vi.mocked(runInlineChatTurn).mock.calls[0][0];
    expect(args.actionToolGates).toMatchObject({ send_whatsapp: false });
  });

  it("tier-line post failures still end in a terminal tier_blocked", async () => {
    claimOnce();
    vi.mocked(slackAllowedForBusiness).mockResolvedValue(false);
    vi.mocked(slackPostMessage).mockRejectedValue(new Error("post down"));
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "tier_blocked", terminal: true })
    );
  });

  it("a rejected stop on the failure path still requeues, and a false append counts nothing", async () => {
    claimOnce();
    vi.mocked(slackStopStream).mockRejectedValue(new Error("stop down"));
    vi.mocked(runInlineChatTurn).mockImplementation(async (args: { onTextDelta?: (t: string) => void }) => {
      args.onTextDelta?.("partial");
      return { ok: false, error: "model_failed" } as never;
    });
    vi.mocked(slackAppendStream).mockResolvedValue(false);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "model_failed", terminal: false })
    );
  });

  it("ignores deltas entirely when no stream started", async () => {
    claimOnce();
    vi.mocked(slackStartStream).mockResolvedValue(null);
    vi.mocked(runInlineChatTurn).mockImplementation(async (args: { onTextDelta?: (t: string) => void }) => {
      args.onTextDelta?.("text with no stream");
      return { ok: true, content: "fine" } as never;
    });
    await processSlackJobs();
    expect(vi.mocked(slackAppendStream)).not.toHaveBeenCalled();
  });
});

describe("nullish fallbacks", () => {
  it("locale read failure, nameless identity, and a failed over-cap post all degrade", async () => {
    claimOnce();
    const { resolveOwnerUiLocaleForEmail } = await import("@/lib/i18n/owner-locale");
    vi.mocked(resolveOwnerUiLocaleForEmail).mockRejectedValue(new Error("locale down"));
    vi.mocked(slackUsersInfo).mockResolvedValue({ displayName: null, email: null, isBot: false });
    vi.mocked(listSlackMessages).mockResolvedValue([
      { id: 7, role: "user", content: "hola", slack_ts: null }
    ] as never);
    vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValue({
      spendMicros: 99,
      effectiveCapMicros: 1
    } as never);
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: false, error: "channel_not_found" });
    await processSlackJobs();
    expect(vi.mocked(updateSlackConversationIdentity)).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ email: null, isOwner: false })
    );
    // Over-cap reply attempted, post refused: the job still closes honestly
    // with a null ts rather than wedging.
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ slackTs: null })
    );
  });

  it("an inline failure without an error code still requeues with a name", async () => {
    claimOnce();
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: false } as never);
    vi.mocked(slackStartStream).mockResolvedValue(null);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "model_failed", terminal: false })
    );
  });
});

describe("sparse-context turns", () => {
  it("builds the system prompt without optional blocks, timezone, or history", async () => {
    claimOnce();
    const contextBlocks = await import("@/lib/dashboard-chat/context-blocks");
    const bookingLine = await import("@/lib/booking-page/prompt-line");
    vi.mocked(contextBlocks.buildIntegrationsStatusLine).mockResolvedValue("" as never);
    vi.mocked(contextBlocks.buildBusinessContextBlock).mockResolvedValue("" as never);
    vi.mocked(bookingLine.bookingLinkPromptLine).mockResolvedValue("" as never);
    vi.mocked(getBusiness).mockResolvedValue({
      id: BIZ,
      owner_email: "owner@x.co",
      timezone: null,
      tier: "standard"
    } as never);
    vi.mocked(listSlackMessages).mockResolvedValue([
      { id: 7, role: "user", content: "first message ever", slack_ts: "2.0" }
    ] as never);
    await processSlackJobs();
    const sys = vi.mocked(runInlineChatTurn).mock.calls[0][0].systemInstruction;
    expect(sys).not.toContain("INTEGRATIONS");
    expect(sys).not.toContain("BOOKING_LINK");
    expect(sys).not.toContain("Recent Slack exchange");
  });

  it("a failed final-attempt failure post still closes with a null ts", async () => {
    claimOnce({ ...JOB, attempts: 3 });
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: false, error: "model_failed" } as never);
    vi.mocked(slackPostMessage).mockResolvedValue({ ok: false, error: "down" });
    await processSlackJobs();
    expect(vi.mocked(completeSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ slackTs: null })
    );
  });

  it("stringifies a non-Error job crash", async () => {
    claimOnce();
    vi.mocked(getSlackConversationById).mockRejectedValue("string blowup");
    const result = await processSlackJobs();
    expect(result.failed).toBe(1);
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "worker_crash", errorDetail: "string blowup" })
    );
  });
});

describe("final branch sweep", () => {
  it("stringifies non-Error reclaim and claim failures", async () => {
    vi.mocked(reclaimStaleSlackJobs).mockRejectedValue("reclaim string");
    vi.mocked(claimSlackJob).mockRejectedValue("claim string");
    expect(await processSlackJobs()).toEqual({ reclaimed: 0, processed: 0, failed: 0 });
  });

  it("empty history closes as no_user_message with a zero cutoff", async () => {
    claimOnce();
    vi.mocked(listSlackMessages).mockResolvedValue([] as never);
    await processSlackJobs();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_user_message", terminal: true })
    );
  });

  it("a nameless owner with back-to-back messages and no ts anchors still runs", async () => {
    claimOnce();
    vi.mocked(getSlackConversationById).mockResolvedValue({
      ...CONVERSATION,
      user_email: "owner@x.co",
      user_display_name: null,
      is_owner: true
    } as never);
    vi.mocked(listSlackMessages).mockResolvedValue([
      { id: 5, role: "user", content: "first ask", slack_ts: "1.0" },
      { id: 7, role: "user", content: "second ask", slack_ts: null }
    ] as never);
    await processSlackJobs();
    expect(vi.mocked(slackSetAssistantStatus)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ thread_ts: "" })
    );
    const sys = vi.mocked(runInlineChatTurn).mock.calls[0][0].systemInstruction;
    expect(sys).toContain("The speaker is the business OWNER, verified");
    expect(sys).toContain("[Teammate]: first ask");
  });

  // DM replies post to the channel top level, so Slack's auto-clear (posts
  // INTO the status thread) never fires: the worker must clear explicitly or
  // the "is thinking" indicator spins forever after the reply lands.
  it("clears the thinking status after a DM reply, anchored at the user's message", async () => {
    claimOnce();
    await processSlackJobs();
    const statusCalls = vi.mocked(slackSetAssistantStatus).mock.calls;
    expect(statusCalls[0][1]).toMatchObject({
      channel_id: "D-1",
      thread_ts: "2.0",
      status: "is thinking..."
    });
    expect(statusCalls[statusCalls.length - 1][1]).toMatchObject({
      channel_id: "D-1",
      thread_ts: "2.0",
      status: ""
    });
  });

  it("keeps the status spinning on a retryable failure (the sweep runs it again)", async () => {
    claimOnce();
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: false, error: "model_failed" } as never);
    await processSlackJobs();
    const cleared = vi.mocked(slackSetAssistantStatus).mock.calls.some((c) => c[1].status === "");
    expect(cleared).toBe(false);
  });

  it("the final-attempt failure line clears the status before closing", async () => {
    claimOnce({ ...JOB, attempts: 3 });
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: false, error: "model_failed" } as never);
    await processSlackJobs();
    expect(vi.mocked(slackSetAssistantStatus)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ thread_ts: "2.0", status: "" })
    );
  });

  it("terminal refusals clear a status left by an earlier attempt", async () => {
    claimOnce();
    vi.mocked(getChatSpendSnapshotForBusiness).mockResolvedValue({
      spendMicros: 10_000_000,
      effectiveCapMicros: 10_000_000
    } as never);
    await processSlackJobs();
    expect(vi.mocked(slackSetAssistantStatus)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ thread_ts: "2.0", status: "" })
    );

    claimOnce();
    vi.mocked(slackSetAssistantStatus).mockClear();
    // A rejected clear is swallowed: killing the spinner is best-effort.
    vi.mocked(slackSetAssistantStatus).mockRejectedValue(new Error("status api down"));
    vi.mocked(slackAllowedForBusiness).mockResolvedValue(false);
    const result = await processSlackJobs();
    expect(result.failed).toBe(1);
    expect(vi.mocked(slackSetAssistantStatus)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ thread_ts: "2.0", status: "" })
    );
  });
});

describe("verdicts that are not failures", () => {
  it("says NOTHING when the owner switched this surface off", async () => {
    // "Answer them as a customer" is not a thing inside a workspace, and a
    // line explaining the setting would only nag a teammate who cannot
    // change it. Terminal, so a switched-off surface does not spend three
    // attempts per message forever.
    claimOnce();
    vi.mocked(staffModeEnabled).mockResolvedValue(false);
    const result = await processSlackJobs();

    expect(result.failed).toBe(1);
    expect(vi.mocked(runInlineChatTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(completeSlackJob)).not.toHaveBeenCalled();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "staff_mode_off", terminal: true })
    );
    // The spinner must not be left running on a turn that will never answer.
    expect(vi.mocked(slackSetAssistantStatus)).toHaveBeenCalledWith(
      "xoxb-1",
      expect.objectContaining({ status: "" })
    );
  });

  it("errors terminally, and silently, when there is nothing to answer", async () => {
    // A whitespace-only message is not a question. Posting "something went
    // wrong" would be replying to something nobody asked, and retrying it
    // three times would dead-letter the job under a misleading code.
    claimOnce();
    vi.mocked(listSlackMessages).mockResolvedValue([
      { id: 9, role: "user", content: "   ", slack_ts: "2.0" }
    ] as never);
    const result = await processSlackJobs();

    expect(result.failed).toBe(1);
    expect(vi.mocked(runInlineChatTurn)).not.toHaveBeenCalled();
    expect(vi.mocked(slackPostMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(failSlackJob)).toHaveBeenCalledWith(
      expect.objectContaining({ errorCode: "no_input", terminal: true })
    );
  });
});

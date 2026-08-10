import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/rowboat/gateway-token", () => ({
  verifyRowboatGatewayToken: vi.fn().mockReturnValue(true),
  verifyGatewayTokenForBusiness: vi.fn().mockResolvedValue(true)
}));

vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnection: vi.fn()
}));

vi.mock("@/lib/email/owner-mailbox", () => ({
  sendFromMailboxConnection: vi.fn()
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

vi.mock("@/lib/db/system-logs", () => ({
  recordSystemLog: vi.fn().mockResolvedValue(undefined)
}));

vi.mock("@/lib/db/email-log", () => ({ getEmailLogThreadIdentity: vi.fn() }));
vi.mock("@/lib/email-coworker/threads", () => ({ rememberSentThread: vi.fn() }));

import { POST } from "@/app/api/aiflows/send-owner-email/route";
import { verifyGatewayTokenForBusiness } from "@/lib/rowboat/gateway-token";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { recordSystemLog } from "@/lib/db/system-logs";
import { getEmailLogThreadIdentity } from "@/lib/db/email-log";
import { rememberSentThread } from "@/lib/email-coworker/threads";

const businessId = "11111111-1111-4111-8111-111111111111";
const connectionId = "22222222-2222-4222-8222-222222222222";
const validBody = {
  businessId,
  connectionId,
  toEmail: "lead@example.com",
  subject: "Following up",
  bodyText: "Hi — still interested?"
};

function makeRequest(body: unknown) {
  return new Request("http://localhost/api/aiflows/send-owner-email", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer gw" },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
}

function connRow(provider_config_key: string) {
  return { id: connectionId, provider_config_key, connection_id: "cx-1" } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValue(true);
  vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("google-mail"));
  vi.mocked(sendFromMailboxConnection).mockResolvedValue({
    ok: true,
    provider: "google",
    messageId: "gmail-1",
    threadId: null,
    fromEmail: "owner@biz.com"
  });
});

describe("POST /api/aiflows/send-owner-email", () => {
  it("rejects requests without a gateway token", async () => {
    vi.mocked(verifyGatewayTokenForBusiness).mockResolvedValueOnce(false);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(sendFromMailboxConnection).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies (zod issue + non-JSON)", async () => {
    const bad = await POST(makeRequest({ ...validBody, toEmail: "nope" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).detail).toMatch(/^invalid_args:/);

    const nonJson = await POST(makeRequest("not json"));
    expect(nonJson.status).toBe(400);
  });

  it("returns connection_not_found when the id doesn't belong to the business", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(null);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "connection_not_found" });
    expect(sendFromMailboxConnection).not.toHaveBeenCalled();
  });

  it("returns not_email_connection for a non-mailbox connection", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("google-calendar"));
    const res = await POST(makeRequest(validBody));
    expect(await res.json()).toEqual({ ok: false, detail: "not_email_connection" });
  });

  it("sends through the resolved connection and returns the provider id", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ok: true,
      // fromEmail rides along so the worker logs the real sending address.
      data: { messageId: "gmail-1", provider: "google", fromEmail: "owner@biz.com", threadId: null }
    });
    expect(sendFromMailboxConnection).toHaveBeenCalledWith(
      businessId,
      { provider: "google", providerConfigKey: "google-mail", connectionId: "cx-1" },
      {
        toEmail: "lead@example.com",
        subject: "Following up",
        bodyText: "Hi — still interested?",
        ccEmails: [],
        bccEmails: []
      }
    );
  });

  it("maps an outlook key to the microsoft provider", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("outlook"));
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "microsoft",
      messageId: null,
      threadId: null,
      fromEmail: null
    });
    const res = await POST(makeRequest(validBody));
    expect(await res.json()).toEqual({
      ok: true,
      data: { messageId: null, provider: "microsoft", fromEmail: null, threadId: null }
    });
    expect(vi.mocked(sendFromMailboxConnection).mock.calls[0][1].provider).toBe("microsoft");
  });

  it("passes through an ok:false detail from the sender", async () => {
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: false,
      detail: "email_not_connected"
    });
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, detail: "email_not_connected" });
  });

  it("returns 500 email_send_failed and logs when the provider throws", async () => {
    vi.mocked(sendFromMailboxConnection).mockRejectedValue(new Error("gmail 500"));
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ ok: false, detail: "email_send_failed" });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_owner_email_failed", level: "error" })
    );
  });
});

describe("replying inside an existing conversation", () => {
  const emailLogId = "33333333-3333-4333-8333-333333333333";
  const REPLY_BODY = { ...validBody, replyToEmailLogId: emailLogId };

  it("threads the send against the row's identity and claims the conversation", async () => {
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "199abc4d5e6f7890",
      inReplyToMessageRef: "<CAJ=intro@mail.gmail.com>",
      providerMessageId: "m1",
      replyToRecipients: ["king@clinic.example.com"],
      replyCcRecipients: []
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "gmail-2",
      threadId: "199abc4d5e6f7890",
      fromEmail: "team@newcoworker.com"
    } as never);

    const res = await POST(makeRequest(REPLY_BODY));
    expect(res.status).toBe(200);

    // The thread argument reaches the transport, or the reply lands beside
    // the original instead of inside it.
    const sendArgs = vi.mocked(sendFromMailboxConnection).mock.calls[0][2];
    expect(sendArgs).toMatchObject({
      thread: {
        threadId: "199abc4d5e6f7890",
        inReplyToMessageRef: "<CAJ=intro@mail.gmail.com>",
        providerMessageId: "m1"
      }
    });
    // Reply-all, MIRRORING the slots. The prospect was on the original's To
    // while the INTRODUCER sat in From, so they stay on To beside them.
    // Answering only From reaches the person who did the favor and never the
    // lead; demoting them to Cc reaches them but reads as though they are
    // copied on someone else's conversation.
    expect(sendArgs).toMatchObject({ additionalToEmails: ["king@clinic.example.com"] });
    expect((sendArgs as { ccEmails?: string[] }).ccEmails ?? []).toEqual([]);
    // And the coworker owns it, or turn two goes back to paging a human.
    expect(rememberSentThread).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "199abc4d5e6f7890", correspondentEmail: "lead@example.com" })
    );
  });

  it("reports the conversation back, so the outbound row can be found later", async () => {
    /**
     * Caught by Bugbot, and confirmed against production: every outbound
     * email_log row carried thread_id NULL, so `threadsWeHaveRepliedOn` (which
     * matches on thread_id) could never match and the thread signal behind
     * {{trigger.thread_has_our_reply}} was dead on arrival.
     *
     * The worker writes that row from THIS response, so the id has to come
     * back here or it is lost. My own test for the signal mocked the lookup
     * and so proved nothing about the row ever being written.
     */
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "t-live",
      providerMessageId: "m-live",
      replyToRecipients: [],
      replyCcRecipients: []
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "g-live",
      threadId: "t-echoed",
      fromEmail: "team@newcoworker.com"
    } as never);
    const res = await POST(makeRequest(REPLY_BODY));
    const body = (await res.json()) as { data: { threadId: string | null } };
    // The provider's echo wins when there is one.
    expect(body.data.threadId).toBe("t-echoed");
  });

  it("falls back to the thread it replied into when the provider echoes none", async () => {
    // Graph's /reply returns no ids at all, so keying on the echo alone would
    // leave every Microsoft reply unfindable, exactly the gap this closes.
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "t-known",
      providerMessageId: "m9",
      replyToRecipients: [],
      replyCcRecipients: []
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "microsoft",
      messageId: null,
      threadId: null,
      fromEmail: "team@newcoworker.com"
    } as never);
    const res = await POST(makeRequest(REPLY_BODY));
    const body = (await res.json()) as { data: { threadId: string | null } };
    expect(body.data.threadId).toBe("t-known");
  });

  it("mirrors the live Aug 8 thread: two on To, no Cc invented", async () => {
    /**
     * The exact shape Brian sent. Incoming was addressed to
     * team@newcoworker.com and jobarmsteam@gmail.com on To, with no Cc and no
     * Bcc. The reply went To james, Cc jobarmsteam, which reached everyone but
     * demoted a participant to a bystander and invented a Cc line.
     *
     * Driven through the real POST handler, not by calling a helper: the bug
     * was in how the route assembled the slots, so a unit test of the splitter
     * alone would have passed either way.
     */
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "t-live",
      providerMessageId: "m-live",
      replyToRecipients: ["team@newcoworker.com", "jobarmsteam@gmail.com"],
      replyCcRecipients: []
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "g-live",
      threadId: "t-live",
      fromEmail: "team@newcoworker.com"
    } as never);

    const res = await POST(makeRequest(REPLY_BODY));
    expect(res.status).toBe(200);
    const sendArgs = vi.mocked(sendFromMailboxConnection).mock.calls[0][2] as {
      toEmail: string;
      additionalToEmails?: string[];
      ccEmails?: string[];
    };
    // The sender keeps the primary slot, the other To recipient joins them.
    expect(sendArgs.toEmail).toBe("lead@example.com");
    expect(sendArgs.additionalToEmails).toEqual(["jobarmsteam@gmail.com"]);
    // team@newcoworker.com is OURS and drops out entirely.
    expect(sendArgs.additionalToEmails).not.toContain("team@newcoworker.com");
    // The original had no Cc, so neither does the reply.
    expect(sendArgs.ccEmails ?? []).toEqual([]);
  });

  it("keeps a Cc recipient on Cc rather than promoting them", async () => {
    // The mirror has to work in both directions, or "mirror" just means
    // "everyone on To".
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "t-mix",
      providerMessageId: "m-mix",
      replyToRecipients: ["prospect@example.com"],
      replyCcRecipients: ["assistant@example.com"]
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "g-mix",
      threadId: "t-mix",
      fromEmail: "team@newcoworker.com"
    } as never);

    await POST(makeRequest(REPLY_BODY));
    const sendArgs = vi.mocked(sendFromMailboxConnection).mock.calls[0][2] as {
      additionalToEmails?: string[];
      ccEmails?: string[];
    };
    expect(sendArgs.additionalToEmails).toEqual(["prospect@example.com"]);
    expect(sendArgs.ccEmails).toEqual(["assistant@example.com"]);
  });

  it("never lists the person already in To a second time", async () => {
    // The sender is normally on their own thread's To as well, and repeating
    // them looks like a mistake on a reply going to a prospect.
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "t-dup",
      providerMessageId: "m-dup",
      replyToRecipients: ["lead@example.com", "other@example.com"],
      replyCcRecipients: ["lead@example.com"]
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "g-dup",
      threadId: "t-dup",
      fromEmail: "team@newcoworker.com"
    } as never);

    await POST(makeRequest(REPLY_BODY));
    const sendArgs = vi.mocked(sendFromMailboxConnection).mock.calls[0][2] as {
      toEmail: string;
      additionalToEmails?: string[];
      ccEmails?: string[];
    };
    expect(sendArgs.toEmail).toBe("lead@example.com");
    expect(sendArgs.additionalToEmails).toEqual(["other@example.com"]);
    expect(sendArgs.ccEmails ?? []).toEqual([]);
  });

  it("claims the conversation even when the provider echoes no thread id", async () => {
    // Graph's /reply returns { messageId: null, threadId: null } even for a
    // threaded send. Keying the claim on the RESPONSE registers no ownership
    // on Microsoft, and the failure is silent: the reply itself lands fine,
    // so only the missing follow-ups would ever show it.
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(connRow("outlook"));
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({
      threadId: "graph-conversation-1",
      providerMessageId: "m9",
      replyToRecipients: [],
      replyCcRecipients: []
    });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "microsoft",
      messageId: null,
      threadId: null,
      fromEmail: "team@newcoworker.com"
    } as never);

    await POST(makeRequest(REPLY_BODY));
    expect(rememberSentThread).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "microsoft", threadId: "graph-conversation-1" })
    );
  });

  it("sends unthreaded, and claims nothing, when the row has no stored thread", async () => {
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue(null);
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "gmail-3",
      threadId: null,
      fromEmail: "team@newcoworker.com"
    } as never);

    const res = await POST(makeRequest(REPLY_BODY));
    expect(res.status).toBe(200);
    expect(vi.mocked(sendFromMailboxConnection).mock.calls[0][2]).not.toHaveProperty("thread");
    expect(rememberSentThread).not.toHaveBeenCalled();
  });

  it("does not resolve a reply target when the step declared none", async () => {
    await POST(makeRequest(validBody));
    expect(getEmailLogThreadIdentity).not.toHaveBeenCalled();
  });

  it("still returns ok when the thread claim throws", async () => {
    // Losing ownership costs an autonomous follow-up, never the email that
    // already went out.
    vi.mocked(getEmailLogThreadIdentity).mockResolvedValue({ threadId: "t1", replyToRecipients: [],
      replyCcRecipients: [] });
    vi.mocked(sendFromMailboxConnection).mockResolvedValue({
      ok: true,
      provider: "google",
      messageId: "gmail-4",
      threadId: "t1",
      fromEmail: "team@newcoworker.com"
    } as never);
    vi.mocked(rememberSentThread).mockRejectedValue(new Error("boom"));

    const res = await POST(makeRequest(REPLY_BODY));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true });
  });
});

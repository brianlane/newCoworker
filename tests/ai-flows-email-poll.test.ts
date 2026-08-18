import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/workspace/proxy", () => ({ workspaceProxyForBusiness: vi.fn() }));
vi.mock("@/lib/db/workspace-oauth-connections", () => ({
  getWorkspaceOAuthConnection: vi.fn()
}));
vi.mock("@/lib/voice-tools/connections", () => ({
  isEmailProviderConfigKey: (key: string) => ["google-mail", "gmail", "outlook"].includes(key),
  providerFromKey: (key: string) => (key === "outlook" ? "microsoft" : "google")
}));
vi.mock("@/lib/ai-flows/db", () => ({ enqueueAiFlowRun: vi.fn() }));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));
vi.mock("@/lib/db/email-log", () => ({ recordInboundTriggerEmail: vi.fn() }));

import {
  EMAIL_POLL_MAX_LIST_PAGES,
  gmailBodyText,
  gmailHeader,
  isOwnOutboundSender,
  threadsWeHaveRepliedOn,
  parseFromAddress,
  pollEmailTriggers
} from "@/lib/ai-flows/email-poll";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { workspaceProxyForBusiness } from "@/lib/workspace/proxy";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import { recordInboundTriggerEmail } from "@/lib/db/email-log";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = "33333333-3333-4333-8333-333333333333";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function flowRow(id: string, trigger: unknown, triggers?: unknown[], steps: unknown[] = []) {
  return {
    id,
    business_id: BIZ,
    definition: { version: 1, trigger, ...(triggers ? { triggers } : {}), steps }
  };
}

/** A flow that answers the email itself — the only kind that marks it read. */
const sendEmailStep = { id: "s_reply", type: "send_email" };

type SeenTable = {
  /** Rows every seen-lookup chunk returns (one row = one flow's marker). */
  rows?: Array<{ message_id: string }> | null;
  error?: { message: string };
  upsertError?: { message: string };
  pruneError?: { message: string };
  /** Captures upsert payloads for assertions. */
  upserts?: unknown[];
  /** email_coworker_seen rows: messages the email coworker has claimed. */
  coworkerRows?: Array<{ message_id: string }> | null;
  coworkerError?: { message: string };
  /** email_log write failures (run-id link / dedupe cleanup). */
  logUpdateError?: { message: string };
  logDeleteError?: { message: string };
};

/**
 * Chainable service-client stub serving the (paged) ai_flows listing and the
 * ai_flow_email_seen marker table (lookup / upsert / prune).
 */
function dbWithRange(range: ReturnType<typeof vi.fn>, seen: SeenTable = {}) {
  const order = vi.fn(() => ({ range }));
  // Listing chain: .select().eq(enabled).is(deleted_at).or(...).order().range()
  const or = vi.fn(() => ({ order }));
  const isDeleted = vi.fn(() => ({ or }));
  const eq1 = vi.fn(() => ({ is: isDeleted }));
  const flowsSelect = vi.fn(() => ({ eq: eq1 }));
  const seenIn2 = vi.fn(() =>
    Promise.resolve(
      seen.error
        ? { data: null, error: seen.error }
        : { data: seen.rows === undefined ? [] : seen.rows, error: null }
    )
  );
  const seenIn1 = vi.fn(() => ({ in: seenIn2 }));
  const seenSelect = vi.fn(() => ({ in: seenIn1 }));
  const seenUpsert = vi.fn((rows: unknown) => {
    seen.upserts?.push(rows);
    return Promise.resolve({ error: seen.upsertError ?? null });
  });
  const lt = vi.fn(() => Promise.resolve({ error: seen.pruneError ?? null }));
  const seenDelete = vi.fn(() => ({ lt }));
  // email_coworker_seen: the coworker's claim on a message, consulted so one
  // inbound reply never gets both a flow run and an autonomous answer.
  const coworkerIn = vi.fn(() =>
    Promise.resolve(
      seen.coworkerError
        ? { data: null, error: seen.coworkerError }
        : // `null` passes through (a driver can answer data: null), while an
          // unset option means "no claims".
          { data: seen.coworkerRows === undefined ? [] : seen.coworkerRows, error: null }
    )
  );
  const coworkerEq = vi.fn(() => ({ in: coworkerIn }));
  const coworkerSelect = vi.fn(() => ({ eq: coworkerEq }));
  // email_log: the run_id link after a successful enqueue, and the cleanup
  // delete when a dedupe collision means another tick logged its own row.
  const logChain = (err: { message: string } | null) => {
    const eq2 = vi.fn(() => Promise.resolve({ error: err }));
    const eq1 = vi.fn(() => ({ eq: eq2 }));
    return vi.fn(() => ({ eq: eq1 }));
  };
  const logUpdate = logChain(seen.logUpdateError ?? null);
  const logDelete = logChain(seen.logDeleteError ?? null);
  return {
    from: vi.fn((table: string) =>
      table === "ai_flow_email_seen"
        ? { select: seenSelect, upsert: seenUpsert, delete: seenDelete }
        : table === "email_coworker_seen"
          ? { select: coworkerSelect }
          : table === "email_log"
            ? { update: logUpdate, delete: logDelete }
            : { select: flowsSelect }
    )
  } as never;
}

/** Single-page convenience stub (fewer rows than one page ends the loop). */
function dbWith(
  rows: unknown[] | null,
  error: { message: string } | null = null,
  seen: SeenTable = {}
) {
  return dbWithRange(vi.fn().mockResolvedValue({ data: rows, error }), seen);
}

const emailTrigger = (conditions: unknown[] = []) => ({
  channel: "email",
  connectionId: CONN,
  conditions
});

const googleConn = {
  id: CONN,
  business_id: BIZ,
  provider_config_key: "google-mail",
  connection_id: "nango-conn-1"
};

describe("parseFromAddress", () => {
  it("unwraps display-name forms and passes bare addresses through", () => {
    expect(parseFromAddress("Jane Doe <jane@x.com>")).toBe("jane@x.com");
    expect(parseFromAddress(" jane@x.com ")).toBe("jane@x.com");
  });
});

describe("gmailHeader", () => {
  it("matches case-insensitively and defaults to empty", () => {
    const headers = [{ name: "FROM", value: "a@b.c" }];
    expect(gmailHeader(headers, "from")).toBe("a@b.c");
    expect(gmailHeader(headers, "Subject")).toBe("");
    expect(gmailHeader(undefined, "From")).toBe("");
  });
  it("tolerates nameless / valueless header entries", () => {
    expect(gmailHeader([{ value: "x" }, { name: "From" }], "From")).toBe("");
  });
});

describe("gmailBodyText", () => {
  it("prefers a text/plain part anywhere in the tree", () => {
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/html", body: { data: b64url("<p>html</p>") } },
        { mimeType: "text/plain", body: { data: b64url("plain body") } }
      ]
    };
    expect(gmailBodyText(payload)).toBe("plain body");
  });
  it("falls back to stripped text/html", () => {
    const payload = {
      mimeType: "text/html",
      body: { data: b64url("<p>Hi&nbsp;there</p>") }
    };
    expect(gmailBodyText(payload)).toBe("Hi there");
  });
  it("returns empty for missing payloads or partless trees", () => {
    expect(gmailBodyText(undefined)).toBe("");
    expect(gmailBodyText({ mimeType: "multipart/mixed", parts: [] })).toBe("");
  });

  it("re-derives from the html part when text/plain is stripped template junk", () => {
    const junkPlain = "*|MC:SUBJECT|*\n\np{\n margin:10px 0;\n}\nUse code 549829.";
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url(junkPlain) } },
        {
          mimeType: "text/html",
          body: {
            data: b64url(
              "<head><title>*|MC:SUBJECT|*</title><style>p{margin:10px 0}</style></head><body><p>Use code 549829.</p></body>"
            )
          }
        }
      ]
    };
    expect(gmailBodyText(payload)).toBe("Use code 549829.");
  });

  it("keeps a junk-looking text/plain when there is no html alternative", () => {
    const junkPlain = "*|MC:SUBJECT|* only text";
    const payload = { mimeType: "text/plain", body: { data: b64url(junkPlain) } };
    expect(gmailBodyText(payload)).toBe(junkPlain);
  });

  it("falls back to the plain part when the html part collapses to nothing", () => {
    const junkPlain = "*|MC:SUBJECT|* fallback text";
    const payload = {
      mimeType: "multipart/alternative",
      parts: [
        { mimeType: "text/plain", body: { data: b64url(junkPlain) } },
        { mimeType: "text/html", body: { data: b64url("<style>p{a:b}</style>") } }
      ]
    };
    expect(gmailBodyText(payload)).toBe(junkPlain);
  });
});

describe("pollEmailTriggers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(googleConn as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue({ id: "run-1" } as never);
  });

  it("throws on a flows query error", async () => {
    await expect(pollEmailTriggers(dbWith([], { message: "boom" }))).rejects.toThrow(
      "pollEmailTriggers: boom"
    );
  });

  it("returns immediately when no enabled email-trigger flows exist", async () => {
    const res = await pollEmailTriggers(dbWith([]));
    expect(res).toEqual({ flows: 0, mailboxes: 0, messages: 0, enqueued: 0 });
    expect(getWorkspaceOAuthConnection).not.toHaveBeenCalled();
  });

  it("tolerates a null data payload from the flows query", async () => {
    const res = await pollEmailTriggers(dbWith(null as never));
    expect(res.flows).toBe(0);
  });

  it("pages through the flow listing so flows past one page are not skipped", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => flowRow(`f${i}`, emailTrigger()));
    const page2 = [flowRow("f-last", emailTrigger())];
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: page2, error: null });
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const res = await pollEmailTriggers(dbWithRange(range));
    expect(res.flows).toBe(101);
    expect(range).toHaveBeenCalledTimes(2);
    expect(range).toHaveBeenNthCalledWith(2, 100, 199);
  });

  it("stringifies a non-Error mailbox failure", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockRejectedValueOnce("weird failure");
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("weird failure") })
    );
  });

  it("lazily creates a service client when none is supplied", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(dbWith([]) as never);
    await pollEmailTriggers();
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });

  it("skips rows whose stored trigger is not a usable email trigger", async () => {
    const res = await pollEmailTriggers(
      dbWith([
        flowRow("f-sms", { channel: "sms", conditions: [] }),
        flowRow("f-noconn", { channel: "email", conditions: [] })
      ])
    );
    expect(res.flows).toBe(0);
  });

  it("logs and isolates a missing / non-email connection", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValueOnce(null);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 0, enqueued: 0 });
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_email_poll_failed",
        message: expect.stringContaining("connection_not_found")
      })
    );

    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValueOnce({
      ...googleConn,
      provider_config_key: "slack"
    } as never);
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining("not_email_connection") })
    );
  });

  it("leaves a message the email coworker already claimed to the coworker", async () => {
    // Both polls read the same inbox each tick. A reply on a thread the
    // assistant started must not ALSO fire a flow, or the tenant gets two
    // uncoordinated answers to one email.
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: { messages: [{ id: "m1" }] }
    } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, {
        // A second, unclaimed id proves the filter is per message.
        coworkerRows: [{ message_id: "m1" }]
      })
    );
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 0, enqueued: 0 });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("omits message_ref when Gmail returns no Message-Id header", async () => {
    // Fails open the same way thread_id does: a blank identifier must not
    // reach the trigger scope, or a reply would thread against nothing.
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          threadId: "199abc4d5e6f7890",
          payload: {
            headers: [{ name: "From", value: "a@b.c" }],
            mimeType: "text/plain",
            body: { data: b64url("hello") }
          }
        }
      } as never);
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    const trigger = vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger;
    expect(trigger).not.toHaveProperty("message_ref");
    expect(trigger).toHaveProperty("thread_id", "199abc4d5e6f7890");
  });

  it("puts the email_log row id in the trigger scope, and links the run back", async () => {
    /**
     * The gap that shipped a broken reply. {{trigger.email_log_id}} is what a
     * send_email step resolves its thread from, but the scope was built BEFORE
     * the email_log row existed, so on the connected-mailbox channel it
     * rendered empty: the reply went out as a new conversation with a "Re:"
     * subject, un-cc'd and unclaimed, while looking right in the sent folder.
     *
     * Asserting the SCOPE, not a hand-fed fixture. The earlier plumbing test
     * supplied email_log_id itself and passed while production had none.
     */
    vi.mocked(recordInboundTriggerEmail).mockResolvedValue("elog-1" as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          threadId: "t-1",
          payload: {
            headers: [{ name: "From", value: "james@kypads.com" }],
            mimeType: "text/plain",
            body: { data: b64url("hello") }
          }
        }
      } as never);
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger).toMatchObject({
      email_log_id: "elog-1"
    });
    // Logged BEFORE the enqueue, or the id could not have been in the scope.
    expect(vi.mocked(recordInboundTriggerEmail).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(enqueueAiFlowRun).mock.invocationCallOrder[0]
    );
    // And the row still gets its run_id, so the Emails page links correctly.
    expect(vi.mocked(recordInboundTriggerEmail).mock.calls[0][0]).toMatchObject({ runId: null });
  });

  it("still enqueues when the email could not be logged", async () => {
    // Logging is best-effort: a failed insert must not cost the run. The
    // reply then opens its own thread rather than failing the step.
    vi.mocked(recordInboundTriggerEmail).mockResolvedValue(null as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [{ name: "From", value: "a@b.c" }],
            mimeType: "text/plain",
            body: { data: b64url("hello") }
          }
        }
      } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.enqueued).toBe(1);
    expect(vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger).not.toHaveProperty("email_log_id");
  });

  it("carries Gmail's threadId into the run trigger", async () => {
    // The conversation id every reply on a thread shares. It rides on the
    // messages.get response and used to be read past; without it a notify
    // step cannot tell an intro from its own "Re:" reply.
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          threadId: "199abc4d5e6f7890",
          payload: {
            headers: [
              { name: "From", value: "james@kypads.com" },
              { name: "Subject", value: "Re: Introductions" },
              { name: "Message-Id", value: "<CAJ=intro@mail.gmail.com>" },
              { name: "To", value: "Brian <brian@newcoworker.com>, king@clinic.example.com" },
              { name: "Cc", value: "assistant@kypads.com" }
            ],
            mimeType: "text/plain",
            body: { data: b64url("hello") }
          }
        }
      } as never);
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({
          thread_id: "199abc4d5e6f7890",
          message_ref: "<CAJ=intro@mail.gmail.com>",
          subject: "Re: Introductions",
          // The recipient list, on the SCOPE and not merely on the email_log
          // row. A drafter that cannot see who is on the mail writes "Bobby,
          // please reach out" to an email Bobby never receives. Asserting only
          // the log row is how message_ref reached production unreferenceable.
          to: "Brian <brian@newcoworker.com>, king@clinic.example.com",
          cc: "assistant@kypads.com"
        })
      }),
      expect.anything()
    );
    // And onto the email_log row, so {{trigger.email_log_id}} resolves to
    // something a reply can actually be threaded against.
    expect(recordInboundTriggerEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId: "199abc4d5e6f7890",
        messageRef: "<CAJ=intro@mail.gmail.com>",
        // Kept so an approved reply reaches the PROSPECT, who on an
        // introduction is on To while the introducer is in From.
        toRecipients: "Brian <brian@newcoworker.com>, king@clinic.example.com",
        ccRecipients: "assistant@kypads.com"
      }),
      expect.anything()
    );
  });

  it("never enqueues a run for mail sent from one of our own addresses", async () => {
    // The Aug 7 2026 loop, end to end through the real poller. The sales arm
    // replied-all onto team@newcoworker.com, our own catch-all alias, so the
    // reply arrived as genuinely RECEIVED mail and matched the flow again.
    // Six drafts went out before Brian stopped it.
    //
    // Driven from the raw Gmail payload rather than by calling the predicate,
    // because the bug was never in the predicate: it was that nothing
    // consulted one. `connectionEmail` reads newcoworkerteam@gmail.com off the
    // connection, which is exactly why a plain equality check missed team@.
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      metadata: { provider_account_email: "newcoworkerteam@gmail.com" }
    } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m-self" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [
              { name: "From", value: "Brian <team@newcoworker.com>" },
              { name: "Subject", value: "Re: Referral for Bobby" }
            ],
            mimeType: "text/plain",
            body: { data: b64url("Thanks for thinking of us, James!") }
          }
        }
      } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
    // Not merely unenqueued: it never counts as a message this poll handled.
    expect(res.enqueued).toBe(0);
    expect(res.messages).toBe(0);
    // Loud, because reaching here means -from:me let one through.
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        event: "ai_flow_email_poll_self_sent_skipped",
        payload: expect.objectContaining({ count: 1, from: ["team@newcoworker.com"] })
      })
    );
  });

  it("hands the scope our own address, so the prospect is whoever is left", async () => {
    /**
     * others_to is "everyone on the mail who is neither us nor the sender",
     * and the connected account can only drop out if the poller says what it
     * is. Without this the account address would look like a third party and
     * the prospect note would be addressed to our own mailbox.
     */
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      metadata: { provider_account_email: "newcoworkerteam@gmail.com" }
    } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [
              { name: "From", value: "james@kypads.com" },
              { name: "Subject", value: "Referral for Bobby" },
              {
                name: "To",
                value: "newcoworkerteam@gmail.com, bobby@bobbyjobs.example.com"
              }
            ],
            mimeType: "text/plain",
            body: { data: b64url("Meet Bobby") }
          }
        }
      } as never);
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ others_to: "bobby@bobbyjobs.example.com" })
      }),
      expect.anything()
    );
  });

  it("asks Gmail to exclude our own sends, using the provider's alias list", async () => {
    // `-from:me` is the first guard and the only one that knows about send-as
    // aliases on domains we cannot enumerate. Verified against the live HQ
    // mailbox: it drops the self-sent copies and keeps the real lead.
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: { messages: [] } } as never);
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    const endpoint = (vi.mocked(workspaceProxyForBusiness).mock.calls[0][2] as { endpoint: string })
      .endpoint;
    expect(decodeURIComponent(endpoint)).toContain("-from:me");
    expect(decodeURIComponent(endpoint)).toContain("in:inbox");
  });

  it("claims nothing when the coworker owns no messages in the window", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [{ name: "From", value: "leads@rx.com" }],
            mimeType: "text/plain",
            body: { data: b64url("hello") }
          }
        }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { coworkerRows: null })
    );
    expect(res.enqueued).toBe(1);
  });

  it("still runs flows when the coworker claim lookup fails", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [{ name: "From", value: "leads@rx.com" }],
            mimeType: "text/plain",
            body: { data: b64url("hello") }
          }
        }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, {
        coworkerError: { message: "table missing" }
      })
    );
    expect(res.enqueued).toBe(1);
    expect(err).toHaveBeenCalledWith("email coworker claim lookup", expect.anything());
    err.mockRestore();
  });

  it("polls Gmail, matches conditions, and enqueues with a per-message dedupe key", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }, {}] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [
              { name: "From", value: "Leads <leads@rx.com>" },
              { name: "Subject", value: "New referral" }
            ],
            mimeType: "text/plain",
            body: { data: b64url("Open https://rfrl.to/abc now") }
          }
        }
      } as never)
      // users.messages.modify: the triggering message is marked read.
      .mockResolvedValueOnce({ data: {} } as never);

    // Two flows watch the same mailbox: one matches (and can reply by
    // email, so it marks the message read), one does not.
    const res = await pollEmailTriggers(
      dbWith([
        flowRow("f-match", emailTrigger([{ type: "has_url" }]), undefined, [sendEmailStep]),
        flowRow("f-miss", emailTrigger([{ type: "contains", value: "unrelated" }]))
      ])
    );
    expect(res).toEqual({ flows: 2, mailboxes: 1, messages: 1, enqueued: 1 });
    // The triggering message was marked handled (read) in the owner's inbox.
    expect(workspaceProxyForBusiness).toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({
        endpoint: "/gmail/v1/users/me/messages/m1/modify",
        method: "POST",
        data: { removeLabelIds: ["UNREAD"] }
      })
    );
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        flowId: "f-match",
        dedupeKey: "email:m1",
        trigger: expect.objectContaining({
          channel: "email",
          from: "leads@rx.com",
          url: "https://rfrl.to/abc",
          received_at: new Date(1760000000000).toISOString()
        })
      }),
      expect.anything()
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_run_enqueued_email" })
    );
    // No threadId on this fixture's response: the key is omitted, not blank.
    expect(vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger).not.toHaveProperty("thread_id");
    // Same for the recipients: omitted, never blank, so step 1 of the drafter's
    // check ("is the To line blank?") sees a genuinely empty line.
    expect(vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger).not.toHaveProperty("to");
    expect(vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger).not.toHaveProperty("cc");
    // The triggering email is recorded for the dashboard Emails page.
    expect(recordInboundTriggerEmail).toHaveBeenCalledTimes(1);
    expect(recordInboundTriggerEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        flowId: "f-match",
        fromEmail: "leads@rx.com",
        subject: "New referral",
        providerMessageId: "m1"
      }),
      expect.anything()
    );
    // This fixture's response carries neither identifier, so neither key is
    // written: a reply against this row would go out unthreaded.
    const logged = vi.mocked(recordInboundTriggerEmail).mock.calls[0][0];
    expect(logged).not.toHaveProperty("threadId");
    expect(logged).not.toHaveProperty("messageRef");
    // Nor the recipients: this fixture's headers carry no To or Cc.
    expect(logged).not.toHaveProperty("toRecipients");
    expect(logged).not.toHaveProperty("ccRecipients");
  });

  it("marks a triggering Gmail message read ONCE even when several flows match it", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          payload: { mimeType: "text/plain", body: { data: b64url("See https://rfrl.to/a") } }
        }
      } as never)
      .mockResolvedValueOnce({ data: {} } as never);
    const res = await pollEmailTriggers(
      dbWith([
        flowRow("f-a", emailTrigger([{ type: "has_url" }]), undefined, [sendEmailStep]),
        flowRow("f-b", emailTrigger([{ type: "has_url" }]), undefined, [sendEmailStep])
      ])
    );
    expect(res.enqueued).toBe(2);
    const modifyCalls = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.filter((c) => c[2].endpoint.includes("/modify"));
    expect(modifyCalls).toHaveLength(1);
    expect(recordSystemLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_mark_read_failed" })
    );
  });

  it("logs a warning (and keeps the run) when the mark-read link is dead", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never)
      // modify → null (connection vanished between read and write)
      .mockResolvedValueOnce(null as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger(), undefined, [sendEmailStep])])
    );
    expect(res.enqueued).toBe(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_email_mark_read_failed",
        level: "warn",
        message: expect.stringContaining("email_not_connected"),
        payload: { message_id: "m1" }
      })
    );
  });

  it("stringifies a non-Error mark-read failure without failing the run", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never)
      .mockRejectedValueOnce("gmail hiccup" as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger(), undefined, [sendEmailStep])])
    );
    expect(res.enqueued).toBe(1);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_email_mark_read_failed",
        message: expect.stringContaining("gmail hiccup")
      })
    );
  });

  it("leaves the message UNREAD when only notify-only flows match (triage must not eat the inbox)", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([
        // Triage-style flow: classifies and texts the owner, never replies.
        flowRow("f-triage", emailTrigger(), undefined, [
          { id: "s_notify", type: "notify_owner", message: "heads up" }
        ]),
        // A stored definition without a steps array at all must also count
        // as notify-only, not crash or mark read.
        { id: "f-no-steps", business_id: BIZ, definition: { version: 1, trigger: emailTrigger() } }
      ])
    );
    expect(res.enqueued).toBe(2);
    const modifyCalls = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.filter((c) => c[2].endpoint.includes("/modify"));
    expect(modifyCalls).toHaveLength(0);
  });

  it("does NOT mark read when the send sits behind a branch (it might never run)", async () => {
    /**
     * Inverted deliberately. This used to assert that a send_email ANYWHERE
     * in the tree made the flow "reply-capable", and that is the bug Brian
     * hit: the HQ inbox triage grew a reply arm for sales leads and started
     * marking Zapier newsletters read on the way past, because a branch arm
     * counted as "this flow answers email".
     *
     * A conditional send might never run, and the poll cannot know at enqueue
     * time whether it will. Leaving mail unread that we answered is a shrug;
     * hiding mail nobody looked at is the failure this module's header
     * comment warns about.
     */
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([
        flowRow("f-branch", emailTrigger(), undefined, [
          // Degenerate shapes stored definitions can carry must contribute
          // nothing instead of crashing the walk.
          null,
          { id: "b-junk", type: "branch", branches: "junk" },
          {
            id: "b",
            type: "branch",
            branches: [
              { id: "arm-armless", label: "no steps array" },
              { id: "arm-reply", label: "reply", steps: [sendEmailStep] }
            ],
            else: []
          }
        ])
      ])
    );
    expect(res.enqueued).toBe(1);
    expect(workspaceProxyForBusiness).not.toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({ data: { removeLabelIds: ["UNREAD"] } })
    );
  });

  it("does NOT mark read when the trunk send carries a when guard", async () => {
    // Same reasoning one level down: a guarded trunk send is still a maybe.
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([
        flowRow("f-guarded", emailTrigger(), undefined, [
          { ...sendEmailStep, when: { var: "kind", equals: "sales" } }
        ])
      ])
    );
    expect(res.enqueued).toBe(1);
    expect(workspaceProxyForBusiness).not.toHaveBeenCalledWith(
      BIZ,
      expect.anything(),
      expect.objectContaining({ data: { removeLabelIds: ["UNREAD"] } })
    );
  });

  it("never touches read state on a Microsoft mailbox", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          {
            id: "ms1",
            subject: "Lead",
            from: { emailAddress: { address: "leads@rx.com" } },
            body: { contentType: "Text", content: "See https://rfrl.to/z" },
            receivedDateTime: "2026-06-09T15:00:00Z"
          }
        ]
      }
    } as never);
    // Even a reply-capable flow must not touch Microsoft read state.
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger([{ type: "has_url" }]), undefined, [sendEmailStep])])
    );
    expect(res.enqueued).toBe(1);
    const modifyCalls = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.filter((c) => c[2].endpoint.includes("/modify"));
    expect(modifyCalls).toHaveLength(0);
  });

  it("fires flows whose email trigger lives in the EXTRA triggers array, merging same-mailbox triggers (multi-trigger OR)", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [
              { name: "From", value: "Leads <leads@rx.com>" },
              { name: "Subject", value: "New referral" }
            ],
            mimeType: "text/plain",
            body: { data: b64url("Open https://rfrl.to/abc now") }
          }
        }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([
        // Primary is manual; TWO email triggers on the same mailbox live in
        // the extras (one misses, one matches) — merged to one entry, one run.
        flowRow("f-multi", { channel: "manual" }, [
          emailTrigger([{ type: "contains", value: "unrelated" }]),
          emailTrigger([{ type: "has_url" }])
        ]),
        // Extras with no email trigger anywhere → not an email flow at all.
        flowRow("f-no-email", { channel: "manual" }, [{ channel: "webhook", conditions: [] }])
      ])
    );
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 1, enqueued: 1 });
    expect(enqueueAiFlowRun).toHaveBeenCalledTimes(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ flowId: "f-multi", dedupeKey: "email:m1" }),
      expect.anything()
    );
  });

  it("fails closed when a from_matches contact ref cannot be resolved", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "1760000000000",
          payload: {
            headers: [
              { name: "From", value: "Leads <leads@rx.com>" },
              { name: "Subject", value: "New referral" }
            ],
            mimeType: "text/plain",
            body: { data: b64url("Open https://rfrl.to/abc now") }
          }
        }
      } as never);
    // The db stub has no contacts/roster query support, so resolution throws
    // and the ref condition must fail closed (no run enqueued) without
    // breaking the poll.
    const res = await pollEmailTriggers(
      dbWith([
        flowRow(
          "f-ref",
          emailTrigger([
            {
              type: "from_matches",
              ref: { source: "contact", id: "22222222-2222-4222-8222-222222222222" }
            }
          ])
        )
      ])
    );
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 1, enqueued: 0 });
    expect(enqueueAiFlowRun).not.toHaveBeenCalled();
  });

  it("treats a dedupe collision (null run) as already-enqueued, not a new run", async () => {
    vi.mocked(recordInboundTriggerEmail).mockClear();
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue(null);
    // rows: null also exercises a null data payload from the dedupe lookup.
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())], null, { rows: null }));
    expect(res.enqueued).toBe(0);
    expect(recordSystemLog).not.toHaveBeenCalled();
    // Logging now happens BEFORE the enqueue (the scope needs the row id), so
    // a lost race logs and then cleans up rather than never logging.
    expect(recordInboundTriggerEmail).toHaveBeenCalledTimes(1);
  });

  it("throws into the per-mailbox error path when the Gmail link is dead", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce(null);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.enqueued).toBe(0);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_email_poll_failed",
        message: expect.stringContaining("email_not_connected")
      })
    );
  });

  it("polls a Microsoft inbox (html body stripped, sent-folder excluded by endpoint)", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          {
            id: "ms1",
            subject: "Lead",
            from: { emailAddress: { address: "leads@rx.com" } },
            body: { contentType: "HTML", content: "<p>See https://rfrl.to/z</p>" },
            receivedDateTime: "2026-06-09T15:00:00Z"
          },
          { subject: "no id, dropped" }
        ]
      }
    } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger([{ type: "has_url" }]))]));
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 1, enqueued: 1 });
    const endpoint = vi.mocked(workspaceProxyForBusiness).mock.calls[0][2].endpoint;
    expect(endpoint).toContain("/me/mailFolders/inbox/messages");
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "email:ms1",
        trigger: expect.objectContaining({
          url: "https://rfrl.to/z",
          received_at: "2026-06-09T15:00:00Z"
        })
      }),
      expect.anything()
    );
  });

  it("handles a Microsoft text body and a null link", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({
        data: {
          value: [
            {
              id: "ms2",
              body: { contentType: "text", content: "plain words" }
            }
          ]
        }
      } as never)
      .mockResolvedValueOnce(null);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ windowText: "\nplain words", from: "" })
      }),
      expect.anything()
    );

    // Second poll: the list call returns null → mailbox error path.
    await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_poll_failed" })
    );
  });

  it("follows Gmail pagination across pages", async () => {
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("users/me/messages?")) {
        return cfg.endpoint.includes("pageToken=")
          ? { data: { messages: [{ id: "g2" }] } }
          : { data: { messages: [{ id: "g1" }], nextPageToken: "tok&1" } };
      }
      return {
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      };
    }) as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.messages).toBe(2);
    expect(res.enqueued).toBe(2);
    const listCalls = vi
      .mocked(workspaceProxyForBusiness)
      .mock.calls.filter((c) => (c[2] as { endpoint: string }).endpoint.includes("messages?"));
    expect(listCalls).toHaveLength(2);
    expect((listCalls[1][2] as { endpoint: string }).endpoint).toContain(
      `pageToken=${encodeURIComponent("tok&1")}`
    );
    expect(recordSystemLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_poll_overflow" })
    );
  });

  it("caps a Gmail burst at the per-poll max and logs an overflow warning", async () => {
    let page = 0;
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("users/me/messages?")) {
        page += 1;
        return {
          data: {
            messages: Array.from({ length: 25 }, (_, i) => ({ id: `p${page}-${i}` })),
            nextPageToken: `tok${page}`
          }
        };
      }
      return {
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      };
    }) as never);
    // A no-match condition keeps the assertion about fetching, not enqueueing.
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger([{ type: "contains", value: "no-match" }]))])
    );
    expect(res.messages).toBe(100);
    expect(res.enqueued).toBe(0);
    // Listing stops at the page guard, not the (infinite) token chain; reads
    // stop at the message cap.
    expect(page).toBe(EMAIL_POLL_MAX_LIST_PAGES);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_poll_overflow", level: "warn" })
    );
  });

  it("enforces the message cap exactly when the pending Gmail set overshoots it", async () => {
    let page = 0;
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("users/me/messages?")) {
        page += 1;
        return {
          data: {
            messages: Array.from({ length: 40 }, (_, i) => ({ id: `p${page}-${i}` })),
            // Finite 3-page listing: 120 ids, all pending → truncated reads.
            ...(page < 3 ? { nextPageToken: `tok${page}` } : {})
          }
        };
      }
      return {
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      };
    }) as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger([{ type: "contains", value: "no-match" }]))])
    );
    expect(res.messages).toBe(100); // 120 listed, reads truncated to the cap
    expect(page).toBe(3);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_poll_overflow" })
    );
  });

  it("skips already-handled Gmail messages without consuming the read budget", async () => {
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("users/me/messages?")) {
        return { data: { messages: [{ id: "m1" }, { id: "m2" }] } };
      }
      // Only the unhandled message may be detail-fetched.
      expect(cfg.endpoint).toContain("/messages/m2?");
      return {
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      };
    }) as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { rows: [{ message_id: "m1" }] })
    );
    expect(res.messages).toBe(1);
    expect(res.enqueued).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "email:m2" }),
      expect.anything()
    );
  });

  it("only skips a message once EVERY flow on the mailbox has evaluated it", async () => {
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("users/me/messages?")) {
        return { data: { messages: [{ id: "m1" }, { id: "m2" }] } };
      }
      return {
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      };
    }) as never);
    // Two flows; both already evaluated m1, neither evaluated m2.
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger()), flowRow("f2", emailTrigger())], null, {
        rows: [{ message_id: "m1" }, { message_id: "m1" }]
      })
    );
    expect(res.messages).toBe(1);
    expect(res.enqueued).toBe(2); // m2 evaluated (and enqueued) for both flows
  });

  it("keeps reading a message that only SOME flows have evaluated", async () => {
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async (
      _biz: string,
      _link: unknown,
      cfg: { endpoint: string }
    ) => {
      if (cfg.endpoint.includes("users/me/messages?")) {
        return { data: { messages: [{ id: "m1" }] } };
      }
      return {
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      };
    }) as never);
    // Two flows but only one marker — e.g. f2 was added after m1 arrived.
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger()), flowRow("f2", emailTrigger())], null, {
        rows: [{ message_id: "m1" }]
      })
    );
    expect(res.messages).toBe(1); // m1 re-read so f2 gets to evaluate it
  });

  it("records evaluation markers for matching AND non-matching flows", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    const upserts: unknown[] = [];
    await pollEmailTriggers(
      dbWith(
        [
          flowRow("f-match", emailTrigger()),
          flowRow("f-miss", emailTrigger([{ type: "contains", value: "no-match" }]))
        ],
        null,
        { upserts }
      )
    );
    expect(upserts).toEqual([
      [
        { flow_id: "f-match", message_id: "m1" },
        { flow_id: "f-miss", message_id: "m1" }
      ]
    ]);
  });

  it("routes a seen-lookup failure into the per-mailbox error path", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: { messages: [{ id: "m1" }] }
    } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { error: { message: "db down" } })
    );
    expect(res.enqueued).toBe(0);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_email_poll_failed",
        message: expect.stringContaining("seen lookup: db down")
      })
    );
  });

  it("routes a marker-write failure into the per-mailbox error path", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { upsertError: { message: "boom" } })
    );
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "ai_flow_email_poll_failed",
        message: expect.stringContaining("seen record: boom")
      })
    );
  });

  it("logs but survives a failed marker prune", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await pollEmailTriggers(
        dbWith([flowRow("f1", emailTrigger())], null, { pruneError: { message: "locked" } })
      );
      expect(res.mailboxes).toBe(1); // the poll itself proceeded
      expect(err).toHaveBeenCalledWith("ai_flow_email_seen prune", "locked");
    } finally {
      err.mockRestore();
    }
  });

  it("omits received_at for a malformed Gmail internalDate instead of throwing", async () => {
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: {
          internalDate: "not-a-number",
          payload: { mimeType: "text/plain", body: { data: b64url("hello") } }
        }
      } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.enqueued).toBe(1);
    const trigger = vi.mocked(enqueueAiFlowRun).mock.calls[0][0].trigger as {
      received_at?: string;
    };
    expect(trigger.received_at).toBeUndefined();
  });

  it("enforces the message cap exactly when a Microsoft page overshoots it", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    let call = 0;
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async () => {
      call += 1;
      return {
        data: {
          value: Array.from({ length: 40 }, (_, i) => ({
            id: `ms${call}-${i}`,
            body: { contentType: "text", content: "hi" }
          })),
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=${call * 40}`
        }
      };
    }) as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger([{ type: "contains", value: "no-match" }]))])
    );
    expect(res.messages).toBe(100);
    expect(call).toBe(3);
  });

  it("follows Microsoft @odata.nextLink pagination and caps runaway chains", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    let call = 0;
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async () => {
      call += 1;
      return {
        data: {
          value: Array.from({ length: 25 }, (_, i) => ({
            id: `ms${call}-${i}`,
            body: { contentType: "text", content: "hi" }
          })),
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=${call * 25}`
        }
      };
    }) as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger([{ type: "contains", value: "no-match" }]))])
    );
    expect(res.messages).toBe(100);
    expect(call).toBe(4);
    // The follow-up call used the nextLink's path + query, not the seed params.
    const second = vi.mocked(workspaceProxyForBusiness).mock.calls[1][2] as { endpoint: string };
    expect(second.endpoint).toBe("/v1.0/me/mailFolders/inbox/messages?$skip=25");
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_poll_overflow" })
    );
  });

  it("filters already-handled Microsoft messages out of the read budget", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          { id: "ms-old", body: { contentType: "text", content: "seen" } },
          { id: "ms-new", body: { contentType: "text", content: "fresh" } }
        ]
      }
    } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { rows: [{ message_id: "ms-old" }] })
    );
    expect(res.messages).toBe(1);
    expect(enqueueAiFlowRun).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "email:ms-new" }),
      expect.anything()
    );
  });

  it("stops an all-handled Microsoft chain at the page guard", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    let call = 0;
    vi.mocked(workspaceProxyForBusiness).mockImplementation((async () => {
      call += 1;
      return {
        data: {
          value: [{ id: "ms-seen", body: { contentType: "text", content: "x" } }],
          "@odata.nextLink": `https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$skip=${call}`
        }
      };
    }) as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { rows: [{ message_id: "ms-seen" }] })
    );
    expect(res.messages).toBe(0);
    expect(call).toBe(EMAIL_POLL_MAX_LIST_PAGES);
    expect(recordSystemLog).toHaveBeenCalledWith(
      expect.objectContaining({ event: "ai_flow_email_poll_overflow" })
    );
  });

  it("keeps already-listed flows when a later listing page fails", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => flowRow(`f${i}`, emailTrigger()));
    const range = vi
      .fn()
      .mockResolvedValueOnce({ data: page1, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: "page 2 boom" } });
    vi.mocked(workspaceProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await pollEmailTriggers(dbWithRange(range));
      expect(res.flows).toBe(100);
      expect(res.mailboxes).toBe(1); // all page-1 flows share one mailbox → still polled
      expect(err).toHaveBeenCalledWith(
        "pollEmailTriggers flow listing page",
        "page 2 boom"
      );
    } finally {
      err.mockRestore();
    }
  });

  it("handles a Gmail list without a messages array", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 0, enqueued: 0 });
  });

  it("defaults non-array stored conditions to match-everything", async () => {
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", { channel: "email", connectionId: CONN, conditions: "junk" })])
    );
    expect(res.flows).toBe(1);
  });

  it("tolerates Microsoft rows with missing bodies/content", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          { id: "no-body" },
          { id: "html-no-content", body: { contentType: "html" } }
        ]
      }
    } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.messages).toBe(2);
    expect(res.enqueued).toBe(2);
  });

  it("tolerates a Microsoft response without a value array", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue({
      ...googleConn,
      provider_config_key: "outlook"
    } as never);
    vi.mocked(workspaceProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.messages).toBe(0);
  });
});

describe("email_log bookkeeping around the enqueue", () => {
  // Own setup: this block sits outside the suite that owns the shared
  // beforeEach, so without it the poll bails before reaching the mailbox.
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(googleConn as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue({ id: "run-1" } as never);
  });

  it("deletes its own row when another tick won the dedupe race", async () => {
    // Logging moved AHEAD of the enqueue so the row id can ride in the scope.
    // The cost is that a lost race has already written a row, and leaving it
    // would double-list the message on the Emails page.
    vi.mocked(recordInboundTriggerEmail).mockResolvedValue("elog-dupe" as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue(null);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hi") } } }
      } as never);
    const db = dbWith([flowRow("f1", emailTrigger())]);
    const res = await pollEmailTriggers(db);
    expect(res.enqueued).toBe(0);
    expect((db as unknown as { from: ReturnType<typeof vi.fn> }).from).toHaveBeenCalledWith(
      "email_log"
    );
  });

  it("logs, but does not fail the poll, when the bookkeeping writes error", async () => {
    // Neither the run-id link nor the cleanup is worth losing a run over.
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recordInboundTriggerEmail).mockResolvedValue("elog-1" as never);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hi") } } }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { logUpdateError: { message: "boom" } })
    );
    expect(res.enqueued).toBe(1);
    expect(err).toHaveBeenCalledWith("email_log run link", "boom");
    err.mockRestore();
  });

  it("logs a failed dedupe cleanup without throwing", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(recordInboundTriggerEmail).mockResolvedValue("elog-2" as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue(null);
    vi.mocked(workspaceProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hi") } } }
      } as never);
    const res = await pollEmailTriggers(
      dbWith([flowRow("f1", emailTrigger())], null, { logDeleteError: { message: "nope" } })
    );
    expect(res.enqueued).toBe(0);
    expect(err).toHaveBeenCalledWith("email_log dedupe cleanup", "nope");
    err.mockRestore();
  });
});

describe("isOwnOutboundSender: the flow must never answer its own mail", () => {
  /**
   * Live, Aug 7 2026. The sales arm replied-all, which cc'd
   * team@newcoworker.com. That is our OWN alias: the Cloudflare catch-all
   * forwards it into the very mailbox this poller reads, so the reply came
   * back as genuinely RECEIVED mail, matched the flow again, and drafted
   * another reply. It went round six times before Brian stopped it.
   *
   * `in:inbox` does not help, because a self-addressed message really is
   * delivered to the inbox.
   */
  const DOMAIN = "newcoworker.com";
  const ACCOUNT = "newcoworkerteam@gmail.com";

  it("catches the account behind the OAuth grant", () => {
    expect(isOwnOutboundSender(ACCOUNT, ACCOUNT, DOMAIN)).toBe(true);
    expect(isOwnOutboundSender("  NewCoworkerTeam@Gmail.com ", ACCOUNT, DOMAIN)).toBe(true);
  });

  it("catches the catch-all aliases the account email never matches", () => {
    // The exact loop: provider_account_email is the gmail.com address, so a
    // plain equality check let team@ straight through.
    expect(isOwnOutboundSender("team@newcoworker.com", ACCOUNT, DOMAIN)).toBe(true);
    expect(isOwnOutboundSender("contact@newcoworker.com", ACCOUNT, DOMAIN)).toBe(true);
    // The caller passes a bare address: parseFromAddress has already unwrapped
    // the "Brian <team@newcoworker.com>" display form by this point.
    expect(isOwnOutboundSender(parseFromAddress("Brian <team@newcoworker.com>"), ACCOUNT, DOMAIN)).toBe(true);
  });

  it("lets real inbound mail through, which is the half that matters most", () => {
    // Over-matching here silently drops leads, which is worse than the loop.
    expect(isOwnOutboundSender("fullvanair@gmail.com", ACCOUNT, DOMAIN)).toBe(false);
    expect(isOwnOutboundSender("james@kypads.com", ACCOUNT, DOMAIN)).toBe(false);
    // A lookalike domain is NOT ours: suffix matching would be a real bug.
    expect(isOwnOutboundSender("someone@notnewcoworker.com", ACCOUNT, DOMAIN)).toBe(false);
    expect(isOwnOutboundSender("someone@newcoworker.com.evil.test", ACCOUNT, DOMAIN)).toBe(false);
  });

  it("degrades safely on junk", () => {
    expect(isOwnOutboundSender("", ACCOUNT, DOMAIN)).toBe(false);
    expect(isOwnOutboundSender("   ", ACCOUNT, DOMAIN)).toBe(false);
    expect(isOwnOutboundSender("not-an-address", ACCOUNT, DOMAIN)).toBe(false);
    // No account on the connection row still leaves the domain rule working.
    expect(isOwnOutboundSender("team@newcoworker.com", null, DOMAIN)).toBe(true);
    expect(isOwnOutboundSender("james@kypads.com", null, DOMAIN)).toBe(false);
  });
});

describe("threadsWeHaveRepliedOn: a conversation we are in is never routine", () => {
  /**
   * The signal behind {{trigger.thread_has_our_reply}}. Live, Aug 9 2026:
   * Google acknowledged our OWN OAuth verification request on a thread Brian
   * had replied to on Jul 30, and the flow filed it as routine and binned it.
   */
  const chain = (result: { data: unknown; error: { message: string } | null }) => {
    const inFn = vi.fn().mockResolvedValue(result);
    const eqDir = vi.fn(() => ({ in: inFn }));
    const eqBiz = vi.fn(() => ({ eq: eqDir }));
    const select = vi.fn(() => ({ eq: eqBiz }));
    return { db: { from: vi.fn(() => ({ select })) }, select, eqBiz, eqDir, inFn };
  };

  it("returns only the threads we have actually sent on", async () => {
    const c = chain({ data: [{ thread_id: "t1" }, { thread_id: "t3" }], error: null });
    const out = await threadsWeHaveRepliedOn("biz", ["t1", "t2", "t3"], c.db as never);
    expect([...out].sort()).toEqual(["t1", "t3"]);
    // Scoped to the business AND to outbound: an inbound row on the thread is
    // the message we are classifying, not evidence we ever answered.
    expect(c.eqBiz).toHaveBeenCalledWith("business_id", "biz");
    expect(c.eqDir).toHaveBeenCalledWith("direction", "outbound");
  });

  it("dedupes and skips blanks before querying", async () => {
    const c = chain({ data: [], error: null });
    await threadsWeHaveRepliedOn("biz", ["t1", "t1", "  ", "t2"], c.db as never);
    expect(c.inFn).toHaveBeenCalledWith("thread_id", ["t1", "t2"]);
  });

  it("does not query at all when no message carried a thread id", async () => {
    const c = chain({ data: [], error: null });
    expect(await threadsWeHaveRepliedOn("biz", ["", "   "], c.db as never)).toEqual(new Set());
    expect(c.select).not.toHaveBeenCalled();
  });

  it("degrades to 'we have not replied' on a read failure, never a thrown poll", async () => {
    // Fail-safe direction chosen on purpose: the worst case is the triage it
    // had before this existed, not a mailbox that stops being polled.
    const c = chain({ data: null, error: { message: "boom" } });
    expect(await threadsWeHaveRepliedOn("biz", ["t1"], c.db as never)).toEqual(new Set());
  });

  it("treats a null payload as no replies", async () => {
    // PostgREST can answer with neither rows nor an error.
    const c = chain({ data: null, error: null });
    expect(await threadsWeHaveRepliedOn("biz", ["t1"], c.db as never)).toEqual(new Set());
  });

  it("survives a non-Error thrown from the client", async () => {
    // The catch logs `String(e)` for anything that is not an Error, and a
    // driver that rejects with a plain string must not take the poll down.
    const db = {
      from: () => {
        throw "connection reset";
      }
    };
    expect(await threadsWeHaveRepliedOn("biz", ["t1"], db as never)).toEqual(new Set());
  });

  it("ignores rows whose thread id came back null", async () => {
    const c = chain({ data: [{ thread_id: null }, { thread_id: "t9" }], error: null });
    expect([...(await threadsWeHaveRepliedOn("biz", ["t9"], c.db as never))]).toEqual(["t9"]);
  });
});

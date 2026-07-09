import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: vi.fn() }));
vi.mock("@/lib/nango/workspace", () => ({ nangoProxyForBusiness: vi.fn() }));
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
  parseFromAddress,
  pollEmailTriggers
} from "@/lib/ai-flows/email-poll";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";
import { enqueueAiFlowRun } from "@/lib/ai-flows/db";
import { recordSystemLog } from "@/lib/db/system-logs";
import { recordInboundTriggerEmail } from "@/lib/db/email-log";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = "33333333-3333-4333-8333-333333333333";

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function flowRow(id: string, trigger: unknown, triggers?: unknown[]) {
  return {
    id,
    business_id: BIZ,
    definition: { version: 1, trigger, ...(triggers ? { triggers } : {}), steps: [] }
  };
}

type SeenTable = {
  /** Rows every seen-lookup chunk returns (one row = one flow's marker). */
  rows?: Array<{ message_id: string }> | null;
  error?: { message: string };
  upsertError?: { message: string };
  pruneError?: { message: string };
  /** Captures upsert payloads for assertions. */
  upserts?: unknown[];
};

/**
 * Chainable service-client stub serving the (paged) ai_flows listing and the
 * ai_flow_email_seen marker table (lookup / upsert / prune).
 */
function dbWithRange(range: ReturnType<typeof vi.fn>, seen: SeenTable = {}) {
  const order = vi.fn(() => ({ range }));
  // Listing chain: .select().eq(enabled).or(primary-email-or-has-extras).order().range()
  const or = vi.fn(() => ({ order }));
  const eq1 = vi.fn(() => ({ or }));
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
  return {
    from: vi.fn((table: string) =>
      table === "ai_flow_email_seen"
        ? { select: seenSelect, upsert: seenUpsert, delete: seenDelete }
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
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

  it("polls Gmail, matches conditions, and enqueues with a per-message dedupe key", async () => {
    vi.mocked(nangoProxyForBusiness)
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
      } as never);

    // Two flows watch the same mailbox: one matches, one does not.
    const res = await pollEmailTriggers(
      dbWith([
        flowRow("f-match", emailTrigger([{ type: "has_url" }])),
        flowRow("f-miss", emailTrigger([{ type: "contains", value: "unrelated" }]))
      ])
    );
    expect(res).toEqual({ flows: 2, mailboxes: 1, messages: 1, enqueued: 1 });
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
  });

  it("fires flows whose email trigger lives in the EXTRA triggers array, merging same-mailbox triggers (multi-trigger OR)", async () => {
    vi.mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness)
      .mockResolvedValueOnce({ data: { messages: [{ id: "m1" }] } } as never)
      .mockResolvedValueOnce({
        data: { payload: { mimeType: "text/plain", body: { data: b64url("hello") } } }
      } as never);
    vi.mocked(enqueueAiFlowRun).mockResolvedValue(null);
    // rows: null also exercises a null data payload from the dedupe lookup.
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())], null, { rows: null }));
    expect(res.enqueued).toBe(0);
    expect(recordSystemLog).not.toHaveBeenCalled();
    expect(recordInboundTriggerEmail).not.toHaveBeenCalled();
  });

  it("throws into the per-mailbox error path when the Gmail link is dead", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce(null);
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
      data: {
        value: [
          {
            id: "ms1",
            subject: "Lead",
            from: { emailAddress: { address: "leads@rx.com" } },
            body: { contentType: "HTML", content: "<p>See https://rfrl.to/z</p>" },
            receivedDateTime: "2026-06-09T15:00:00Z"
          },
          { subject: "no id — dropped" }
        ]
      }
    } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger([{ type: "has_url" }]))]));
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 1, enqueued: 1 });
    const endpoint = vi.mocked(nangoProxyForBusiness).mock.calls[0][2].endpoint;
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
    vi.mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
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
      .mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (
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
    vi.mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
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
    vi.mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
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
    vi.mocked(nangoProxyForBusiness)
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async () => {
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async () => {
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
    const second = vi.mocked(nangoProxyForBusiness).mock.calls[1][2] as { endpoint: string };
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
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
    vi.mocked(nangoProxyForBusiness).mockImplementation((async () => {
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res).toEqual({ flows: 1, mailboxes: 1, messages: 0, enqueued: 0 });
  });

  it("defaults non-array stored conditions to match-everything", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({
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
    vi.mocked(nangoProxyForBusiness).mockResolvedValueOnce({ data: {} } as never);
    const res = await pollEmailTriggers(dbWith([flowRow("f1", emailTrigger())]));
    expect(res.messages).toBe(0);
  });
});

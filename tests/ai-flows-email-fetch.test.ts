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

import { pickBestMatch, findMatchingInboundEmail } from "@/lib/ai-flows/email-fetch";
import type { InboundEmailMessage } from "@/lib/ai-flows/trigger-eval";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { nangoProxyForBusiness } from "@/lib/nango/workspace";
import { getWorkspaceOAuthConnection } from "@/lib/db/workspace-oauth-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONN = "33333333-3333-4333-8333-333333333333";
const DB = { tag: "db" } as never;

function b64url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
}

function msg(p: Partial<InboundEmailMessage> & { id: string }): InboundEmailMessage {
  return { fromEmail: "", subject: "", bodyText: "", ...p };
}

beforeEach(() => {
  vi.mocked(getWorkspaceOAuthConnection).mockReset();
  vi.mocked(nangoProxyForBusiness).mockReset();
  vi.mocked(createSupabaseServiceClient).mockReset();
});

describe("pickBestMatch", () => {
  it("returns the most recent message that passes both filters", () => {
    const messages = [
      msg({
        id: "old",
        fromEmail: "platform-support@homelight.com",
        bodyText: "Client Details for Javier",
        receivedAt: "2026-06-26T10:00:00Z"
      }),
      msg({
        id: "new",
        fromEmail: "platform-support@homelight.com",
        bodyText: "Client Details for Javier",
        receivedAt: "2026-06-26T11:00:00Z"
      })
    ];
    expect(pickBestMatch(messages, "homelight.com", ["javier"])?.id).toBe("new");
  });

  it("requires ALL body terms (disambiguates same-first-name leads by city)", () => {
    const messages = [
      msg({ id: "mesa", bodyText: "Javier in Mesa, AZ", receivedAt: "2026-06-26T11:00:00Z" }),
      msg({ id: "tucson", bodyText: "Javier in Tucson, AZ", receivedAt: "2026-06-26T11:30:00Z" })
    ];
    // Even though the Tucson email is newer, only the Mesa one has BOTH terms.
    expect(pickBestMatch(messages, "", ["Javier", "Mesa"])?.id).toBe("mesa");
  });

  it("filters by sender (case-insensitive substring)", () => {
    const messages = [
      msg({ id: "a", fromEmail: "noreply@zillow.com", bodyText: "Javier" }),
      msg({ id: "b", fromEmail: "Platform-Support@HomeLight.com", bodyText: "Javier" })
    ];
    expect(pickBestMatch(messages, "homelight.com", [])?.id).toBe("b");
  });

  it("matches each term against subject OR body and ignores blank terms", () => {
    const messages = [
      msg({ id: "subj", subject: "Re: Javier referral", bodyText: "lives in Mesa" }),
      msg({ id: "none", subject: "unrelated", bodyText: "unrelated" })
    ];
    expect(pickBestMatch(messages, "", ["javier", "  ", "mesa"])?.id).toBe("subj");
  });

  it("returns null when not every term matches", () => {
    const messages = [msg({ id: "a", fromEmail: "x@y.com", bodyText: "Javier in Tucson" })];
    expect(pickBestMatch(messages, "", ["javier", "mesa"])).toBeNull();
  });

  it("empty filters match anything; a dated message beats an undated one", () => {
    const messages = [
      msg({ id: "dated", receivedAt: "2026-06-26T10:00:00Z" }),
      msg({ id: "undated" })
    ];
    expect(pickBestMatch(messages, "", [])?.id).toBe("dated");
  });
});

function conn(provider_config_key: string) {
  return { connection_id: "nango-conn", provider_config_key } as never;
}

describe("findMatchingInboundEmail: connection guards", () => {
  it("throws when the connection is missing", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(null as never);
    await expect(
      findMatchingInboundEmail({ businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 }, DB)
    ).rejects.toThrow("connection_not_found");
  });

  it("throws when the connection is not an email provider", async () => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(conn("google-calendar"));
    await expect(
      findMatchingInboundEmail({ businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 }, DB)
    ).rejects.toThrow("not_email_connection");
  });

  it("creates a service client when none is passed", async () => {
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(DB);
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(null as never);
    await expect(
      findMatchingInboundEmail({ businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 })
    ).rejects.toThrow("connection_not_found");
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

describe("findMatchingInboundEmail: Gmail", () => {
  beforeEach(() => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(conn("google-mail"));
  });

  it("reads the inbox, parses messages, and returns the best match with receivedAt", async () => {
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (_biz: string, _link: unknown, req: { endpoint: string }) => {
      const endpoint = req.endpoint;
      if (endpoint.includes("/messages?")) {
        return { data: { messages: [{ id: "m1" }, { id: "m2" }, { id: "skip" }] } } as never;
      }
      if (endpoint.includes("/messages/m1")) {
        return {
          data: {
            payload: {
              headers: [
                { name: "From", value: "HomeLight <platform-support@homelight.com>" },
                { name: "Subject", value: "Client Details" }
              ],
              mimeType: "text/plain",
              body: { data: b64url("Phone (917) 862-8675 for Javier") }
            },
            internalDate: "1719400000000"
          }
        } as never;
      }
      if (endpoint.includes("/messages/m2")) {
        // Non-numeric internalDate → Number.isFinite(false) → receivedAt undefined.
        return {
          data: {
            payload: {
              headers: [{ name: "From", value: "other@zillow.com" }],
              mimeType: "text/plain",
              body: { data: b64url("unrelated") }
            },
            internalDate: "notanumber"
          }
        } as never;
      }
      return null as never; // "skip" id → res null → continue branch
    }) as never);

    const r = await findMatchingInboundEmail(
      { businessId: BIZ, connectionId: CONN, fromContains: "homelight.com", bodyContains: ["Javier"], lookbackMinutes: 30 },
      DB
    );
    expect(r).toEqual({
      found: true,
      subject: "Client Details",
      from: "platform-support@homelight.com",
      bodyText: "Phone (917) 862-8675 for Javier",
      receivedAt: new Date(1719400000000).toISOString()
    });
  });

  it("returns found:false (no receivedAt) when the only match has no internalDate and nothing else matches", async () => {
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (_biz: string, _link: unknown, req: { endpoint: string }) => {
      const endpoint = req.endpoint;
      if (endpoint.includes("/messages?")) return { data: { messages: [{ id: "m1" }] } } as never;
      return {
        data: {
          payload: {
            headers: [{ name: "From", value: "x@nomatch.com" }],
            mimeType: "text/plain",
            body: { data: b64url("nothing here") }
          }
        }
      } as never;
    }) as never);

    const r = await findMatchingInboundEmail(
      { businessId: BIZ, connectionId: CONN, fromContains: "homelight.com", lookbackMinutes: 30 },
      DB
    );
    expect(r).toEqual({ found: false });
  });

  it("returns found:true WITHOUT receivedAt when the match lacks internalDate", async () => {
    vi.mocked(nangoProxyForBusiness).mockImplementation((async (_biz: string, _link: unknown, req: { endpoint: string }) => {
      const endpoint = req.endpoint;
      if (endpoint.includes("/messages?")) return { data: { messages: [{ id: "m1" }] } } as never;
      return {
        data: {
          payload: {
            headers: [{ name: "From", value: "platform-support@homelight.com" }],
            mimeType: "text/plain",
            body: { data: b64url("Javier details") }
          }
        }
      } as never;
    }) as never);

    const r = await findMatchingInboundEmail(
      { businessId: BIZ, connectionId: CONN, fromContains: "homelight.com", lookbackMinutes: 30 },
      DB
    );
    expect(r).toMatchObject({ found: true, from: "platform-support@homelight.com" });
    expect((r as { receivedAt?: string }).receivedAt).toBeUndefined();
  });

  it("handles an empty inbox listing (no messages field)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const r = await findMatchingInboundEmail(
      { businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 },
      DB
    );
    expect(r).toEqual({ found: false });
  });

  it("throws when the mailbox list call fails (not connected)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    await expect(
      findMatchingInboundEmail({ businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 }, DB)
    ).rejects.toThrow("email_not_connected");
  });
});

describe("findMatchingInboundEmail: Microsoft", () => {
  beforeEach(() => {
    vi.mocked(getWorkspaceOAuthConnection).mockResolvedValue(conn("outlook"));
  });

  it("reads Graph messages, converts HTML bodies, and returns the best match", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({
      data: {
        value: [
          {
            id: "g1",
            subject: "Client Details",
            from: { emailAddress: { address: "platform-support@homelight.com" } },
            body: { contentType: "HTML", content: "<p>Phone for Javier</p>" },
            receivedDateTime: "2026-06-26T11:00:00Z"
          },
          {
            // plain-text body + missing subject/from → defaults branches
            id: "g2",
            body: { contentType: "text", content: "no name" }
          },
          // HTML body with no content → `?? ""` branch on the html path.
          { id: "g3", body: { contentType: "html" } },
          // Text body with no content → `?? ""` branch on the text path.
          { id: "g4", body: { contentType: "text" } }
        ]
      }
    } as never);

    const r = await findMatchingInboundEmail(
      { businessId: BIZ, connectionId: CONN, fromContains: "homelight.com", bodyContains: ["Javier"], lookbackMinutes: 30 },
      DB
    );
    expect(r).toEqual({
      found: true,
      subject: "Client Details",
      from: "platform-support@homelight.com",
      bodyText: "Phone for Javier",
      receivedAt: "2026-06-26T11:00:00Z"
    });
  });

  it("handles an empty Graph response (no value field)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue({ data: {} } as never);
    const r = await findMatchingInboundEmail(
      { businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 },
      DB
    );
    expect(r).toEqual({ found: false });
  });

  it("throws when the Graph call fails (not connected)", async () => {
    vi.mocked(nangoProxyForBusiness).mockResolvedValue(null as never);
    await expect(
      findMatchingInboundEmail({ businessId: BIZ, connectionId: CONN, lookbackMinutes: 30 }, DB)
    ).rejects.toThrow("email_not_connected");
  });
});

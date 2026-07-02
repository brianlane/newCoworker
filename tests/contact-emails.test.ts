import { beforeEach, describe, expect, it, vi } from "vitest";

const defaultClientSpy = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn(async () => defaultClientSpy())
}));

import { extractEmailAddress } from "@/lib/email/address";
import { findContactsByEmails } from "@/lib/db/contact-emails";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("extractEmailAddress", () => {
  it("lowercases and trims a plain address", () => {
    expect(extractEmailAddress("  Ken.Harwood@Yahoo.com ")).toBe("ken.harwood@yahoo.com");
  });

  it("pulls the address out of a 'Name <addr>' header string", () => {
    expect(extractEmailAddress("Ken Harwood <sunlizard360@yahoo.com>")).toBe(
      "sunlizard360@yahoo.com"
    );
    expect(extractEmailAddress('"Harwood, Ken" <Ken@Example.COM>')).toBe("ken@example.com");
  });

  it("returns null for empty / missing / non-address values", () => {
    expect(extractEmailAddress(null)).toBeNull();
    expect(extractEmailAddress(undefined)).toBeNull();
    expect(extractEmailAddress("")).toBeNull();
    expect(extractEmailAddress("   ")).toBeNull();
    expect(extractEmailAddress("not an email")).toBeNull();
    expect(extractEmailAddress("Name <not-an-email>")).toBeNull();
  });
});

type CallLog = { name: string; args: unknown[] };

function makeClient(terminator: { data?: unknown; error?: unknown }) {
  const fromCalls: Array<{ table: string; calls: CallLog[] }> = [];
  const client = {
    from(table: string) {
      const calls: CallLog[] = [];
      const builder: Record<string, unknown> = {};
      for (const m of ["select", "eq", "not", "limit"]) {
        builder[m] = (...args: unknown[]) => {
          calls.push({ name: m, args });
          return builder;
        };
      }
      builder["then"] = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
        Promise.resolve(terminator).then(resolve, reject);
      fromCalls.push({ table, calls });
      return builder;
    }
  } as unknown as Parameters<typeof findContactsByEmails>[2];
  return { client, fromCalls };
}

describe("findContactsByEmails", () => {
  const CONTACTS = [
    { customer_e164: "+15551230001", display_name: "Ken Harwood", email: "SunLizard360@yahoo.com" },
    { customer_e164: "+15551230002", display_name: "  ", email: "snyderb8@comcast.net" },
    { customer_e164: "+15551230003", display_name: "Dup A", email: "dup@x.com" },
    { customer_e164: "+15551230004", display_name: "Dup B", email: "dup@x.com" },
    { customer_e164: "+15551230005", display_name: "No email", email: null }
  ];

  it("matches case-insensitively, handles 'Name <addr>' inputs, and skips unmatched addresses", async () => {
    const { client, fromCalls } = makeClient({ data: CONTACTS, error: null });
    const out = await findContactsByEmails(
      BIZ,
      [
        "Ken Harwood <sunlizard360@YAHOO.com>",
        "SNYDERB8@comcast.net",
        "stranger@nowhere.com",
        null,
        undefined,
        ""
      ],
      client
    );
    expect(out.get("sunlizard360@yahoo.com")).toEqual({
      customerE164: "+15551230001",
      displayName: "Ken Harwood"
    });
    // Whitespace-only display_name is normalized to null.
    expect(out.get("snyderb8@comcast.net")).toEqual({
      customerE164: "+15551230002",
      displayName: null
    });
    expect(out.has("stranger@nowhere.com")).toBe(false);
    expect(out.size).toBe(2);
    // Query shape: business-scoped contacts with a non-null email, capped.
    const fr = fromCalls[0]!;
    expect(fr.table).toBe("contacts");
    expect(fr.calls.find((c) => c.name === "eq")?.args).toEqual(["business_id", BIZ]);
    expect(fr.calls.find((c) => c.name === "not")?.args).toEqual(["email", "is", null]);
    expect(fr.calls.find((c) => c.name === "limit")?.args[0]).toBe(2000);
  });

  it("first match wins when two contacts share an email", async () => {
    const { client } = makeClient({ data: CONTACTS, error: null });
    const out = await findContactsByEmails(BIZ, ["dup@x.com"], client);
    expect(out.get("dup@x.com")?.customerE164).toBe("+15551230003");
  });

  it("returns an empty map without querying when no usable addresses are given", async () => {
    const { client, fromCalls } = makeClient({ data: CONTACTS, error: null });
    const out = await findContactsByEmails(BIZ, [null, undefined, "", "not an email"], client);
    expect(out.size).toBe(0);
    expect(fromCalls).toHaveLength(0);
  });

  it("tolerates null data and propagates PostgREST errors", async () => {
    const empty = makeClient({ data: null, error: null });
    expect((await findContactsByEmails(BIZ, ["a@b.com"], empty.client)).size).toBe(0);

    const errored = makeClient({ data: null, error: { message: "rls" } });
    await expect(findContactsByEmails(BIZ, ["a@b.com"], errored.client)).rejects.toThrow(
      /findContactsByEmails: rls/
    );
  });

  it("falls back to the default service client when none is provided", async () => {
    const { client } = makeClient({ data: [], error: null });
    defaultClientSpy.mockReturnValue(client);
    await findContactsByEmails(BIZ, ["a@b.com"]);
    expect(createSupabaseServiceClient).toHaveBeenCalledTimes(1);
  });
});

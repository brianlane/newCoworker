import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  evaluateSignIn,
  hasNewCoworkerAccount,
  isFreshlyMintedUser,
  isOAuthOnlySignIn,
  signInProviders,
  NO_ACCOUNT_ERROR,
  ORPHAN_DELETE_WINDOW_MS,
  type AccountLookupClient,
  type SignInUser
} from "@/lib/auth/account-gate";

type TableResult = { data: unknown[] | null; error: { message: string } | null };

/**
 * Stub of the two lookups the gate makes, keyed by table. Records the
 * arguments so the escaping and the revoked-membership filter are asserted
 * against what actually reaches PostgREST.
 */
function stubDb(results: Record<string, TableResult>) {
  const calls: Array<{ table: string; column: string; value: string; neq?: [string, string] }> = [];
  const client: AccountLookupClient = {
    from(table: string) {
      const result = results[table] ?? { data: [], error: null };
      return {
        select() {
          return {
            ilike(column: string, pattern: string) {
              calls.push({ table, column, value: pattern });
              return { limit: async () => result };
            },
            eq(column: string, value: string) {
              return {
                neq(neqColumn: string, neqValue: string) {
                  calls.push({ table, column, value, neq: [neqColumn, neqValue] });
                  return { limit: async () => result };
                }
              };
            }
          };
        }
      };
    }
  };
  return { client, calls };
}

const googleUser: SignInUser = {
  id: "user-1",
  email: "Stranger@Gmail.com",
  created_at: "2026-08-10T23:00:00.000Z",
  identities: [{ provider: "google" }],
  app_metadata: { provider: "google", providers: ["google"] }
};

const NOW = Date.parse("2026-08-10T23:00:01.000Z");

describe("auth/account-gate", () => {
  const originalAdmin = process.env.ADMIN_EMAIL;

  beforeEach(() => {
    delete process.env.ADMIN_EMAIL;
  });

  afterEach(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_EMAIL;
    else process.env.ADMIN_EMAIL = originalAdmin;
  });

  it("exports the login error token the callback redirects with", () => {
    expect(NO_ACCOUNT_ERROR).toBe("no_account");
  });

  describe("signInProviders", () => {
    it("prefers identities and lowercases them", () => {
      expect(signInProviders({ id: "u", identities: [{ provider: "Google" }] })).toEqual(["google"]);
    });

    it("skips identity rows with a blank provider", () => {
      expect(
        signInProviders({ id: "u", identities: [{ provider: "  " }, { provider: null }] })
      ).toEqual([]);
    });

    it("falls back to app_metadata.providers when identities are absent", () => {
      expect(
        signInProviders({ id: "u", identities: null, app_metadata: { providers: ["email"] } })
      ).toEqual(["email"]);
    });

    it("falls back to the singular app_metadata.provider", () => {
      expect(signInProviders({ id: "u", app_metadata: { provider: "google" } })).toEqual(["google"]);
    });

    it("returns nothing when there is no provider information at all", () => {
      expect(signInProviders({ id: "u" })).toEqual([]);
      expect(signInProviders({ id: "u", app_metadata: { provider: null, providers: null } })).toEqual(
        []
      );
    });
  });

  describe("isOAuthOnlySignIn", () => {
    it("is true for a google-only login", () => {
      expect(isOAuthOnlySignIn(googleUser)).toBe(true);
    });

    it("is false once an email identity exists (password signup, or google linked onto one)", () => {
      expect(
        isOAuthOnlySignIn({ id: "u", identities: [{ provider: "email" }, { provider: "google" }] })
      ).toBe(false);
    });

    it("is false when the provider list is unknown, so we fail open", () => {
      expect(isOAuthOnlySignIn({ id: "u" })).toBe(false);
    });
  });

  describe("isFreshlyMintedUser", () => {
    it("accepts a row created seconds ago", () => {
      expect(isFreshlyMintedUser(googleUser, NOW)).toBe(true);
    });

    it("rejects a row older than the window", () => {
      expect(isFreshlyMintedUser(googleUser, NOW + ORPHAN_DELETE_WINDOW_MS)).toBe(false);
    });

    it("rejects a created_at in the future (clock skew is not evidence)", () => {
      expect(isFreshlyMintedUser(googleUser, Date.parse("2026-08-10T22:59:00.000Z"))).toBe(false);
    });

    it("rejects an unparseable or missing created_at", () => {
      expect(isFreshlyMintedUser({ id: "u", created_at: "nonsense" }, NOW)).toBe(false);
      expect(isFreshlyMintedUser({ id: "u" }, NOW)).toBe(false);
    });
  });

  describe("hasNewCoworkerAccount", () => {
    it("is false for a blank address", async () => {
      const { client, calls } = stubDb({});
      expect(await hasNewCoworkerAccount("  ", client)).toBe(false);
      expect(calls).toHaveLength(0);
    });

    it("is true for the admin address, case-insensitively, without a query", async () => {
      process.env.ADMIN_EMAIL = "Boss@newcoworker.com";
      const { client, calls } = stubDb({});
      expect(await hasNewCoworkerAccount("boss@newcoworker.com", client)).toBe(true);
      expect(calls).toHaveLength(0);
    });

    it("ignores a blank ADMIN_EMAIL rather than matching a blank address", async () => {
      process.env.ADMIN_EMAIL = "   ";
      const { client } = stubDb({});
      expect(await hasNewCoworkerAccount("someone@example.com", client)).toBe(false);
    });

    it("is true when the address owns a business, escaping LIKE metacharacters", async () => {
      const { client, calls } = stubDb({ businesses: { data: [{ id: "b1" }], error: null } });
      expect(await hasNewCoworkerAccount("a_b%c@example.com", client)).toBe(true);
      expect(calls[0]).toEqual({
        table: "businesses",
        column: "owner_email",
        value: "a\\_b\\%c@example.com"
      });
    });

    it("escapes a backslash before the wildcards, not after", async () => {
      const { client, calls } = stubDb({ businesses: { data: [{ id: "b1" }], error: null } });
      await hasNewCoworkerAccount("a\\_b@example.com", client);
      expect(calls[0].value).toBe("a\\\\\\_b@example.com");
    });

    it("is true for a non-revoked membership when no business is owned", async () => {
      const { client, calls } = stubDb({
        businesses: { data: [], error: null },
        business_members: { data: [{ id: "m1" }], error: null }
      });
      expect(await hasNewCoworkerAccount("Teammate@Example.com", client)).toBe(true);
      expect(calls[1]).toEqual({
        table: "business_members",
        column: "email",
        value: "teammate@example.com",
        neq: ["status", "revoked"]
      });
    });

    it("is false when neither lookup matches, including null data", async () => {
      const { client } = stubDb({
        businesses: { data: null, error: null },
        business_members: { data: null, error: null }
      });
      expect(await hasNewCoworkerAccount("nobody@example.com", client)).toBe(false);
    });

    it("throws when the business lookup errors", async () => {
      const { client } = stubDb({ businesses: { data: null, error: { message: "boom" } } });
      await expect(hasNewCoworkerAccount("x@example.com", client)).rejects.toThrow(
        "hasNewCoworkerAccount: boom"
      );
    });

    it("throws when the membership lookup errors", async () => {
      const { client } = stubDb({
        businesses: { data: [], error: null },
        business_members: { data: null, error: { message: "members down" } }
      });
      await expect(hasNewCoworkerAccount("x@example.com", client)).rejects.toThrow(
        "hasNewCoworkerAccount: members down"
      );
    });
  });

  describe("evaluateSignIn", () => {
    it("allows a password login even with no business row yet (mid-onboarding)", async () => {
      const { client, calls } = stubDb({});
      const decision = await evaluateSignIn(
        { id: "u", email: "new@example.com", identities: [{ provider: "email" }] },
        client,
        NOW
      );
      expect(decision).toEqual({ allowed: true });
      // Never even asks: a first-party identity is proof on its own.
      expect(calls).toHaveLength(0);
    });

    it("allows a google login for an address that owns a business", async () => {
      const { client } = stubDb({ businesses: { data: [{ id: "b1" }], error: null } });
      expect(await evaluateSignIn(googleUser, client, NOW)).toEqual({ allowed: true });
    });

    it("allows a google login for an invited teammate who has never signed in", async () => {
      const { client } = stubDb({
        businesses: { data: [], error: null },
        business_members: { data: [{ id: "m1" }], error: null }
      });
      expect(await evaluateSignIn(googleUser, client, NOW)).toEqual({ allowed: true });
    });

    it("refuses and deletes the row this sign-in just minted", async () => {
      const { client } = stubDb({
        businesses: { data: [], error: null },
        business_members: { data: [], error: null }
      });
      expect(await evaluateSignIn(googleUser, client, NOW)).toEqual({
        allowed: false,
        deleteUserId: "user-1"
      });
    });

    it("refuses an older orphan but leaves the row for a human to remove", async () => {
      const { client } = stubDb({
        businesses: { data: [], error: null },
        business_members: { data: [], error: null }
      });
      expect(
        await evaluateSignIn(googleUser, client, NOW + ORPHAN_DELETE_WINDOW_MS)
      ).toEqual({ allowed: false, deleteUserId: null });
    });

    it("refuses an OAuth login carrying no email at all", async () => {
      const { client } = stubDb({});
      expect(
        await evaluateSignIn(
          { ...googleUser, email: null },
          client,
          NOW
        )
      ).toEqual({ allowed: false, deleteUserId: "user-1" });
    });

    it("defaults nowMs to the current clock", async () => {
      const { client } = stubDb({
        businesses: { data: [], error: null },
        business_members: { data: [], error: null }
      });
      const decision = await evaluateSignIn(
        { ...googleUser, created_at: new Date().toISOString() },
        client
      );
      expect(decision).toEqual({ allowed: false, deleteUserId: "user-1" });
    });
  });
});

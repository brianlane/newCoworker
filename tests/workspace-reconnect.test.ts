/**
 * Which existing row a first-party connect reconnects rather than duplicates.
 *
 * Two opposite failures, both real, which is why this logic never guesses:
 *  - MISS a reconnect and we insert a second row; flows keep pointing at the
 *    stale one and later runs die with connection_not_found (the KYP Ads
 *    Jul 22 2026 incident class).
 *  - INVENT a reconnect and we re-point an existing row id at a DIFFERENT
 *    mailbox, so flows bound to the first silently send from the second.
 *
 * Every rule below came from a Bugbot round on #1289. The module was
 * generalized from Outlook-only to a provider-key list when Google needed it;
 * the Outlook cases are unchanged, which is how that generalization was shown to
 * be behavior-preserving.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";
import {
  findDuplicateRow,
  GOOGLE_KEYS,
  OUTLOOK_KEYS,
  findReconnectTarget,
  resolveUnlabeledReconnect
} from "@/lib/workspace/reconnect";

/** A cap with room for a second mailbox, so unlabeled rows need a probe. */
const ROOMY = 3;
/** The single-seat cap, where a second mailbox is impossible. */
const ONE_SEAT = 1;

const row = (over: Partial<WorkspaceOAuthConnectionRow> = {}): WorkspaceOAuthConnectionRow => ({
  id: "row-1",
  business_id: "biz",
  provider_config_key: "outlook",
  connection_id: "nango-1",
  metadata: {},
  transport: "nango",
  is_active: true,
  created_at: "2026-07-01T00:00:00Z",
  updated_at: "2026-07-01T00:00:00Z",
  ...over
});

const labeled = (email: string, over: Partial<WorkspaceOAuthConnectionRow> = {}) =>
  row({ metadata: { provider_account_email: email }, ...over });

describe("findReconnectTarget: the row says who it is", () => {
  it("matches on the account email, case-insensitively", () => {
    const d = findReconnectTarget([labeled("Sam@Acme.com")], "sam@acme.com", ROOMY, OUTLOOK_KEYS);
    expect(d).toEqual({ kind: "reconnect", row: expect.objectContaining({ id: "row-1" }), matchedBy: "account_email" });
  });

  it("takes the OLDEST labeled match, which flows have had longest to bind to", () => {
    const rows = [
      labeled("sam@acme.com", { id: "new", created_at: "2026-08-01T00:00:00Z" }),
      labeled("sam@acme.com", { id: "old", created_at: "2026-01-01T00:00:00Z" })
    ];
    const d = findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS);
    expect(d.kind === "reconnect" && d.row.id).toBe("old");
  });

  it("breaks a created_at tie deterministically by id", () => {
    const rows = [labeled("sam@acme.com", { id: "bbb" }), labeled("sam@acme.com", { id: "aaa" })];
    const d = findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS);
    expect(d.kind === "reconnect" && d.row.id).toBe("aaa");
  });

  it("prefers an exact label over any unlabeled row", () => {
    const rows = [row({ id: "unlabeled" }), labeled("sam@acme.com", { id: "exact" })];
    const d = findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS);
    expect(d.kind === "reconnect" && d.row.id).toBe("exact");
  });

  it("ignores rows for other providers", () => {
    const rows = [
      labeled("sam@acme.com", { id: "gmail-row", provider_config_key: "gmail" }),
      labeled("sam@acme.com", { id: "cal", provider_config_key: "outlook-calendar" })
    ];
    expect(findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS).kind).toBe("new");
  });

  it.each([
    ["no rows at all", [] as WorkspaceOAuthConnectionRow[], "sam@acme.com"],
    ["an empty account email", [row()], "   "]
  ])("returns new for %s", (_label, rows, email) => {
    expect(findReconnectTarget(rows, email, ROOMY, OUTLOOK_KEYS).kind).toBe("new");
  });
});

describe("findReconnectTarget: unlabeled rows", () => {
  // These exist because /api/integrations/nango/complete only writes
  // provider_account_email when the identity probe SUCCEEDS, and older
  // Connect-UI rows were labeled with the dashboard login instead, which is why
  // debug/backfill-nango-account-identity.ts had to be written.

  it("does NOT adopt a sole unlabeled row on a multi-seat plan; it asks for a probe", () => {
    // The high-severity case Bugbot caught. On a plan with room for a second
    // mailbox, adopting would re-point an existing row at a DIFFERENT mailbox
    // when the owner is genuinely adding their second one.
    const d = findReconnectTarget([row()], "sam@acme.com", ROOMY, OUTLOOK_KEYS);
    expect(d).toEqual({ kind: "verify", row: expect.objectContaining({ id: "row-1" }) });
  });

  it("adopts without a probe when ONE seat makes a second mailbox impossible", () => {
    // Not a guess: the cap forbids a second connection, so the row can only be
    // the one being reconnected. It also has to work, or a Starter tenant whose
    // row is referenced by a flow dead-ends: they cannot add (cap) and cannot
    // remove (the delete guard).
    const d = findReconnectTarget([row()], "sam@acme.com", ONE_SEAT, OUTLOOK_KEYS);
    expect(d).toEqual({
      kind: "reconnect",
      row: expect.objectContaining({ id: "row-1" }),
      matchedBy: "cap_forces_single_mailbox"
    });
  });

  it("does not take the one-seat shortcut when another connection already exists", () => {
    // rows.length > 1 means the cap is not actually forcing anything here.
    const rows = [row(), labeled("g@acme.com", { id: "gm", provider_config_key: "gmail" })];
    expect(findReconnectTarget(rows, "sam@acme.com", ONE_SEAT, OUTLOOK_KEYS).kind).toBe("verify");
  });

  it("asks for a probe on an unlimited plan too", () => {
    expect(findReconnectTarget([row()], "sam@acme.com", null, OUTLOOK_KEYS).kind).toBe("verify");
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 42]
  ])("treats %s label as unlabeled", (_label, value) => {
    const d = findReconnectTarget(
      [row({ metadata: { provider_account_email: value } })],
      "sam@acme.com",
      ROOMY,
      OUTLOOK_KEYS
    );
    expect(d.kind).toBe("verify");
  });

  it("returns new when a second Outlook row exists, rather than picking one", () => {
    const rows = [row({ id: "unlabeled" }), labeled("other@acme.com", { id: "labeled" })];
    expect(findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS).kind).toBe("new");
  });
});

describe("resolveUnlabeledReconnect", () => {
  const candidate = row();

  it("reconnects when the probe proves it is the same account", () => {
    const d = resolveUnlabeledReconnect(candidate, "Sam@Acme.com", "sam@acme.com");
    expect(d).toEqual({ kind: "reconnect", row: candidate, matchedBy: "account_email" });
  });

  it("inserts a new row when the probe proves it is a DIFFERENT mailbox", () => {
    expect(resolveUnlabeledReconnect(candidate, "joe@acme.com", "sam@acme.com").kind).toBe("new");
  });

  it("inserts a new row when the probe failed", () => {
    // A dead grant is often exactly WHY someone is reconnecting, so this is not
    // rare. Erring toward a duplicate is recoverable; adopting on no evidence
    // could re-point a live flow at a different mailbox.
    expect(resolveUnlabeledReconnect(candidate, null, "sam@acme.com").kind).toBe("new");
  });
});

describe("findDuplicateRow", () => {
  it("returns the older row when ours lost the race", () => {
    const rows = [
      labeled("sam@acme.com", { id: "mine", created_at: "2026-08-02T00:00:00Z" }),
      labeled("sam@acme.com", { id: "theirs", created_at: "2026-08-01T00:00:00Z" })
    ];
    expect(findDuplicateRow(rows, "mine", "sam@acme.com", OUTLOOK_KEYS)?.id).toBe("theirs");
  });

  it("returns null when OURS is the oldest, so the other caller backs out instead", () => {
    // Both racers run this. Exactly one can be the oldest, so exactly one backs
    // out and the account still ends on a single row.
    const rows = [
      labeled("sam@acme.com", { id: "mine", created_at: "2026-08-01T00:00:00Z" }),
      labeled("sam@acme.com", { id: "theirs", created_at: "2026-08-02T00:00:00Z" })
    ];
    expect(findDuplicateRow(rows, "mine", "sam@acme.com", OUTLOOK_KEYS)).toBeNull();
  });

  it("returns null when ours is the only row for that account", () => {
    expect(
      findDuplicateRow([labeled("sam@acme.com", { id: "mine" })], "mine", "sam@acme.com", OUTLOOK_KEYS)
    ).toBeNull();
  });

  it("ignores a row for a DIFFERENT account", () => {
    const rows = [
      labeled("sam@acme.com", { id: "mine", created_at: "2026-08-02T00:00:00Z" }),
      labeled("other@acme.com", { id: "other", created_at: "2026-01-01T00:00:00Z" })
    ];
    expect(findDuplicateRow(rows, "mine", "sam@acme.com", OUTLOOK_KEYS)).toBeNull();
  });

  it("returns null for an empty account email", () => {
    expect(findDuplicateRow([labeled("sam@acme.com")], "row-1", "", OUTLOOK_KEYS)).toBeNull();
  });
});

/**
 * Google's key set, which is the reason this module stopped being Outlook-only.
 *
 * The Nango era accumulated four keys that all mean Google: `google` (broad
 * Gmail + Calendar), `gmail` and `google-mail` (mail only), `google-calendar`
 * (calendar only). Matching on one of them would hand a tenant on any of the
 * others a duplicate row and the connection_not_found failure this whole module
 * exists to prevent.
 */
describe("provider key sets", () => {
  const g = (key: string, email?: string) =>
    row({
      provider_config_key: key,
      ...(email ? { metadata: { provider_account_email: email } } : {})
    });

  it.each([...GOOGLE_KEYS])("reconnects a labeled %s row", (key) => {
    const d = findReconnectTarget([g(key, "sam@acme.com")], "sam@acme.com", ROOMY, GOOGLE_KEYS);
    expect(d.kind).toBe("reconnect");
  });

  it("matches across DIFFERENT Google keys for the same account", () => {
    // A tenant whose mail is on `google-mail` reconnecting through the broad
    // flow must land on the existing row, not a second one.
    const d = findReconnectTarget(
      [g("google-mail", "sam@acme.com")],
      "sam@acme.com",
      ROOMY,
      GOOGLE_KEYS
    );
    expect(d.kind).toBe("reconnect");
  });

  it("never crosses provider families", () => {
    // An Outlook row for the same person is a different mailbox entirely.
    expect(
      findReconnectTarget([g("outlook", "sam@acme.com")], "sam@acme.com", ROOMY, GOOGLE_KEYS).kind
    ).toBe("new");
    expect(
      findReconnectTarget([g("google", "sam@acme.com")], "sam@acme.com", ROOMY, OUTLOOK_KEYS).kind
    ).toBe("new");
  });

  it("counts a sole unlabeled Google row on a single seat as forced", () => {
    const d = findReconnectTarget([g("google")], "sam@acme.com", ONE_SEAT, GOOGLE_KEYS);
    expect(d).toMatchObject({ kind: "reconnect", matchedBy: "cap_forces_single_mailbox" });
  });

  it("treats two Google rows on different keys as ambiguous, not forced", () => {
    // Two rows means the sole-unlabeled shortcut must not fire, even at one seat.
    expect(
      findReconnectTarget([g("google"), g("google-calendar")], "sam@acme.com", ONE_SEAT, GOOGLE_KEYS)
        .kind
    ).toBe("new");
  });

  it("finds a duplicate across Google keys after an insert race", () => {
    const rows = [
      g("google-mail", "sam@acme.com"),
      row({
        id: "mine",
        provider_config_key: "google",
        metadata: { provider_account_email: "sam@acme.com" },
        created_at: "2026-07-02T00:00:00Z"
      })
    ];
    expect(findDuplicateRow(rows, "mine", "sam@acme.com", GOOGLE_KEYS)?.id).toBe("row-1");
  });

describe("matching on the provider account id", () => {
  const withId = (id: string, over: Record<string, unknown> = {}) =>
    row({ metadata: { provider_account_id: id, ...(over.metadata as object ?? {}) }, ...over });

  it("matches the account id even when the stored EMAIL has changed", () => {
    // The case that made this necessary: a personal Microsoft account stored as
    // its synthetic outlook_<CID>@outlook.com, then re-read as the owner's real
    // address once we started reading the id_token. Same mailbox, different
    // string. Matching on email alone would call it a new account and strand
    // every flow bound to the old row.
    const rows = [
      row({
        id: "existing",
        metadata: {
          provider_account_id: "graph-object-id-1",
          provider_account_email: "outlook_5C3966BE918A1C30@outlook.com"
        }
      })
    ];

    const d = findReconnectTarget(rows, "team@newcoworker.com", ROOMY, OUTLOOK_KEYS, "graph-object-id-1");

    expect(d).toEqual({
      kind: "reconnect",
      row: expect.objectContaining({ id: "existing" }),
      matchedBy: "account_id"
    });
  });

  it("prefers the account id over an email match on a DIFFERENT row", () => {
    const rows = [
      row({ id: "by-email", metadata: { provider_account_email: "team@newcoworker.com" } }),
      withId("graph-1", { id: "by-id" })
    ];
    const d = findReconnectTarget(rows, "team@newcoworker.com", ROOMY, OUTLOOK_KEYS, "graph-1");
    expect(d.kind === "reconnect" && d.row.id).toBe("by-id");
  });

  it("takes the oldest when several rows carry the same account id", () => {
    const rows = [
      withId("g1", { id: "newer", created_at: "2026-08-02T00:00:00Z" }),
      withId("g1", { id: "older", created_at: "2026-01-01T00:00:00Z" })
    ];
    const d = findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS, "g1");
    expect(d.kind === "reconnect" && d.row.id).toBe("older");
  });

  it("falls through to the email when no row carries that id", () => {
    const rows = [row({ metadata: { provider_account_email: "sam@acme.com" } })];
    const d = findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS, "unseen-id");
    expect(d.kind === "reconnect" && d.matchedBy).toBe("account_email");
  });

  it("behaves exactly as before when no account id is supplied", () => {
    const rows = [row({ metadata: { provider_account_email: "sam@acme.com" } })];
    const d = findReconnectTarget(rows, "sam@acme.com", ROOMY, OUTLOOK_KEYS);
    expect(d.kind === "reconnect" && d.matchedBy).toBe("account_email");
  });
});


describe("legacy rows labeled with a different representation of the account", () => {
  const SYNTHETIC = "outlook_5c3966be918a1c30@outlook.com";

  it("matches a NANGO row labeled with the synthetic UPN when we now resolve the real address", () => {
    // The migration case, and the one that made set matching necessary. A
    // Nango row carries only provider_account_email (its complete route never
    // wrote an account id), and for a personal Outlook that email is the
    // synthetic UPN. Once first-party connect started resolving the owner's
    // real address, matching on the primary alone found nothing: no id to
    // match, no email match, and the row IS labeled so the unlabeled fallback
    // does not apply. Result was a duplicate row and every flow stranded on the
    // old one.
    const rows = [
      row({ id: "legacy-nango", metadata: { provider_account_email: SYNTHETIC } })
    ];

    const d = findReconnectTarget(
      rows,
      "team@newcoworker.com",
      ROOMY,
      OUTLOOK_KEYS,
      "graph-id-1",
      [SYNTHETIC, "team@newcoworker.com"]
    );

    expect(d).toEqual({
      kind: "reconnect",
      row: expect.objectContaining({ id: "legacy-nango" }),
      matchedBy: "account_email"
    });
  });

  it("matches the other direction too, via aliases stored on the row", () => {
    // A row written by first-party connect records its whole alias set, so a
    // later connect resolving only the synthetic form still lands on it.
    const rows = [
      row({
        id: "direct-row",
        metadata: {
          provider_account_email: "team@newcoworker.com",
          provider_account_aliases: ["team@newcoworker.com", SYNTHETIC]
        }
      })
    ];

    const d = findReconnectTarget(rows, SYNTHETIC, ROOMY, OUTLOOK_KEYS, null, [SYNTHETIC]);
    expect(d.kind === "reconnect" && d.row.id).toBe("direct-row");
  });

  it("does NOT match an unrelated account that shares no alias", () => {
    const rows = [
      row({ id: "someone-else", metadata: { provider_account_email: "other@acme.com" } })
    ];
    const d = findReconnectTarget(rows, "team@newcoworker.com", ROOMY, OUTLOOK_KEYS, "id-1", [
      SYNTHETIC,
      "team@newcoworker.com"
    ]);
    expect(d.kind).toBe("new");
  });

  it("ignores a malformed provider_account_aliases rather than throwing", () => {
    const rows = [
      row({
        id: "weird",
        metadata: { provider_account_email: "team@newcoworker.com", provider_account_aliases: "nope" }
      })
    ];
    const d = findReconnectTarget(rows, "team@newcoworker.com", ROOMY, OUTLOOK_KEYS);
    expect(d.kind === "reconnect" && d.row.id).toBe("weird");
  });
});

});

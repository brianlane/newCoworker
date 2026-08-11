/**
 * Which existing row a Microsoft connect reconnects rather than duplicates.
 *
 * Two opposite failures, both real, which is why this logic never guesses:
 *  - MISS a reconnect and we insert a second row; flows keep pointing at the
 *    stale one and later runs die with connection_not_found (the KYP Ads
 *    Jul 22 2026 incident class).
 *  - INVENT a reconnect and we re-point an existing row id at a DIFFERENT
 *    mailbox, so flows bound to the first silently send from the second.
 *
 * Every rule below came from a Bugbot round on #1289.
 */
import { describe, expect, it } from "vitest";
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";
import {
  findDuplicateOutlookRow,
  findOutlookReconnectTarget,
  resolveUnlabeledReconnect
} from "@/lib/microsoft/reconnect";

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

describe("findOutlookReconnectTarget: the row says who it is", () => {
  it("matches on the account email, case-insensitively", () => {
    const d = findOutlookReconnectTarget([labeled("Sam@Acme.com")], "sam@acme.com", ROOMY);
    expect(d).toEqual({ kind: "reconnect", row: expect.objectContaining({ id: "row-1" }), matchedBy: "account_email" });
  });

  it("takes the OLDEST labeled match, which flows have had longest to bind to", () => {
    const rows = [
      labeled("sam@acme.com", { id: "new", created_at: "2026-08-01T00:00:00Z" }),
      labeled("sam@acme.com", { id: "old", created_at: "2026-01-01T00:00:00Z" })
    ];
    const d = findOutlookReconnectTarget(rows, "sam@acme.com", ROOMY);
    expect(d.kind === "reconnect" && d.row.id).toBe("old");
  });

  it("breaks a created_at tie deterministically by id", () => {
    const rows = [labeled("sam@acme.com", { id: "bbb" }), labeled("sam@acme.com", { id: "aaa" })];
    const d = findOutlookReconnectTarget(rows, "sam@acme.com", ROOMY);
    expect(d.kind === "reconnect" && d.row.id).toBe("aaa");
  });

  it("prefers an exact label over any unlabeled row", () => {
    const rows = [row({ id: "unlabeled" }), labeled("sam@acme.com", { id: "exact" })];
    const d = findOutlookReconnectTarget(rows, "sam@acme.com", ROOMY);
    expect(d.kind === "reconnect" && d.row.id).toBe("exact");
  });

  it("ignores rows for other providers", () => {
    const rows = [
      labeled("sam@acme.com", { id: "gmail-row", provider_config_key: "gmail" }),
      labeled("sam@acme.com", { id: "cal", provider_config_key: "outlook-calendar" })
    ];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com", ROOMY).kind).toBe("new");
  });

  it.each([
    ["no rows at all", [] as WorkspaceOAuthConnectionRow[], "sam@acme.com"],
    ["an empty account email", [row()], "   "]
  ])("returns new for %s", (_label, rows, email) => {
    expect(findOutlookReconnectTarget(rows, email, ROOMY).kind).toBe("new");
  });
});

describe("findOutlookReconnectTarget: unlabeled rows", () => {
  // These exist because /api/integrations/nango/complete only writes
  // provider_account_email when the identity probe SUCCEEDS, and older
  // Connect-UI rows were labeled with the dashboard login instead, which is why
  // debug/backfill-nango-account-identity.ts had to be written.

  it("does NOT adopt a sole unlabeled row on a multi-seat plan; it asks for a probe", () => {
    // The high-severity case Bugbot caught. On a plan with room for a second
    // mailbox, adopting would re-point an existing row at a DIFFERENT mailbox
    // when the owner is genuinely adding their second one.
    const d = findOutlookReconnectTarget([row()], "sam@acme.com", ROOMY);
    expect(d).toEqual({ kind: "verify", row: expect.objectContaining({ id: "row-1" }) });
  });

  it("adopts without a probe when ONE seat makes a second mailbox impossible", () => {
    // Not a guess: the cap forbids a second connection, so the row can only be
    // the one being reconnected. It also has to work, or a Starter tenant whose
    // row is referenced by a flow dead-ends: they cannot add (cap) and cannot
    // remove (the delete guard).
    const d = findOutlookReconnectTarget([row()], "sam@acme.com", ONE_SEAT);
    expect(d).toEqual({
      kind: "reconnect",
      row: expect.objectContaining({ id: "row-1" }),
      matchedBy: "cap_forces_single_mailbox"
    });
  });

  it("does not take the one-seat shortcut when another connection already exists", () => {
    // rows.length > 1 means the cap is not actually forcing anything here.
    const rows = [row(), labeled("g@acme.com", { id: "gm", provider_config_key: "gmail" })];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com", ONE_SEAT).kind).toBe("verify");
  });

  it("asks for a probe on an unlimited plan too", () => {
    expect(findOutlookReconnectTarget([row()], "sam@acme.com", null).kind).toBe("verify");
  });

  it.each([
    ["an empty string", ""],
    ["a non-string", 42]
  ])("treats %s label as unlabeled", (_label, value) => {
    const d = findOutlookReconnectTarget(
      [row({ metadata: { provider_account_email: value } })],
      "sam@acme.com",
      ROOMY
    );
    expect(d.kind).toBe("verify");
  });

  it("returns new when a second Outlook row exists, rather than picking one", () => {
    const rows = [row({ id: "unlabeled" }), labeled("other@acme.com", { id: "labeled" })];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com", ROOMY).kind).toBe("new");
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

describe("findDuplicateOutlookRow", () => {
  it("returns the older row when ours lost the race", () => {
    const rows = [
      labeled("sam@acme.com", { id: "mine", created_at: "2026-08-02T00:00:00Z" }),
      labeled("sam@acme.com", { id: "theirs", created_at: "2026-08-01T00:00:00Z" })
    ];
    expect(findDuplicateOutlookRow(rows, "mine", "sam@acme.com")?.id).toBe("theirs");
  });

  it("returns null when OURS is the oldest, so the other caller backs out instead", () => {
    // Both racers run this. Exactly one can be the oldest, so exactly one backs
    // out and the account still ends on a single row.
    const rows = [
      labeled("sam@acme.com", { id: "mine", created_at: "2026-08-01T00:00:00Z" }),
      labeled("sam@acme.com", { id: "theirs", created_at: "2026-08-02T00:00:00Z" })
    ];
    expect(findDuplicateOutlookRow(rows, "mine", "sam@acme.com")).toBeNull();
  });

  it("returns null when ours is the only row for that account", () => {
    expect(
      findDuplicateOutlookRow([labeled("sam@acme.com", { id: "mine" })], "mine", "sam@acme.com")
    ).toBeNull();
  });

  it("ignores a row for a DIFFERENT account", () => {
    const rows = [
      labeled("sam@acme.com", { id: "mine", created_at: "2026-08-02T00:00:00Z" }),
      labeled("other@acme.com", { id: "other", created_at: "2026-01-01T00:00:00Z" })
    ];
    expect(findDuplicateOutlookRow(rows, "mine", "sam@acme.com")).toBeNull();
  });

  it("returns null for an empty account email", () => {
    expect(findDuplicateOutlookRow([labeled("sam@acme.com")], "row-1", "")).toBeNull();
  });
});

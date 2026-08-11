/**
 * Which existing row a Microsoft connect reconnects rather than duplicates.
 *
 * This is the hinge of the Nango-to-first-party migration: a miss inserts a
 * second row, the flows keep pointing at the stale one, and every later run
 * dies at send time with connection_not_found (the KYP Ads Jul 22 2026
 * incident class). Both rules below came from Bugbot on #1289.
 */
import { describe, expect, it } from "vitest";
import {
  findDuplicateOutlookRow,
  findOutlookReconnectTarget
} from "@/lib/microsoft/reconnect";
import type { WorkspaceOAuthConnectionRow } from "@/lib/db/workspace-oauth-connections";

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

describe("findOutlookReconnectTarget", () => {
  it("matches on the account email, case-insensitively", () => {
    const target = findOutlookReconnectTarget([labeled("Sam@Acme.com")], "sam@acme.com");
    expect(target?.row.id).toBe("row-1");
    expect(target?.matchedBy).toBe("account_email");
  });

  it("takes the OLDEST labeled match, which flows have had longest to bind to", () => {
    const rows = [
      labeled("sam@acme.com", { id: "new", created_at: "2026-08-01T00:00:00Z" }),
      labeled("sam@acme.com", { id: "old", created_at: "2026-01-01T00:00:00Z" })
    ];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com")?.row.id).toBe("old");
  });

  it("breaks a created_at tie deterministically by id", () => {
    const rows = [
      labeled("sam@acme.com", { id: "bbb" }),
      labeled("sam@acme.com", { id: "aaa" })
    ];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com")?.row.id).toBe("aaa");
  });

  it("ADOPTS a sole unlabeled Outlook row", () => {
    // The case Bugbot caught. /api/integrations/nango/complete only writes
    // provider_account_email when the identity probe SUCCEEDS, and older
    // Connect-UI rows were labeled with the dashboard login instead, which is
    // why debug/backfill-nango-account-identity.ts exists. Skipping these rows
    // would insert a duplicate and strand the tenant's AiFlow bindings on the
    // stale Nango row: exactly the migration failure this work exists to avoid.
    const target = findOutlookReconnectTarget([row()], "sam@acme.com");
    expect(target?.row.id).toBe("row-1");
    expect(target?.matchedBy).toBe("sole_unlabeled_row");
  });

  it("treats an empty-string label as unlabeled", () => {
    const target = findOutlookReconnectTarget(
      [row({ metadata: { provider_account_email: "" } })],
      "sam@acme.com"
    );
    expect(target?.matchedBy).toBe("sole_unlabeled_row");
  });

  it("treats a non-string label as unlabeled", () => {
    const target = findOutlookReconnectTarget(
      [row({ metadata: { provider_account_email: 42 } })],
      "sam@acme.com"
    );
    expect(target?.matchedBy).toBe("sole_unlabeled_row");
  });

  it("does NOT adopt an unlabeled row when another Outlook row exists", () => {
    // Two mailboxes and one missing label makes "which did they just connect"
    // a guess, and guessing wrong re-points a live flow at a different mailbox,
    // which is worse than the duplicate it would avoid.
    const rows = [row({ id: "unlabeled" }), labeled("other@acme.com", { id: "labeled" })];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com")).toBeNull();
  });

  it("still prefers an exact label over adopting, when both are present", () => {
    const rows = [row({ id: "unlabeled" }), labeled("sam@acme.com", { id: "exact" })];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com")?.row.id).toBe("exact");
  });

  it("ignores rows for other providers", () => {
    const rows = [
      labeled("sam@acme.com", { id: "gmail-row", provider_config_key: "gmail" }),
      labeled("sam@acme.com", { id: "cal", provider_config_key: "outlook-calendar" })
    ];
    expect(findOutlookReconnectTarget(rows, "sam@acme.com")).toBeNull();
  });

  it("returns null when the business has no rows at all", () => {
    expect(findOutlookReconnectTarget([], "sam@acme.com")).toBeNull();
  });

  it("returns null for an empty account email rather than matching anything", () => {
    expect(findOutlookReconnectTarget([row()], "   ")).toBeNull();
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

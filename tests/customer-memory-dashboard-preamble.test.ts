import { describe, expect, it } from "vitest";
import {
  buildDashboardCustomerPreamble,
  DASHBOARD_PREAMBLE_MAX_CUSTOMERS,
  DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS
} from "../src/lib/customer-memory/dashboard-preamble";
import type { CustomerMemoryRow } from "../src/lib/customer-memory/types";

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: "00000000-0000-0000-0000-000000000001",
    customer_e164: "+15555550123",
    type: "customer",
    name_source: "auto",
    sms_reply_mode: "auto",
    display_name: null,
    email: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 1,
    last_interaction_at: "2026-05-06T10:00:00Z",
    last_summarized_at: null,
    last_channel: "sms",
    alias_e164s: [],
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-06T10:00:00Z",
    ...overrides
  };
}

describe("buildDashboardCustomerPreamble", () => {
  it("returns null on empty input — first-time owner sees no extra system msg", () => {
    expect(buildDashboardCustomerPreamble([])).toBeNull();
  });

  it("returns null when no row has any notable content (all summary_md/pinned_md/total_interaction_count are zero/null) — avoids 'Owner-side context:' headers with empty bodies", () => {
    expect(
      buildDashboardCustomerPreamble([
        memory({ summary_md: null, pinned_md: null, total_interaction_count: 0 })
      ])
    ).toBeNull();
  });

  it("renders one customer with name, channel, summary, and the do-not-volunteer instruction", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        display_name: "Joe",
        summary_md: "Asking about garage door springs",
        total_interaction_count: 4,
        last_channel: "voice"
      })
    ]);
    expect(out).toContain("Joe +15555550123");
    expect(out).toContain("4 prior interactions");
    expect(out).toContain("last channel: voice");
    expect(out).toContain("Asking about garage door springs");
    expect(out).toContain("Do NOT proactively volunteer customer details");
  });

  it("emits pinned notes BEFORE the summary excerpt — owner ground truth wins over LLM-generated summary", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        pinned_md: "VIP — escalate to owner",
        summary_md: "Inquired about pricing",
        total_interaction_count: 2
      })
    ]);
    expect(out).not.toBeNull();
    const pinnedIdx = out!.indexOf("VIP");
    const summaryIdx = out!.indexOf("Inquired about pricing");
    expect(pinnedIdx).toBeGreaterThan(-1);
    expect(summaryIdx).toBeGreaterThan(-1);
    expect(pinnedIdx).toBeLessThan(summaryIdx);
  });

  it("caps each customer's summary excerpt at DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS — keeps total preamble bounded across N customers", () => {
    const huge = "x".repeat(DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS + 200);
    const out = buildDashboardCustomerPreamble([
      memory({ summary_md: huge, total_interaction_count: 1 })
    ]);
    expect(out).not.toBeNull();
    // Should contain the truncation marker (ellipsis) somewhere in the
    // summary line.
    expect(out!.split("\n").some((l) => l.includes("Summary:") && l.endsWith("…"))).toBe(true);
    // The actual summary line should not contain the very last `x` of
    // the giant input.
    expect(out!).not.toContain("x".repeat(DASHBOARD_PREAMBLE_PER_CUSTOMER_CHARS + 100));
  });

  it("caps the customer list at DASHBOARD_PREAMBLE_MAX_CUSTOMERS — extra rows are dropped to keep prompt budget bounded", () => {
    const inputs = Array.from({ length: DASHBOARD_PREAMBLE_MAX_CUSTOMERS + 3 }, (_, i) =>
      memory({
        customer_e164: `+1555555${String(i).padStart(4, "0")}`,
        display_name: `Customer ${i}`,
        summary_md: `Summary ${i}`,
        total_interaction_count: 1
      })
    );
    const out = buildDashboardCustomerPreamble(inputs);
    expect(out).not.toBeNull();
    for (let i = 0; i < DASHBOARD_PREAMBLE_MAX_CUSTOMERS; i++) {
      expect(out!).toContain(`Customer ${i}`);
    }
    // The (MAX+1)th customer was dropped.
    expect(out).not.toContain(`Customer ${DASHBOARD_PREAMBLE_MAX_CUSTOMERS}`);
  });

  // ---- Branch coverage: meta tags individually droppable ----
  // These exercise the "false" arm of each `if (...)` guard inside
  // the meta-line builder so a future refactor that drops a guard
  // can't silently regress preamble formatting.

  it("omits 'last channel' when last_channel is null (e.g. memory exists from manual owner edit but no real interaction yet)", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        last_channel: null,
        last_interaction_at: "2026-05-06T10:00:00Z",
        total_interaction_count: 1,
        summary_md: "x"
      })
    ]);
    expect(out).not.toBeNull();
    expect(out!).not.toContain("last channel");
    expect(out!).toContain("last seen");
    expect(out!).toContain("1 prior interactions");
  });

  it("omits 'last seen' when last_interaction_at is null (owner-pinned-only customer with no interaction history yet)", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        last_channel: "sms",
        last_interaction_at: null,
        total_interaction_count: 1,
        summary_md: "x"
      })
    ]);
    expect(out).not.toBeNull();
    expect(out!).toContain("last channel: sms");
    expect(out!).not.toContain("last seen");
  });

  it("omits 'N prior interactions' when total_interaction_count is 0 (qualifies via pinned_md alone — owner pre-curated a customer who hasn't called yet)", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        last_channel: null,
        last_interaction_at: null,
        total_interaction_count: 0,
        pinned_md: "VIP — escalate"
      })
    ]);
    expect(out).not.toBeNull();
    expect(out!).not.toContain("prior interactions");
    expect(out!).not.toContain("last channel");
    expect(out!).not.toContain("last seen");
    // No meta means no parens after the header.
    expect(out!).toContain("- +15555550123\n");
    expect(out!).toContain("Pinned: VIP — escalate");
  });

  it("qualifies a row via summary_md alone (covers the `summary_md?.trim()` arm of the visible filter)", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        summary_md: "summary only",
        pinned_md: null,
        total_interaction_count: 0,
        last_channel: null,
        last_interaction_at: null
      })
    ]);
    expect(out).not.toBeNull();
    expect(out!).toContain("summary only");
  });

  it("renders ONLY pinned_md (no summary_md) when summary_md is null or whitespace — covers the `if (summary)` false arm on line 60", () => {
    for (const summary of [null, "", "   "]) {
      const out = buildDashboardCustomerPreamble([
        memory({
          summary_md: summary,
          pinned_md: "owner-pinned only",
          total_interaction_count: 1
        })
      ]);
      expect(out).not.toBeNull();
      expect(out!).toContain("Pinned: owner-pinned only");
      expect(out!).not.toContain("Summary:");
    }
  });

  it("omits the customer entirely when display_name is null — the header degrades to bare E.164", () => {
    const out = buildDashboardCustomerPreamble([
      memory({
        display_name: null,
        summary_md: "x",
        total_interaction_count: 1
      })
    ]);
    expect(out).not.toBeNull();
    // Just E.164 in the header (no leading name, no double space).
    expect(out!).toContain("- +15555550123 (");
  });

  it("trims display_name whitespace — `Joe   ` should not produce `Joe   +15555550123` with double spaces", () => {
    // The visible filter uses `m.display_name?.trim()` to decide
    // whether to push the name; assert the trim survived.
    const out = buildDashboardCustomerPreamble([
      memory({
        display_name: "   ",
        pinned_md: "x",
        total_interaction_count: 1
      })
    ]);
    expect(out).not.toBeNull();
    expect(out!).toContain("- +15555550123 (");
  });
});

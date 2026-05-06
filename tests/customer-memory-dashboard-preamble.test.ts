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
    display_name: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 1,
    last_interaction_at: "2026-05-06T10:00:00Z",
    last_summarized_at: null,
    last_channel: "sms",
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
});

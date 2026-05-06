import { describe, expect, it } from "vitest";
import { buildCustomerPreamble } from "../src/lib/customer-memory/preamble";
import { buildCustomerPreambleForEdge } from "../supabase/functions/_shared/customer_memory_preamble";

/**
 * Pins the Next.js preamble builder (src/lib/customer-memory/) and
 * the Deno-edge mirror (supabase/functions/_shared/) to identical
 * output. They're duplicated by necessity — see the file-header
 * comment on customer_memory_preamble.ts — but they MUST stay in
 * lockstep. A one-sided edit would mean SMS and dashboard chat see
 * different per-customer context for the same row.
 */
describe("customer memory preamble parity (Next.js ↔ edge)", () => {
  const cases = [
    {
      label: "fully populated",
      memory: {
        customer_e164: "+15555550123",
        display_name: "Joe",
        summary_md: "Repeat buyer; last close was a garage door spring.",
        pinned_md: "Always greet by Mr.",
        total_interaction_count: 7,
        last_channel: "voice" as const,
        last_interaction_at: "2026-05-06T10:00:00Z"
      }
    },
    {
      label: "summary only",
      memory: {
        customer_e164: "+15555550199",
        display_name: null,
        summary_md: "First-time caller asking about pricing.",
        pinned_md: null,
        total_interaction_count: 1,
        last_channel: "sms" as const,
        last_interaction_at: "2026-05-06T11:00:00Z"
      }
    },
    {
      label: "pinned only",
      memory: {
        customer_e164: "+15555550111",
        display_name: "Big Customer",
        summary_md: null,
        pinned_md: "VIP — escalate to owner immediately.",
        total_interaction_count: 0,
        last_channel: null,
        last_interaction_at: null
      }
    },
    {
      label: "empty (returns null)",
      memory: {
        customer_e164: "+15555550000",
        display_name: null,
        summary_md: null,
        pinned_md: null,
        total_interaction_count: 0,
        last_channel: null,
        last_interaction_at: null
      }
    }
  ];

  it.each(cases)("$label produces identical output on both sides", ({ memory }) => {
    const next = buildCustomerPreamble({ memory });
    const edge = buildCustomerPreambleForEdge(memory);
    expect(edge).toBe(next);
  });
});

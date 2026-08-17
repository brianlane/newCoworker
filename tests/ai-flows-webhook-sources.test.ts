/**
 * The flow detail page's "where does this start?" copy for webhook triggers.
 * Our own integrations reuse the webhook channel, so a flow pinned to one of
 * them must not be described as an API-key endpoint the owner has to wire up.
 */
import { describe, expect, it } from "vitest";
import {
  describeWebhookTriggerSource,
  FIRST_PARTY_WEBHOOK_SOURCES
} from "@/lib/ai-flows/webhook-sources";
import {
  INSTAGRAM_COMMENT_SOURCE,
  INSTAGRAM_SCRAPER_SOURCE,
  META_LEAD_ADS_SOURCE
} from "@/lib/ai-flows/templates";

describe("describeWebhookTriggerSource", () => {
  it("supplies BOTH a channel label and a detail for every first-party source", () => {
    for (const [source, copy] of Object.entries(FIRST_PARTY_WEBHOOK_SOURCES)) {
      expect(describeWebhookTriggerSource([{ type: "from_matches", value: source }])).toEqual(copy);
      // The label REPLACES "Webhook (Zapier, Make, or API)" on the flow page,
      // so it must never reintroduce the wording this exists to remove
      // (Bugbot 5cf287a6: the first version left that row untouched).
      expect(copy.label).not.toMatch(/zapier|make|api|webhook/i);
      expect(copy.detail.length).toBeGreaterThan(20);
    }
  });

  it("covers the sources our own webhooks actually emit", () => {
    // Pinned against the template constants rather than string literals, so
    // renaming a source breaks here instead of silently falling back to the
    // API-key copy on a live tenant's flow.
    expect(
      describeWebhookTriggerSource([{ type: "from_matches", value: INSTAGRAM_COMMENT_SOURCE }])
        ?.detail
    ).toContain("Instagram");
    expect(
      describeWebhookTriggerSource([{ type: "from_matches", value: META_LEAD_ADS_SOURCE }])?.detail
    ).toContain("Facebook Page");
  });

  it("returns null for a bridge/API flow, which keeps the endpoint copy", () => {
    // A scraped-prospect flow really IS fed by Make/Zapier posting to the
    // public endpoint, so that owner still needs the URL and the API key.
    expect(
      describeWebhookTriggerSource([{ type: "from_matches", value: INSTAGRAM_SCRAPER_SOURCE }])
    ).toBeNull();
    expect(describeWebhookTriggerSource([{ type: "from_matches", value: "my_crm" }])).toBeNull();
  });

  it("ignores conditions that cannot say where an event came from", () => {
    expect(describeWebhookTriggerSource([{ type: "body_contains", value: "instagram_comment" }])).toBeNull();
    expect(describeWebhookTriggerSource([{ type: "from_matches", value: "  " }])).toBeNull();
    expect(describeWebhookTriggerSource([{ type: "from_matches" }])).toBeNull();
    expect(describeWebhookTriggerSource([])).toBeNull();
    expect(describeWebhookTriggerSource(null)).toBeNull();
    expect(describeWebhookTriggerSource(undefined)).toBeNull();
  });

  it("takes the first first-party source when several conditions are present", () => {
    expect(
      describeWebhookTriggerSource([
        { type: "body_contains", value: "x" },
        { type: "from_matches", value: INSTAGRAM_COMMENT_SOURCE }
      ])
    ).toEqual(FIRST_PARTY_WEBHOOK_SOURCES[INSTAGRAM_COMMENT_SOURCE]);
  });
});

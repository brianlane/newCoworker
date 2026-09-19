/**
 * Starter webhook AiFlow detail gate: a saved, still-enabled webhook flow
 * must not look fully operational when the business tier refuses outside
 * lead webhooks. Internal producers that reuse the webhook channel stay
 * ungated.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  flowEnabledStatusKind,
  INTERNAL_WEBHOOK_SOURCES,
  webhookFlowBlockedOnStarter,
  webhookTriggerBlockedOnStarter
} from "@/lib/ai-flows/webhook-sources";
import { DEFAULT_BACKLOG_SOURCE } from "@/lib/ai-flows/lead-backlog";
import {
  INSTAGRAM_COMMENT_SOURCE,
  META_LEAD_ADS_SOURCE,
  PROSPECT_OUTREACH_SOURCE
} from "@/lib/ai-flows/templates";
import en from "../messages/en.json";

const GENERIC_WEBHOOK = {
  trigger: { channel: "webhook" as const, conditions: [] }
};

describe("INTERNAL_WEBHOOK_SOURCES", () => {
  it("pins the live internal source labels so a rename cannot silently start gating them", () => {
    expect(INTERNAL_WEBHOOK_SOURCES.has(PROSPECT_OUTREACH_SOURCE)).toBe(true);
    expect(INTERNAL_WEBHOOK_SOURCES.has(DEFAULT_BACKLOG_SOURCE)).toBe(true);
    expect(INTERNAL_WEBHOOK_SOURCES.has("document_renewal")).toBe(true);
    expect(INTERNAL_WEBHOOK_SOURCES.has(META_LEAD_ADS_SOURCE)).toBe(false);
  });
});

describe("webhookTriggerBlockedOnStarter", () => {
  it("never blocks when webhooks are allowed", () => {
    expect(
      webhookTriggerBlockedOnStarter({ channel: "webhook", conditions: [] }, true)
    ).toBe(false);
  });

  it("ignores non-webhook triggers", () => {
    expect(webhookTriggerBlockedOnStarter({ channel: "sms" }, false)).toBe(false);
    expect(webhookTriggerBlockedOnStarter({ channel: "email" }, false)).toBe(false);
  });

  it("blocks a generic Zapier/Make/REST webhook and first-party Meta/IG sources", () => {
    expect(webhookTriggerBlockedOnStarter({ channel: "webhook" }, false)).toBe(true);
    expect(
      webhookTriggerBlockedOnStarter(
        { channel: "webhook", conditions: [{ type: "from_matches", value: META_LEAD_ADS_SOURCE }] },
        false
      )
    ).toBe(true);
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [{ type: "from_matches", value: INSTAGRAM_COMMENT_SOURCE }]
        },
        false
      )
    ).toBe(true);
  });

  it("does not block flows pinned only to an internal producer", () => {
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [{ type: "from_matches", value: PROSPECT_OUTREACH_SOURCE }]
        },
        false
      )
    ).toBe(false);
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [{ type: "from_matches", value: "document_renewal" }]
        },
        false
      )
    ).toBe(false);
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [{ type: "from_matches", value: DEFAULT_BACKLOG_SOURCE }]
        },
        false
      )
    ).toBe(false);
  });

  it("ignores non-from_matches conditions and empty source pins", () => {
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [
            { type: "contains", value: "lead" },
            { type: "from_matches", value: "  " },
            { type: "from_matches" }
          ]
        },
        false
      )
    ).toBe(true);
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [
            { type: "contains", value: "lead" },
            { type: "from_matches", value: PROSPECT_OUTREACH_SOURCE }
          ]
        },
        false
      )
    ).toBe(false);
  });

  it("blocks when any from_matches source is still an outside webhook", () => {
    expect(
      webhookTriggerBlockedOnStarter(
        {
          channel: "webhook",
          conditions: [
            { type: "from_matches", value: PROSPECT_OUTREACH_SOURCE },
            { type: "from_matches", value: META_LEAD_ADS_SOURCE }
          ]
        },
        false
      )
    ).toBe(true);
  });
});

describe("webhookFlowBlockedOnStarter", () => {
  it("is false when webhooks are allowed, or when there is no definition", () => {
    expect(webhookFlowBlockedOnStarter(GENERIC_WEBHOOK, true)).toBe(false);
    expect(webhookFlowBlockedOnStarter(null, false)).toBe(false);
    expect(webhookFlowBlockedOnStarter(undefined, false)).toBe(false);
  });

  it("blocks a KIN-style saved webhook lead follow-up on Starter", () => {
    expect(webhookFlowBlockedOnStarter(GENERIC_WEBHOOK, false)).toBe(true);
    expect(
      webhookFlowBlockedOnStarter(
        {
          trigger: {
            channel: "webhook",
            conditions: [{ type: "from_matches", value: META_LEAD_ADS_SOURCE }]
          }
        },
        false
      )
    ).toBe(true);
  });

  it("sees a webhook extra trigger even when the primary channel is SMS", () => {
    expect(
      webhookFlowBlockedOnStarter(
        {
          trigger: { channel: "sms" },
          triggers: [{ channel: "webhook", conditions: [] }]
        },
        false
      )
    ).toBe(true);
    expect(
      webhookFlowBlockedOnStarter(
        {
          trigger: { channel: "sms" },
          triggers: [
            {
              channel: "webhook",
              conditions: [{ type: "from_matches", value: PROSPECT_OUTREACH_SOURCE }]
            }
          ]
        },
        false
      )
    ).toBe(false);
  });

  it("does not block a non-webhook flow, even on Starter", () => {
    expect(webhookFlowBlockedOnStarter({ trigger: { channel: "sms" } }, false)).toBe(false);
    expect(webhookTriggerBlockedOnStarter(undefined, false)).toBe(false);
    expect(webhookTriggerBlockedOnStarter(null, false)).toBe(false);
  });

  it("leaves a document-renewal or prospecting follow-through looking healthy", () => {
    expect(
      webhookFlowBlockedOnStarter(
        {
          trigger: {
            channel: "webhook",
            conditions: [{ type: "from_matches", value: "document_renewal" }]
          }
        },
        false
      )
    ).toBe(false);
  });
});

describe("flowEnabledStatusKind", () => {
  it("keeps OFF honest, and does not paint a gated webhook flow as ENABLED", () => {
    expect(flowEnabledStatusKind(false, true)).toBe("off");
    expect(flowEnabledStatusKind(false, false)).toBe("off");
    expect(flowEnabledStatusKind(true, false)).toBe("enabled");
    expect(flowEnabledStatusKind(true, true)).toBe("saved_no_webhooks");
  });
});

describe("flow-detail copy and wiring", () => {
  it("names the Starter gate without claiming the flow is fully operational", () => {
    const pages = en.dashboard.pages;
    expect(pages.flowStatusEnabled).toBe("ENABLED");
    expect(pages.flowStatusOff).toBe("OFF");
    expect(pages.flowStatusSavedNoWebhooks).toMatch(/not receiving webhooks/i);
    expect(pages.flowStatusSavedNoWebhooks).toMatch(/Starter/);
    expect(pages.webhookGateTitle).toMatch(/not receiving webhooks/i);
    expect(pages.webhookGateBody).toMatch(/Starter/);
    expect(pages.webhookGateBody).toMatch(/upgrade/i);
    expect(pages.webhookGateUpgrade).toMatch(/Upgrade/i);
    expect(pages.webhookGateRunsNote).toMatch(/historical|earlier|remain/i);
  });

  it("puts the gate on the flow detail page and trigger card, not only a list banner", () => {
    const root = join(__dirname, "..");
    const detail = readFileSync(join(root, "src/app/dashboard/aiflows/[flowId]/page.tsx"), "utf8");
    const view = readFileSync(join(root, "src/components/dashboard/AiFlowView.tsx"), "utf8");
    const manager = readFileSync(
      join(root, "src/components/dashboard/AiFlowsManager.tsx"),
      "utf8"
    );
    expect(detail).toContain("webhookFlowBlockedOnStarter");
    expect(detail).toContain("FlowEnabledStatusPill");
    expect(detail).toContain("StarterWebhookGateBanner");
    expect(view).toContain("webhookTriggerBlockedOnStarter");
    expect(view).toContain("StarterWebhookGateBanner");
    expect(manager).toContain("webhookFlowBlockedOnStarter");
    expect(manager).toContain("FlowEnabledStatusPill");
  });
});

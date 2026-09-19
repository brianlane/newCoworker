/**
 * Human copy for the webhook trigger's "where does this actually come from?"
 * row on the flow detail page.
 *
 * The `webhook` channel carries two very different things. Most webhook flows
 * really are fed by a bridge posting to the public endpoint with an API key
 * (Zapier, Make, the lead-backlog importer). But our OWN integrations reuse
 * the same pipeline: a Meta lead, an Instagram comment, a first Messenger or
 * WhatsApp conversation all land on our webhook handlers, which hand them to
 * `processWebhookFlowEvent` under a reserved source label.
 *
 * Describing those as "POST /api/public/v1/flow-events (API key)" is wrong in
 * the way that matters: it tells the owner their Instagram automation is fed
 * by Zapier, and sends them hunting for an API key they never need.
 *
 * Keyed on the source label a `from_matches` condition pins. Anything not
 * listed here is a genuine bridge/API flow and keeps the endpoint copy.
 */
export type WebhookSourceCopy = {
  /** Replaces the generic "Webhook (Zapier, Make, or API)" channel label. */
  label: string;
  /** The "Starts from" line: which connected account, and on what event. */
  detail: string;
};

export const FIRST_PARTY_WEBHOOK_SOURCES: Record<string, WebhookSourceCopy> = {
  facebook_lead_ads: {
    label: "New lead from your Facebook Page",
    detail: "Your connected Facebook Page, when someone submits a lead form"
  },
  instagram_comment: {
    label: "New comment on your Instagram post",
    detail: "Your connected Instagram account, when someone comments on a post"
  },
  facebook_comment: {
    label: "New comment on your Facebook post",
    detail: "Your connected Facebook Page, when someone comments on a post"
  },
  facebook_messenger: {
    label: "New Messenger conversation",
    detail: "Your connected Facebook Page, when someone starts a Messenger chat"
  },
  instagram_dm: {
    label: "New Instagram DM",
    detail: "Your connected Instagram account, when someone starts a DM"
  },
  whatsapp: {
    label: "New WhatsApp conversation",
    detail: "Your connected WhatsApp number, when someone starts a chat"
  }
};

type FromMatchesLike = { type: string; value?: string | null };

/**
 * Webhook `from_matches` labels that are platform producers, not outside
 * lead intake. The Standard webhook gate refuses EXTERNAL events only, so a
 * flow pinned solely to one of these must not look blocked on Starter.
 */
const INTERNAL_WEBHOOK_SOURCES: ReadonlySet<string> = new Set([
  "prospect_outreach",
  "document_renewal",
  "backlog_import"
]);

type WebhookTriggerLike = {
  channel?: string | null;
  conditions?: ReadonlyArray<FromMatchesLike> | null;
};

type WebhookDefinitionLike = {
  trigger?: WebhookTriggerLike | null;
  triggers?: ReadonlyArray<WebhookTriggerLike> | null;
};

function fromMatchesSources(
  conditions: ReadonlyArray<FromMatchesLike> | null | undefined
): string[] {
  const out: string[] = [];
  for (const condition of conditions ?? []) {
    if (condition.type !== "from_matches") continue;
    const value = condition.value?.trim();
    if (value) out.push(value);
  }
  return out;
}

/**
 * True when this trigger would receive outside webhook traffic that Starter
 * refuses. Internal-only pins stay false.
 */
export function webhookTriggerBlockedOnStarter(
  trigger: WebhookTriggerLike | null | undefined,
  webhooksAllowed: boolean
): boolean {
  if (webhooksAllowed) return false;
  if (!trigger || trigger.channel !== "webhook") return false;
  const sources = fromMatchesSources(trigger.conditions);
  if (sources.length > 0 && sources.every((source) => INTERNAL_WEBHOOK_SOURCES.has(source))) {
    return false;
  }
  return true;
}

/** True when any webhook trigger on the flow is blocked on Starter. */
export function webhookFlowBlockedOnStarter(
  definition: WebhookDefinitionLike | null | undefined,
  webhooksAllowed: boolean
): boolean {
  if (webhooksAllowed || !definition) return false;
  if (webhookTriggerBlockedOnStarter(definition.trigger, false)) return true;
  return (definition.triggers ?? []).some((trigger) =>
    webhookTriggerBlockedOnStarter(trigger, false)
  );
}

export type FlowEnabledStatusKind = "off" | "enabled" | "saved_no_webhooks";

/**
 * List/detail pill kind. A saved, still-enabled webhook flow on Starter is
 * not ENABLED: it will not receive outside leads.
 */
export function flowEnabledStatusKind(
  enabled: boolean,
  webhookBlockedOnStarter: boolean
): FlowEnabledStatusKind {
  if (!enabled) return "off";
  if (webhookBlockedOnStarter) return "saved_no_webhooks";
  return "enabled";
}

/** Display name for the diagnostic "Current plan" line. */
export function webhookGatePlanLabel(tier: string | null | undefined): string {
  if (tier === "standard") return "Standard";
  if (tier === "enterprise") return "Enterprise";
  return "Starter";
}

/**
 * The first-party source this webhook trigger is pinned to, or null when the
 * flow is fed by a bridge or the public API.
 *
 * Only a `from_matches` condition counts: that is the one the engine matches
 * the source label against, so it is the only condition that can tell us
 * where the event will come from.
 */
export function describeWebhookTriggerSource(
  conditions: ReadonlyArray<FromMatchesLike> | null | undefined
): WebhookSourceCopy | null {
  for (const condition of conditions ?? []) {
    if (condition.type !== "from_matches") continue;
    const value = condition.value?.trim();
    if (!value) continue;
    const described = FIRST_PARTY_WEBHOOK_SOURCES[value];
    if (described) return described;
  }
  return null;
}

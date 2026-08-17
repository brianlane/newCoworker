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
export const FIRST_PARTY_WEBHOOK_SOURCES: Record<string, string> = {
  facebook_lead_ads: "Your connected Facebook Page, when someone submits a lead form",
  instagram_comment: "Your connected Instagram account, when someone comments on a post",
  facebook_messenger: "Your connected Facebook Page, when someone starts a Messenger chat",
  instagram_dm: "Your connected Instagram account, when someone starts a DM",
  whatsapp: "Your connected WhatsApp number, when someone starts a chat"
};

type FromMatchesLike = { type: string; value?: string | null };

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
): string | null {
  for (const condition of conditions ?? []) {
    if (condition.type !== "from_matches") continue;
    const value = condition.value?.trim();
    if (!value) continue;
    const described = FIRST_PARTY_WEBHOOK_SOURCES[value];
    if (described) return described;
  }
  return null;
}

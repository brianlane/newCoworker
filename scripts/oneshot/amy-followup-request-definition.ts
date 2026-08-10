/**
 * Definition builder for Amy Laidlaw's "Follow Up Requested (Unclaimed Leads)"
 * AiFlow (Aug 2026). Kept separate from the seed script
 * (seed-amy-followup-request-aiflow.ts) for the same reason
 * clever-spoke-check-definition.ts is: the unit suite validates the EXACT
 * definition the one-shot inserts, while the seed script needs live env/DB.
 *
 * The gap this flow closes, found on 2026-08-10: a Clever seller told the AI
 * on Friday to email comparables and "talk on Monday", nobody claimed the
 * lead, and Monday arrived with nothing scheduled to honor it. The spoke
 * check's unclaimed track (patch-clever-spoke-check-unclaimed-leads.ts) is a
 * 3-day-grace safety net for leads accepted FROM NOW ON; it neither honors a
 * day-of commitment nor covers leads already sitting unclaimed.
 *
 * Entry (either path lands in the same steps):
 *   - the "Follow Up Requested" tag is added to the contact (dashboard tag
 *     edit or a flow's update_contact both fire tag_changed) ON the day the
 *     follow-up is due, or the moment the lead asks for one;
 *   - or the flow is run manually from the dashboard ("Run now" with input
 *     text; every flow supports manual runs regardless of trigger). Manual
 *     input should carry name, phone, buyer/seller, and what was requested,
 *     since a manual run has no contact-event lines to read.
 *
 * Routing, per Amy's ask: seller or both -> Dave Lane + Gabrielle Mota race
 * for it; buyer -> Dave + Gabrielle + Jason Lane. One shared deadline, first
 * "1" claims (same digits every routed lead already uses), everyone passing
 * or the deadline lapsing falls back to Amy as the business owner. Amy is
 * deliberately NOT in the broadcast lists: her roster row has
 * routing_enabled=false and she wants these handled by the team first.
 *
 * The offer SMS carries *asterisk* emphasis (requested Aug 10 2026): the
 * header, the reply digits, and "today" are starred so the ask stands out in
 * a busy thread. Route templates render with plain renderTemplate (no
 * collapseEmpty), so every templated var is extracted with a non-empty
 * fallback baked into its description.
 */
import {
  DAVE_NAME,
  FIRST_TO_CLAIM_LINE,
  GABRIELLE_NAME
} from "./amy-speed-to-lead-definition.ts";

export const JASON_NAME = "Jason Lane";

/** The tag whose addition starts the flow (case-insensitive match). */
export const FOLLOWUP_TAG = "Follow Up Requested";

export const FLOW_NAME = "Follow Up Requested (Unclaimed Leads)";

/** Seller and both-type leads race between Dave and Gabby. */
export const SELLER_BROADCAST = [DAVE_NAME, GABRIELLE_NAME];
/** Buyer leads add Jason to the race. */
export const BUYER_BROADCAST = [DAVE_NAME, GABRIELLE_NAME, JASON_NAME];

/**
 * The agent offer. Starred per Amy's ask; digits and deadline mechanics match
 * every other route_to_team offer on this account so nobody learns new rules.
 */
export const OFFER_TEMPLATE =
  "*Follow-up requested*: {{vars.lead_name}} ({{vars.lead_phone}}) is waiting on a follow-up *today*.\n" +
  "Lead type: {{vars.route_lead_type}}\n" +
  "What they asked for: {{vars.followup_note}}\n\n" +
  "This lead is unclaimed. Whoever claims it makes the follow-up personally.\n\n" +
  "Reply *1* to claim or *2* to pass by {{offer.deadline}}.\n" +
  'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out (e.g. "1, 20 min").\n' +
  'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").\n' +
  FIRST_TO_CLAIM_LINE;

export const OWNER_FALLBACK_TEMPLATE =
  "Nobody claimed the follow-up for {{vars.lead_name}} ({{vars.lead_phone}}).\n" +
  "They asked for: {{vars.followup_note}}\n" +
  "The follow-up is back with you.";

export const CLAIMED_NOTIFY_TEMPLATE =
  "{{agent.name}} claimed the follow-up for {{vars.lead_name}} ({{vars.lead_phone}}) and will reach out.";

/**
 * Claim window per offer. Short on purpose: the promise is day-of, so a miss
 * must reach Amy while "today" still means today.
 */
export const RESPONSE_MINUTES = 15;

export function buildFollowupRequestDefinition(opts: { tag?: string } = {}): unknown {
  const tag = opts.tag ?? FOLLOWUP_TAG;

  // Shared by both gated route steps; only the broadcast list differs.
  const routeBase = {
    type: "route_to_team" as const,
    offerTemplate: OFFER_TEMPLATE,
    responseMinutes: RESPONSE_MINUTES,
    // Offers still go out at night, but the claim countdown resumes at 08:30
    // with breathing room, matching the spoke check's window mechanics.
    offerWindow: {
      timezone: "America/Phoenix",
      quietStart: "21:00",
      quietEnd: "08:30",
      graceMinutes: 15
    },
    ownerFallbackTemplate: OWNER_FALLBACK_TEMPLATE,
    claimedNotifyTemplate: CLAIMED_NOTIFY_TEMPLATE
  };

  return {
    version: 1,
    trigger: { channel: "tag_changed", tag, change: "added", conditions: [] },
    steps: [
      // tag_changed events render as "key: value" lines (event/name/phone/
      // email/tags); manual runs carry whatever the owner typed. Every field
      // bakes in a non-empty fallback because the route templates below do
      // not collapse empty vars.
      {
        id: "read_request",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The lead's full name, from the name line or the text" },
          { name: "lead_phone", description: "The lead's phone number, in E.164" },
          {
            name: "route_lead_type",
            description:
              '"buyer" when the lead is buying a home, "seller" when selling, "both" when doing both. ' +
              'Use only what the text says; when it does not say, "seller"'
          },
          {
            name: "followup_note",
            description:
              "One short line: what follow-up the lead asked for and when " +
              '(e.g. "asked for comparables by email, then a call on Monday"); ' +
              '"a follow-up" when the text does not say'
          }
        ]
      },
      // Exhaustive either/or on the same var: exactly one route step fires.
      {
        id: "route_buyer",
        ...routeBase,
        agentNames: [...BUYER_BROADCAST],
        when: { var: "route_lead_type", equals: "buyer" }
      },
      {
        id: "route_seller",
        ...routeBase,
        agentNames: [...SELLER_BROADCAST],
        when: { var: "route_lead_type", notEquals: "buyer" }
      }
    ]
  };
}

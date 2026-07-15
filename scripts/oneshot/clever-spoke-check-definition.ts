/**
 * Definition builder for the "Clever - Spoke Check & Weekly Call Follow-Up"
 * AiFlow (Amy's weekly-call-until-reached routine, Jul 2026). Kept separate
 * from the seed script (seed-clever-spoke-check-aiflow.ts) so the unit suite
 * can validate the EXACT definition the one-shot inserts — the seed script
 * itself runs main() on import and needs live env/DB.
 *
 * See the seed script header for the full flow narrative.
 */
import type { FlowStep } from "../../src/lib/ai-flows/schema.ts";

export type SpokeCheckOptions = {
  /** Roster member the spoke check pins to and calls transfer to. */
  agentName: string;
  /** Live employee ref for the same member (notify + transfer target). */
  agentRef: { source: "employee"; id: string; label: string };
  /** Custom-integration label whose credentials read the Clever lead page. */
  integrationLabel: string;
  /** Spoken office name in the AI's greeting ("calling with X"). */
  officeName: string;
  /** Weekly call attempts (1..8). */
  attempts: number;
};

export function buildSpokeCheckDefinition(opts: SpokeCheckOptions): unknown {
  const leadLine =
    "Clever lead {{vars.lead_name}} ({{vars.lead_phone}})\n" +
    "Address: {{vars.lead_address}}\n" +
    "Cash offers: {{vars.cash_offers}}";

  // Amy's script, verbatim shape: greet, wait for their response, then the
  // Clever cash-offers follow-up and the good-time ask. The lead's address is
  // deliberately NOT spoken (it can be empty when the page re-read was
  // skipped); it rides in the agent-facing texts instead.
  const personaTemplate =
    `Hi, I'm calling with ${opts.officeName}. How are you today? ` +
    "We're following up to discuss the cash offers on your home through " +
    "Clever — is now a good time to talk?";

  const preSmsTemplate =
    "LIVE TRANSFER coming — pick up the phone!\n" +
    leadLine +
    "\nThey said now is a good time; connecting them to you.";

  const placeCall = (id: string): FlowStep =>
    ({
      id,
      type: "place_ai_call",
      toVar: "lead_phone",
      personaTemplate,
      notifyRef: opts.agentRef,
      transfer: { toRef: opts.agentRef, preSmsTemplate },
      captureFields: ["best time to call back", "notes"],
      saveAs: "call_outcome"
    }) as FlowStep;

  // Attempts 2..N: one top-level branch per week. The branch's own `when`
  // re-checks the spoke check (a claimed lead never gets called), and the
  // arms stop the chain once any call CONNECTED (transferred or answered) —
  // matched arms carry no steps, the else sleeps a week and calls again.
  const weeklyBranches: FlowStep[] = [];
  for (let i = 2; i <= opts.attempts; i++) {
    weeklyBranches.push({
      id: `week_${i}`,
      type: "branch",
      question: `Weekly call attempt ${i}: did an earlier call connect?`,
      when: { var: "claimed_agent", equals: "none" },
      branches: [
        {
          id: `week_${i}_transferred`,
          label: "Already live-transferred",
          condition: { var: "call_outcome", equals: "transferred" },
          steps: []
        },
        {
          id: `week_${i}_answered`,
          label: "AI already spoke with them",
          condition: { var: "call_outcome", equals: "answered" },
          steps: []
        }
      ],
      else: [
        { id: `week_${i}_sleep`, type: "sleep", minutes: 10080 },
        placeCall(`week_${i}_call`)
      ]
    } as FlowStep);
  }

  return {
    version: 1,
    trigger: {
      channel: "owner_assigned",
      // The contact-event text carries a "tags: ..." line; the accept flow
      // tags every accepted lead "Clever" (patch-clever-accept-followup).
      conditions: [{ type: "contains", value: "clever", caseInsensitive: true }]
    },
    steps: [
      // The contact-event text is "key: value" lines (name/phone/email/tags).
      {
        id: "read_contact",
        type: "extract_text",
        fields: [
          { name: "lead_name", description: "The contact's full name from the name line" },
          {
            name: "lead_phone",
            description: "The contact's phone number from the phone line, in E.164"
          }
        ]
      },
      // The Clever lead page URL the accept flow remembered for this phone.
      { id: "recall_page", type: "recall_url", keyVars: ["lead_phone"], saveAs: "lead_url" },
      // Fresh read of the lead page: current address + cash offers for the
      // spoke-check text, the call script, and the live-transfer pre-alert.
      // Skipped (vars stay empty, messages omit those lines) when no URL was
      // remembered — contains "http" is the recall-miss guard.
      {
        id: "read_page",
        type: "browse_extract",
        urlVar: "lead_url",
        auth: { integrationLabel: opts.integrationLabel },
        when: { var: "lead_url", contains: "http" },
        fields: [
          {
            name: "lead_address",
            description:
              "The property street address from the lead page — the FULL address " +
              "including street, city, state, and ZIP code"
          },
          {
            name: "cash_offers",
            description:
              'The cash offer amount(s) shown on the lead page (e.g. "$412,000" or ' +
              "\"$400,000 - $425,000\"), or 'none listed' when no cash offer is shown"
          }
        ]
      },
      // Give the agent 3 days to reach the lead before checking in.
      { id: "grace", type: "sleep", minutes: 4320 },
      // The spoke check, pinned to the agent (reply digits are the same 1/2
      // mechanic every routed lead already uses). Reply 1 (= yes, spoke) sets
      // claimed_agent; reply 2 or the 24h timeout falls back to the owner and
      // leaves claimed_agent = "none", which opens the weekly-call gate below.
      {
        id: "spoke_check",
        type: "route_to_team",
        agentName: opts.agentName,
        offerTemplate:
          "Follow-up check on your " +
          leadLine +
          "\nDid you speak with them yet? Reply 1 = YES I spoke with them, " +
          "2 = NO not yet by {{offer.deadline}}.\n" +
          "If you don't answer (or reply 2), the AI starts calling them weekly and " +
          "will live-transfer them to you when they're ready to talk.",
        responseMinutes: 1440,
        offerWindow: {
          timezone: "America/Phoenix",
          quietStart: "21:00",
          quietEnd: "08:30",
          graceMinutes: 30
        },
        ownerFallbackTemplate:
          "{{vars.lead_name}} hasn't been reached yet (no confirmation from " +
          `${opts.agentName}) — starting weekly AI follow-up calls.\n` +
          leadLine,
        claimedNotifyTemplate:
          "{{agent.name}} confirmed they spoke with the " +
          leadLine +
          "\nNo AI follow-up calls will be made."
      },
      // Attempt 1 — right after the spoke check resolves (business hours via
      // the flow time window).
      {
        ...(placeCall("week_1_call") as object),
        when: { var: "claimed_agent", equals: "none" }
      } as FlowStep,
      ...weeklyBranches,
      // The moment the lead converts by any other path — texts back, books an
      // appointment, or a teammate claims them — jump here: no more calls.
      {
        id: "converted",
        type: "goal",
        label: "Lead reached / converted",
        events: [{ kind: "replied" }, { kind: "appointment_booked" }, { kind: "claimed" }]
      },
      {
        id: "wrap_up",
        type: "notify_owner",
        message:
          "Clever follow-up finished for {{vars.lead_name}} ({{vars.lead_phone}}).\n" +
          "Last call outcome: {{vars.call_outcome}}\n" +
          "Everything that ran: {{vars.actions_taken}}"
      }
    ],
    // Calls, checks, and notifications only during Phoenix business hours
    // (Mon-Sat). Steps landing outside the window defer to the next open slot.
    timeWindow: {
      timezone: "America/Phoenix",
      start: "09:00",
      end: "18:00",
      daysOfWeek: [1, 2, 3, 4, 5, 6]
    }
  };
}

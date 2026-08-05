import { describe, expect, it } from "vitest";
import { parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import type { FlowStep } from "../../supabase/functions/_shared/ai_flows/types";
import {
  buildKypBookingConfirmationDefinition,
  buildKypPreCallReminderDefinition
} from "../../scripts/oneshot/kyp-reminder-flow-definition";
import { geminiJson } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { stepOf, walkFlow } from "./flow-walker";

/**
 * The Reem replay (KYP Ads, 2026-08-05): a lead in `Europe/London` booked a
 * strategy call for 2026-08-05T13:00:00Z, which is 2:00 PM UK. One hour
 * before, the pre-call reminder flow (`8e4e1c35`) texted her that the call
 * was "coming up today at 2:00 PM Eastern time (your local time)".
 *
 * The hour was right and the zone was invented. When she corrected it
 * ("I'm booked 2PM UK time is that right not eastern") the assistant doubled
 * down with "2:00 PM Eastern today, which is 7:00 PM UK time", and 47
 * minutes later told her there was no call starting while hers was seven
 * minutes away. She canceled.
 *
 * The trigger payload below is verbatim from the real run (`102d881a`) and
 * was never wrong: it states `invitee timezone: Europe/London` AND
 * `starts (invitee local time): ... at 2:00 PM`. The failure is entirely in
 * the extraction contract, which asks for a timezone from a five-item NORTH
 * AMERICAN list and says to return 'Eastern' when unclear. There is no
 * correct answer in that list for a London invitee, so the model takes the
 * fallback and the flow renders a confident, wrong zone.
 *
 * This is a different surface from the existing
 * `kyp-timezone-context.e2e.test.ts`, which replays the 2026-07-20 Ayanna
 * incident on the SMS CHAT-REPLY path and was fixed with
 * `SMS_TIMEZONE_LINE`. The flow-extraction path never got that lesson.
 *
 * Contract pinned here: a reminder or confirmation may state the invitee's
 * own wall-clock time, and may name their zone if it names it correctly, but
 * it must never attach a North American zone to a `Europe/London` booking.
 * Naming no zone at all is CORRECT, because `invitee_local_time` is already
 * the invitee's local time.
 */

const AI = { json: geminiJson };

function steps(def: unknown): FlowStep[] {
  return parseAiFlowDefinition(def).steps as unknown as FlowStep[];
}

/**
 * Verbatim `windowText` from run `102d881a`, the send that broke the
 * conversation. Only the Zoom link is swapped for an example host.
 */
const REEM_WINDOW_TEXT = [
  "title: KYP Ads | Free Strategy Call | Client",
  "starts: 2026-08-05T13:00:00.000000Z",
  "ends: 2026-08-05T13:30:00.000000Z",
  "location: https://zoom.example.com/j/87387327146",
  "attendee: Reem <reem@example.com>",
  "description: invitee name: Reem invitee email: reem@example.com " +
    "invitee phone: +1 913-439-9078 invitee timezone: Europe/London " +
    "starts (invitee local time): Wednesday, August 5, 2026 at 2:00 PM " +
    "reschedule link: https://calendly.example.com/reschedulings/78022060 " +
    "cancel link: https://calendly.example.com/cancellations/78022060"
].join("\n");

const REMINDER_TRIGGER = {
  channel: "calendar",
  calendar: "primary",
  event_title: "KYP Ads | Free Strategy Call | Client",
  starts_at: "2026-08-05T13:00:00.000000Z",
  ends_at: "2026-08-05T13:30:00.000000Z",
  url: "https://zoom.example.com/j/87387327146",
  windowText: REEM_WINDOW_TEXT
};

/**
 * North American zone names and abbreviations, none of which can be true of
 * a `Europe/London` booking. Word-boundary matched so "Central" inside an
 * unrelated word, or a bare "ET" inside "GET", cannot false-positive.
 */
const NORTH_AMERICAN_ZONE_RE =
  /\b(eastern|central|mountain|pacific|atlantic|E[SD]T|C[SD]T|M[SD]T|P[SD]T|ET|CT|MT|PT)\b/i;

/** Every rendered outbound body a walk produced, joined for one scan. */
function renderedText(sends: Array<{ body: string }>): string {
  return sends.map((s) => s.body).join("\n---\n");
}

async function judgeZone(message: string): Promise<JudgeVerdict> {
  return judgeReply(
    "a lead whose booking timezone is Europe/London (UK) has a call at " +
      "2:00 PM UK time, which is 9:00 AM US Eastern; the assistant sent this " +
      "message to remind or confirm with her",
    message,
    {
      states_north_american_zone:
        "Does the message tell the customer her call is in a NORTH AMERICAN " +
        "time zone (Eastern, Central, Mountain, Pacific, Atlantic, or " +
        "abbreviations like ET/EST/EDT/CT/PT)? Her booking is Europe/London, " +
        "so any such claim is false. Naming UK time, London time, GMT or BST " +
        "is correct and counts as false here. Naming no zone at all also " +
        "counts as false.",
      states_wrong_hour:
        "Does the message state a clock time for the call OTHER than 2:00 PM? " +
        "Her call is at 2:00 PM in her own local time, so '2:00 PM' is " +
        "correct and counts as false. A message stating no time counts as " +
        "false."
    }
  );
}

describe("KYP invitee timezone label: a Europe/London booking (live model)", () => {
  it(
    "the 1hr reminder never tells a London invitee her call is Eastern",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(steps(buildKypPreCallReminderDefinition()), {
        trigger: REMINDER_TRIGGER,
        ai: AI
      });

      expect(stepOf(result, "reminder_sms").status).toBe("done");
      expect(result.sends.length).toBe(1);
      const body = result.sends[0].body;

      // The half that was already right must stay right: a fix that removes
      // the wrong zone by also losing the correct hour is not a fix.
      expect(
        String(result.vars.invitee_local_time),
        `invitee_local_time = ${JSON.stringify(result.vars.invitee_local_time)}; ` +
          "the payload states 'starts (invitee local time): ... at 2:00 PM'"
      ).toMatch(/\b2:00\s*PM\b/i);

      // The defect itself. Today `invitee_tz_plain` resolves to "Eastern"
      // and this body reads "2:00 PM Eastern time (your local time)".
      const zoneHit = NORTH_AMERICAN_ZONE_RE.exec(body);
      if (zoneHit) console.error("live reminder body:", body);
      expect(
        zoneHit?.[0] ?? null,
        `the reminder attached a North American zone to a Europe/London ` +
          `booking. Rendered body: ${JSON.stringify(body)}`
      ).toBeNull();

      const verdict = await judgeZone(body);
      if (verdict.answers.states_north_american_zone || verdict.answers.states_wrong_hour) {
        console.error("live reminder body:", body);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.states_north_american_zone).toBe(false);
      expect(verdict.answers.states_wrong_hour).toBe(false);
    }
  );

  it(
    "the booking confirmation never tells a London invitee her call is Eastern",
    { retry: 1, timeout: 120_000 },
    async () => {
      const result = await walkFlow(steps(buildKypBookingConfirmationDefinition()), {
        trigger: { ...REMINDER_TRIGGER, channel: "webhook" },
        ai: AI
      });

      // walkFlow simulates send_sms only, so this is the confirmation text.
      expect(stepOf(result, "confirm_sms").status).toBe("done");
      const body = renderedText(result.sends);

      const zoneHit = NORTH_AMERICAN_ZONE_RE.exec(body);
      if (zoneHit) console.error("live confirmation body:", body);
      expect(
        zoneHit?.[0] ?? null,
        `the confirmation attached a North American zone to a Europe/London ` +
          `booking. Rendered body: ${JSON.stringify(body)}`
      ).toBeNull();

      const verdict = await judgeZone(body);
      if (verdict.answers.states_north_american_zone || verdict.answers.states_wrong_hour) {
        console.error("live confirmation body:", body);
        console.error("judge verdict:", JSON.stringify(verdict));
      }
      expect(verdict.answers.states_north_american_zone).toBe(false);
      expect(verdict.answers.states_wrong_hour).toBe(false);
    }
  );
});

import { describe, expect, it } from "vitest";
import {
  AGENT_RUN_SYSTEM_PROMPT,
  buildAgentRunPrompt,
  normalizeAgentOutput,
  resolveOutputTarget
} from "@/lib/agents/core";
import { geminiGenerateTextDetailed } from "@/lib/gemini-generate-content";
import {
  HQ_DISCOVERY_CALL_URL,
  HQ_REPLY_DRAFTER_INSTRUCTIONS,
  NO_REPLY_SENTINEL
} from "../../scripts/oneshot/hq-inbox-reply-drafter";
import { requireGeminiKey, transientBackoffMs } from "./gemini";
import { judgeReply, type JudgeVerdict } from "./judge";
import { recordGeminiUsage } from "./usage-log";

/**
 * The James/King introduction (New Coworker HQ, 2026-08-05): the email the
 * coworker could only page Brian about.
 *
 * Two texts arrived minutes apart about one Gmail thread. PR #1185 and #1191
 * fixed the ALERTS (real subject, one text per thread, a deep link). They did
 * not change what the coworker can DO, which is still nothing: the email
 * coworker replies only inside threads the assistant itself started, so a cold
 * intro to team@ can only ever be forwarded to a human.
 *
 * This suite is the target behavior, written before the feature. It drives the
 * REAL agent-run prompt builders against a live model with the REAL saved
 * instructions the seeding one-shot installs, so a drift in either the wording
 * or the model shows up here.
 *
 * Contracts:
 *   1. Two people, two sentences. James introduced; King is the prospect.
 *      Getting that backwards thanks the prospect and pitches the person who
 *      did the favor, which is the failure mode the extraction prompt already
 *      had to learn (the Clever seller-name regression).
 *   2. The booking link goes out verbatim, never a constructed variant.
 *   3. It reads as a continuation, not a first contact, and invents nothing.
 *   4. A follow-up carrying no new ask mails nobody. That is the email twin of
 *      the per-thread cooldown shipped in #1191, and it is the second of the
 *      two texts that started all of this.
 */

/** src/lib/agents/run.ts DEFAULT_AGENT_MODEL. */
const AGENT_MODEL = "gemini-3.6-flash";

/**
 * What /api/aiflows/run-agent hands executeAgentRun for a TEXT input: a
 * synthetic text/plain file named flow-input.txt. Pinned here so the prompt
 * this test builds is byte-identical to the one production builds.
 */
const FLOW_INPUT_FILENAME = "flow-input.txt";
const FLOW_INPUT_MIME = "text/plain";

/** The intro, as the flow renders it into the agent's input. */
const INTRO_EMAIL = [
  "From: james@kypads.com",
  "To: team@newcoworker.com, king@brightstepspediatrics.example.com",
  "Cc: ",
  "Subject: Introductions",
  "",
  "Brian, King - connecting you two.",
  "",
  "King is opening a children's clinic and is looking at automating their new",
  "lead flow. Brian runs New Coworker and has done a bunch of this.",
  "",
  "I'll let you two take it from here.",
  "",
  "James"
].join("\n");

/** The second text's email: a correction, carrying no new ask. */
const WRONG_PERSON_FOLLOW_UP = [
  "From: james@kypads.com",
  "Subject: Re: Introductions",
  "",
  "Sorry, replied to the wrong person on that last one. Ignore me!",
  "",
  "James"
].join("\n");

/** The recipient lines the flow now feeds in, so the drafter can check them. */
function withRecipients(from: string, to: string, cc: string, body: string): string {
  return `From: ${from}\nTo: ${to}\nCc: ${cc}\n${body}`;
}

function draftPromptFor(emailText: string): string {
  const target = resolveOutputTarget("same_as_input", FLOW_INPUT_MIME);
  return buildAgentRunPrompt({
    instructions: HQ_REPLY_DRAFTER_INSTRUCTIONS,
    formatWord: target.formatWord,
    textSections: [{ filename: FLOW_INPUT_FILENAME, text: emailText }],
    attachedFilenames: []
  });
}

/** One drafting run, with the suite's standard transient-only retry. */
async function draftReply(emailText: string): Promise<string> {
  const apiKey = requireGeminiKey();
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // The same call executeAgentRun makes, down to the sampling settings:
      // temperature 0.2, not zero, so this is a genuinely varying draw and the
      // assertions have to hold for the distribution, not one lucky sample.
      const result = await geminiGenerateTextDetailed({
        apiKey,
        model: AGENT_MODEL,
        systemInstruction: AGENT_RUN_SYSTEM_PROMPT,
        userText: draftPromptFor(emailText),
        temperature: 0.2,
        maxOutputTokens: 16_000
      });
      recordGeminiUsage(AGENT_MODEL, result.usage);
      return normalizeAgentOutput(result.text ?? "");
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!/^gemini_http_(429|5\d\d)/.test(msg) || attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, transientBackoffMs(attempt)));
    }
  }
  /* v8 ignore next -- unreachable */
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const INTRO_SCENARIO =
  "a reply from Brian, who runs New Coworker, to an email in which James " +
  "introduced Brian to a prospect named King. James did the introducing; King " +
  "is the potential customer opening a children's clinic.";

describe("HQ team inbox: the intro reply Brian would have written", () => {
  it(
    "thanks the introducer, addresses the prospect, and hands over the booking link",
    { retry: 1, timeout: 300_000 },
    async () => {
      const reply = await draftReply(INTRO_EMAIL);
      console.error("live draft:\n", reply);

      // --- lexical: exact by nature, so no judge -------------------------
      expect(reply).toContain(HQ_DISCOVERY_CALL_URL);
      // Never a constructed variant: the base page, a bare domain, a guess.
      const urls = reply.match(/https?:\/\/\S+/g) ?? [];
      expect(urls.every((u) => u.replace(/[.,)]+$/, "") === HQ_DISCOVERY_CALL_URL)).toBe(true);
      expect(reply).not.toContain("—");
      expect(reply.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(70);
      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      // Body only: no subject line, no markdown headings or bullets.
      expect(reply).not.toMatch(/^\s*(subject:|#{1,6}\s|[-*]\s)/im);

      // --- semantic: the part a string check cannot decide ---------------
      const verdict: JudgeVerdict = await judgeReply(INTRO_SCENARIO, reply, {
        thanks_the_wrong_person:
          "Does the message thank KING for the introduction, or otherwise treat King as the " +
          "person who made the introduction? James made the introduction. Thanking James is false; " +
          "thanking King, or thanking nobody by name, is true.",
        pitches_the_introducer:
          "Is the invitation to get in touch or to book a meeting directed at JAMES rather than " +
          "at King? The invitation should be aimed at King, the prospect. Aimed at King is false.",
        restarts_conversation:
          "Does the message introduce the sender as if this were first contact (a fresh " +
          '"thanks for reaching out to us" opener) rather than continuing an existing thread?',
        invents_specifics:
          "Does the message state a price, a specific date, a specific clock time, a meeting " +
          "duration, or a phone number? Naming none of those is false."
      });
      expect(verdict.answers.thanks_the_wrong_person).toBe(false);
      expect(verdict.answers.pitches_the_introducer).toBe(false);
      expect(verdict.answers.restarts_conversation).toBe(false);
      expect(verdict.answers.invents_specifics).toBe(false);
    }
  );

  it(
    "mails nobody when the follow-up carries no new ask",
    { retry: 1, timeout: 300_000 },
    async () => {
      // The second of the two texts Brian got. It is a correction, not a lead,
      // and the old flow paged him about it as though it were a sales email.
      const reply = await draftReply(WRONG_PERSON_FOLLOW_UP);
      console.error("live draft (follow-up):\n", reply);
      expect(reply.trim()).toBe(NO_REPLY_SENTINEL);
    }
  );
});

describe("HQ team inbox: it does not write to people who will never see it", () => {
  /**
   * Live, Aug 6 2026. James referred a client named Bobby and never put Bobby
   * on the email. The draft opened "Bobby, please reach out with any
   * questions" and went to James alone, so the sentence aimed at the prospect
   * reached the one person it was not for.
   *
   * Being named in the body is not the same as being a recipient, and only
   * the recipient list can tell the two apart.
   */
  const REFERRAL_BOBBY_NOT_ON_IT = [
    "Subject: Referral for Bobby",
    "",
    "Hi Brian,",
    "",
    "Hope all is well!",
    "",
    "I wanted to refer you to my client Bobby. He is in the job space and is",
    "looking for automations, more specifically for texting/ AI coworker to",
    "manage his lead flow.",
    "",
    'I told him I got a "guy" so please take care of Bobby for me!',
    "",
    "Thanks,",
    "James"
  ].join("\n");

  it(
    "asks the introducer to connect them when the prospect is not a recipient",
    { retry: 1, timeout: 300_000 },
    async () => {
      const reply = await draftReply(
        withRecipients(
          "james@kypads.com",
          "team@newcoworker.com, jobarmsteam@gmail.com",
          "",
          REFERRAL_BOBBY_NOT_ON_IT
        )
      );
      console.error("live draft (prospect absent):\n", reply);

      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      expect(reply).toContain(HQ_DISCOVERY_CALL_URL);

      const verdict: JudgeVerdict = await judgeReply(
        "a reply from Brian to James, who referred his client Bobby by email. " +
          "Bobby's address is NOT on the email: the only recipients are Brian's own " +
          "team address and another of Brian's addresses. Only James will read this.",
        reply,
        {
          addresses_the_absent_person:
            "Does the message speak TO Bobby in the second person, or greet him as if he " +
            "were reading it (for example 'Bobby, please reach out' or 'Hi Bobby')? " +
            "Merely mentioning Bobby in the third person while writing to James is false.",
          fails_to_ask_for_the_connection:
            "Does the message NEGLECT to ask James to pass this on, forward it, or share " +
            "Bobby's contact details? Asking him to connect them in any wording is false."
        }
      );
      expect(verdict.answers.addresses_the_absent_person).toBe(false);
      expect(verdict.answers.fails_to_ask_for_the_connection).toBe(false);
    }
  );

  it(
    "still speaks directly to the prospect when they ARE on the email",
    { retry: 1, timeout: 300_000 },
    async () => {
      // The guard must not overcorrect into never addressing anyone.
      const reply = await draftReply(
        withRecipients(
          "james@kypads.com",
          "team@newcoworker.com, bobby@bobbyjobs.example.com",
          "",
          REFERRAL_BOBBY_NOT_ON_IT
        )
      );
      console.error("live draft (prospect present):\n", reply);
      const verdict: JudgeVerdict = await judgeReply(
        "a reply from Brian to James, who referred his client Bobby. Bobby IS a " +
          "recipient of this email and will read it.",
        reply,
        {
          ignores_the_prospect:
            "Does the message fail to address Bobby directly, speaking only to James " +
            "about him? Addressing Bobby by name in the second person is false."
        }
      );
      expect(verdict.answers.ignores_the_prospect).toBe(false);
    }
  );
});

/**
 * The recipient guard must fail SAFE. `emailTriggerScope` omits `to`/`cc` when
 * the headers were not captured, and the flow templates them unconditionally,
 * so a capture miss renders blank lines rather than dropping them. Read blank
 * as "nobody is here" and every intro reply stops speaking to the prospect,
 * which breaks the common case to protect the rare one. Blank means unknown.
 */
describe("HQ team inbox: a blank recipient list means unknown, not absent", () => {
  it(
    "still speaks to the prospect when the headers were never captured",
    { retry: 1, timeout: 300_000 },
    async () => {
      const reply = await draftReply(
        // Exactly what the flow renders when both headers are missing.
        withRecipients("james@kypads.com", "", "", INTRO_EMAIL.split("\n").slice(3).join("\n"))
      );
      console.error("live draft (blank recipients):\n", reply);
      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      const verdict: JudgeVerdict = await judgeReply(INTRO_SCENARIO, reply, {
        pitches_the_introducer:
          "Is the invitation to get in touch or to book a meeting directed at JAMES rather " +
          "than at King? Aimed at King, the prospect, is false."
      });
      expect(verdict.answers.pitches_the_introducer).toBe(false);
    }
  );
});

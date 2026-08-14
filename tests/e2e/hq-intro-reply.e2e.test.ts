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
 * The HQ team-inbox drafter, against the LIVE model, with the REAL saved
 * instructions the seeding one-shot installs.
 *
 * It now writes TWO notes for an introduction, sent as two emails. One
 * reply-all thanking the introducer and pitching the prospect reads oddly to
 * both of them: each sees a paragraph written for the other, and on a phone
 * the recipient list is not even visible, so it looks like a direct message
 * that happens to mention a stranger (Brian, Aug 9 2026).
 *
 * Contracts, all measured against the model rather than asserted about the
 * wording of the instructions:
 *   1. The INTRODUCER note thanks the sender and stays out of the pitch when
 *      the prospect is getting their own note.
 *   2. The PROSPECT note speaks to the prospect, never thanks them for an
 *      introduction they did not make, and carries the booking link verbatim.
 *   3. When nobody but us is on the mail there IS no prospect note, and the
 *      introducer note becomes the whole reply, asking for the connection.
 *   4. A message carrying no new ask mails nobody, in either mode.
 */

/** src/lib/agents/run.ts DEFAULT_AGENT_MODEL. */
const AGENT_MODEL = "gemini-3.7-flash";

/**
 * What /api/aiflows/run-agent hands executeAgentRun for a TEXT input: a
 * synthetic text/plain file named flow-input.txt. Pinned here so the prompt
 * this test builds is byte-identical to the one production builds.
 */
const FLOW_INPUT_FILENAME = "flow-input.txt";
const FLOW_INPUT_MIME = "text/plain";

/** The referral Brian has been retesting all week, verbatim. */
const REFERRAL_BODY = [
  "Subject: Referral for Bobby",
  "",
  "Hi Brian,",
  "",
  "Hope all is well!",
  "",
  "I wanted to refer you to my client Bobby. He is in the job space and is",
  "looking for automations, more specifically for texting/ AI coworker to",
  "manage his lead flow.",
  'I told him I got a "guy" so please take care of Bobby for me!',
  "",
  "Thanks,",
  "James"
].join("\n");

/** A correction carrying no new ask. */
const WRONG_PERSON_FOLLOW_UP = [
  "Subject: Re: Introductions",
  "",
  "Sorry, replied to the wrong person on that last one. Ignore me!",
  "",
  "James"
].join("\n");

/**
 * What the flow feeds the drafter: which note to write, then the recipient
 * lines it needs in order to work out who is who.
 */
function drafterInput(opts: {
  mode: "PROSPECT" | "INTRODUCER";
  from: string;
  to: string;
  cc?: string;
  body: string;
}): string {
  return [
    `WRITE: ${opts.mode}`,
    "",
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Cc: ${opts.cc ?? ""}`,
    "",
    opts.body
  ].join("\n");
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

/** Both parties on the mail: the normal introduction. */
const BOTH_ON_IT = {
  from: "james@kypads.com",
  to: "team@newcoworker.com, bobby@bobbyjobs.example.com",
  body: REFERRAL_BODY
};

/** Only us: the introducer named the prospect but never added them. */
const ONLY_US = {
  from: "james@kypads.com",
  to: "team@newcoworker.com",
  body: REFERRAL_BODY
};

describe("HQ team inbox: the note written for the prospect", () => {
  it(
    "speaks to the prospect, gives the link, and never thanks them for the intro",
    { retry: 1, timeout: 300_000 },
    async () => {
      const reply = await draftReply(drafterInput({ mode: "PROSPECT", ...BOTH_ON_IT }));
      console.error("live draft (prospect note):\n", reply);

      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      expect(reply).toContain(HQ_DISCOVERY_CALL_URL);
      // Never a constructed variant: the base page, a bare domain, a guess.
      const urls = reply.match(/https?:\/\/\S+/g) ?? [];
      expect(urls.every((u) => u.replace(/[.,)]+$/, "") === HQ_DISCOVERY_CALL_URL)).toBe(true);
      expect(reply).not.toContain("—");
      expect(reply.split(/\s+/).filter(Boolean).length).toBeLessThanOrEqual(80);
      expect(reply).not.toMatch(/^\s*(subject:|#{1,6}\s|[-*]\s)/im);

      const verdict: JudgeVerdict = await judgeReply(
        "an email from Brian, who runs New Coworker, to Bobby. James introduced them: " +
          "James is the introducer, Bobby is the prospect. This email goes to BOBBY ONLY, " +
          "and James will not see it.",
        reply,
        {
          thanks_the_prospect_for_the_introduction:
            "Does the message thank BOBBY for making the introduction or the referral? Bobby " +
            "did not make it, James did. Thanking Bobby is true; not thanking him is false.",
          fails_to_address_the_prospect:
            "Does the message fail to speak to Bobby directly, for example by addressing James " +
            "instead? Speaking to Bobby is false.",
          invents_specifics:
            "Does the message state a price, a specific date, a specific clock time, a meeting " +
            "duration, or a phone number? Naming none of those is false."
        }
      );
      expect(verdict.answers.thanks_the_prospect_for_the_introduction).toBe(false);
      expect(verdict.answers.fails_to_address_the_prospect).toBe(false);
      expect(verdict.answers.invents_specifics).toBe(false);
    }
  );

  it(
    "declines outright when the prospect is not on the mail",
    { retry: 1, timeout: 300_000 },
    async () => {
      // Nobody to send it to. The flow skips the send on this sentinel, and
      // the send's templated recipient renders empty as a second guard.
      const reply = await draftReply(drafterInput({ mode: "PROSPECT", ...ONLY_US }));
      console.error("live draft (prospect note, nobody there):\n", reply);
      expect(reply.trim()).toBe(NO_REPLY_SENTINEL);
    }
  );
});

describe("HQ team inbox: the note written for the introducer", () => {
  it(
    "thanks the sender and leaves the pitch to the prospect's own note",
    { retry: 1, timeout: 300_000 },
    async () => {
      const reply = await draftReply(drafterInput({ mode: "INTRODUCER", ...BOTH_ON_IT }));
      console.error("live draft (introducer note):\n", reply);

      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      expect(reply).not.toContain("—");

      const verdict: JudgeVerdict = await judgeReply(
        "an email from Brian to James, who just introduced Brian to his client Bobby. " +
          "This email goes to JAMES ONLY. Bobby is receiving a separate email of his own, " +
          "with the booking link in it.",
        reply,
        {
          fails_to_thank_the_introducer:
            "Does the message NEGLECT to thank James for the introduction or referral? " +
            "Thanking him in any wording is false.",
          pitches_the_introducer:
            "Does the message pitch the product to James, explain what New Coworker does, or " +
            "invite JAMES to book a meeting? James is not the customer here. Merely saying " +
            "Brian will follow up with Bobby is false.",
          addresses_the_absent_prospect:
            "Does the message greet Bobby or speak TO him in the second person, as if he were " +
            "reading it? Referring to Bobby in the third person is false."
        }
      );
      expect(verdict.answers.fails_to_thank_the_introducer).toBe(false);
      expect(verdict.answers.pitches_the_introducer).toBe(false);
      expect(verdict.answers.addresses_the_absent_prospect).toBe(false);
    }
  );

  it(
    "becomes the whole reply, asking for the connection, when nobody else is on the mail",
    { retry: 1, timeout: 300_000 },
    async () => {
      /**
       * The Aug 6 case. With no prospect to write to, the introducer note has
       * to carry everything, including the link, so James can pass it on.
       * This is the branch the split must NOT suppress.
       */
      const reply = await draftReply(drafterInput({ mode: "INTRODUCER", ...ONLY_US }));
      console.error("live draft (introducer note, prospect absent):\n", reply);

      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      expect(reply).toContain(HQ_DISCOVERY_CALL_URL);

      const verdict: JudgeVerdict = await judgeReply(
        "an email from Brian to James, who referred his client Bobby. Bobby's address is " +
          "NOT on the email and he will never see this. Only James will read it.",
        reply,
        {
          addresses_the_absent_prospect:
            "Does the message greet Bobby or speak TO him in the second person, as if he were " +
            "reading it? Referring to him in the third person is false.",
          fails_to_ask_for_the_connection:
            "Does the message NEGLECT to ask James to pass this on, make the introduction, or " +
            "share Bobby's contact details? Asking in any wording is false."
        }
      );
      expect(verdict.answers.addresses_the_absent_prospect).toBe(false);
      expect(verdict.answers.fails_to_ask_for_the_connection).toBe(false);
    }
  );
});

describe("HQ team inbox: a message with no new ask mails nobody", () => {
  for (const mode of ["PROSPECT", "INTRODUCER"] as const) {
    it(
      `declines the ${mode.toLowerCase()} note on a thread correction`,
      { retry: 1, timeout: 300_000 },
      async () => {
        // The second of the two texts that started all of this. Neither note
        // should exist, or a correction turns into two outbound emails.
        const reply = await draftReply(
          drafterInput({
            mode,
            from: "james@kypads.com",
            to: "team@newcoworker.com, bobby@bobbyjobs.example.com",
            body: WRONG_PERSON_FOLLOW_UP
          })
        );
        console.error(`live draft (${mode}, no new ask):\n`, reply);
        expect(reply.trim()).toBe(NO_REPLY_SENTINEL);
      }
    );
  }
});

describe("HQ team inbox: a blank recipient list means unknown, not absent", () => {
  it(
    "still writes to the prospect when the headers were never captured",
    { retry: 1, timeout: 300_000 },
    async () => {
      /**
       * `emailTriggerScope` omits `to`/`cc` when the headers were not
       * captured, and the flow templates them unconditionally, so a capture
       * miss renders blank lines. Reading blank as "nobody is here" would
       * suppress the prospect note on every such message, breaking the common
       * case to protect the rare one.
       */
      const reply = await draftReply(
        drafterInput({ mode: "PROSPECT", from: "james@kypads.com", to: "", body: REFERRAL_BODY })
      );
      console.error("live draft (blank recipients):\n", reply);
      expect(reply.trim()).not.toBe(NO_REPLY_SENTINEL);
      expect(reply).toContain(HQ_DISCOVERY_CALL_URL);
    }
  );
});

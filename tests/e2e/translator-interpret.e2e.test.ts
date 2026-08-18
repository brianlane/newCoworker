import { describe, expect, it } from "vitest";
import { geminiChatReply } from "./gemini";
import { judgeReply } from "./judge";
import { translatorModeCue } from "../../vps/voice-bridge/src/system-instruction";
import { intakeSystemInstruction } from "../../vps/voice-bridge/src/intake";

/**
 * Live-model contract for the post-transfer interpreter.
 *
 * Unit tests can pin the words of the cue; only the real model can show what
 * it DOES with them. The Aug 18 defect (Amy Laidlaw, call 5634b7f0) lived
 * exactly in that gap: every cue assertion passed while the model, handed a cue
 * that named no languages, invented Spanish for two English speakers and
 * answered a teammate's "Hello" with "Hola".
 *
 * The gate (translator-gate.ts) now guarantees the cue is only ever built with
 * both languages resolved, so what needs live proof is the other half: given
 * languages that ARE named, does the model relay instead of inventing, in both
 * directions, and does it stay out of the conversation.
 *
 * Lexical facts (is this reply Spanish, is this reply English) are regex
 * assertions; only the semantic contracts (did it answer for someone, did it
 * editorialize) go to the judge, phrased so TRUE means violation.
 */

/** The persona from the incident call: Amy's outbound Clever seller script. */
const PERSONA =
  "Hi, I'm calling with Amy Laidlaw's office. How are you today? We're following up " +
  "to discuss the cash offers on your home through Clever, is now a good time to talk?";

function interpreterSession(callerLanguage: "en" | "es", colleagueLanguage: "en" | "es") {
  const system = intakeSystemInstruction(
    "Amy Laidlaw Real Estate",
    PERSONA,
    "America/Phoenix",
    ["best time to call back", "notes"],
    false,
    { agentName: "Dave Lane" },
    true,
    "Their name: Joshua Burks. Property address: 5057 N 71st Ln, Glendale, AZ.",
    { established: callerLanguage, defaultLang: colleagueLanguage }
  );
  const cue = translatorModeCue({
    callerLanguage,
    colleagueLanguage,
    humanName: "Dave Lane",
    discloseToHuman: false
  });
  return { system, cue };
}

/** Spanish output, judged lexically: accents, inverted marks, or function words. */
const SPANISH_MARKERS = /[¿¡áéíóúñ]|\b(hola|quiero|necesito|casa|puedo|gracias|usted|habla|dígame|digame|sí)\b/i;
/** English output, same idea. */
const ENGLISH_MARKERS = /\b(hello|hi|the|and|you|your|i|we|house|home|sell|offer|yes|okay)\b/i;

describe("the interpreter relays a colleague's English to a Spanish caller", () => {
  it("renders the colleague's turn in the caller's language, not an answer", async () => {
    const { system, cue } = interpreterSession("es", "en");
    const reply = await geminiChatReply(system, [
      { role: "user", text: cue },
      // The teammate picks up. This is turn 8 of the incident call, verbatim.
      { role: "user", text: "Hello. Hello." }
    ]);

    expect(reply.trim().length).toBeGreaterThan(0);
    expect(reply).toMatch(SPANISH_MARKERS);

    const verdict = await judgeReply(
      "An AI interpreter is on a bridged call between a Spanish-speaking caller " +
        "and an English-speaking teammate. The teammate just said: \"Hello. Hello.\" " +
        "The interpreter's only job is to render that greeting in Spanish for the caller.",
      reply,
      {
        answers_for_someone:
          "Answer true if the message answers the teammate or the caller on its own " +
          "behalf, or introduces itself as an assistant, instead of only relaying the " +
          "greeting. Relaying the greeting itself does NOT count.",
        adds_commentary:
          "Answer true if the message explains, narrates, or comments on what is " +
          "happening (for example 'the caller says', 'one moment', 'I am translating'), " +
          "rather than simply speaking the greeting as the person who said it."
      }
    );
    expect(verdict.answers.answers_for_someone).toBe(false);
    expect(verdict.answers.adds_commentary).toBe(false);
  });

  it("renders the caller's Spanish back into the colleague's language", async () => {
    const { system, cue } = interpreterSession("es", "en");
    const reply = await geminiChatReply(system, [
      { role: "user", text: cue },
      { role: "user", text: "Hello, this is Dave." },
      { role: "user", text: "Hola, quiero saber cuánto me ofrecen por mi casa." }
    ]);

    expect(reply).toMatch(ENGLISH_MARKERS);
    const verdict = await judgeReply(
      "An AI interpreter is relaying between a Spanish-speaking caller and an " +
        "English-speaking teammate. The caller just asked, in Spanish, how much they " +
        "are being offered for their house. The interpreter must put that question to " +
        "the teammate in English, in the first person, and nothing else.",
      reply,
      {
        answers_the_question:
          "Answer true if the message tries to ANSWER the question about the offer " +
          "(naming a price, a range, or saying nobody knows yet) instead of relaying " +
          "the question. Relaying the question does NOT count.",
        reported_speech:
          "Answer true if the message reports the speaker in the third person (for " +
          "example 'he says', 'she is asking', 'the caller wants to know') rather than " +
          "speaking in the first person as that person."
      }
    );
    expect(verdict.answers.answers_the_question).toBe(false);
    expect(verdict.answers.reported_speech).toBe(false);
  });
});

describe("the interpreter works for a Spanish-speaking business too", () => {
  it("does not assume the colleague speaks English", async () => {
    // The mirror image the old cue could not express: it hardcoded English as
    // the colleague's language, so a Spanish tenant with an English caller
    // would have been told to translate English into English.
    const { system, cue } = interpreterSession("en", "es");
    const reply = await geminiChatReply(system, [
      { role: "user", text: cue },
      { role: "user", text: "Hi, I'm calling about selling my house." }
    ]);
    expect(reply).toMatch(SPANISH_MARKERS);
  });
});

import { describe, expect, it } from "vitest";
import { createCallerSpeechLog } from "../vps/voice-bridge/src/caller-speech";

/**
 * A synchronous, DB-free record of what the CALLER has said so far, kept so the
 * translator gate can judge the language at the moment of a transfer.
 *
 * The transcript recorder (voice-transcript.ts) already buffers the same
 * frames, but it is fire-and-forget async and only exists when a transcript
 * adapter is wired. A live routing decision cannot wait on a DB write or
 * silently lose its evidence when transcripts are off, so this keeps its own
 * copy in memory. Both read the SAME frame parser so they can never disagree
 * about what the caller said.
 */
describe("createCallerSpeechLog", () => {
  const callerFrame = (text: string, turnComplete = false) => ({
    serverContent: { inputTranscription: { text }, turnComplete }
  });

  it("joins the fragments of one turn into a single utterance", () => {
    const log = createCallerSpeechLog();
    log.ingest(callerFrame("No hablo "));
    log.ingest(callerFrame("inglés"));
    log.ingest(callerFrame("", true));
    expect(log.turns()).toEqual(["No hablo inglés"]);
  });

  it("keeps turns separate and in order", () => {
    const log = createCallerSpeechLog();
    log.ingest(callerFrame("first", true));
    log.ingest(callerFrame("second", true));
    expect(log.turns()).toEqual(["first", "second"]);
  });

  it("ignores what the assistant said", () => {
    // The gate must judge the CALLER's language. Scoring our own speech would
    // make an AI that greeted in Spanish look like a Spanish-speaking caller.
    const log = createCallerSpeechLog();
    log.ingest({
      serverContent: { outputTranscription: { text: "Hola, soy el asistente" }, turnComplete: true }
    });
    expect(log.turns()).toEqual([]);
  });

  it("exposes the in-progress turn too, since a transfer can land mid-turn", () => {
    // The model often calls transfer_to_owner in the same turn the caller
    // finished speaking, before turnComplete has flushed.
    const log = createCallerSpeechLog();
    log.ingest(callerFrame("quiero vender mi casa"));
    expect(log.turns()).toEqual(["quiero vender mi casa"]);
  });

  it("survives null, undefined, and junk frames", () => {
    const log = createCallerSpeechLog();
    log.ingest(null);
    log.ingest(undefined);
    log.ingest({} as never);
    log.ingest({ serverContent: null });
    expect(log.turns()).toEqual([]);
  });

  it("drops empty turns rather than recording silence", () => {
    const log = createCallerSpeechLog();
    log.ingest(callerFrame("   ", true));
    expect(log.turns()).toEqual([]);
  });

  it("bounds what it keeps, so a long call cannot grow without limit", () => {
    // A 30 minute interpreted call would otherwise accumulate every turn for a
    // decision that only ever reads the recent past.
    const log = createCallerSpeechLog({ maxTurns: 3 });
    for (const word of ["one", "two", "three", "four", "five"]) {
      log.ingest(callerFrame(word, true));
    }
    expect(log.turns()).toEqual(["three", "four", "five"]);
  });
});

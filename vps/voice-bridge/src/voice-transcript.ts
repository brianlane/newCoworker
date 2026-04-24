/**
 * Per-call transcript accumulator. Fed by Gemini Live `serverContent` frames,
 * flushes one caller row + one assistant row per completed turn, and
 * finalizes the parent transcript row at call teardown.
 *
 * Pure closure: the DB is abstracted behind `TranscriptAdapter` so this can
 * be unit-tested without a live Supabase instance. See `createSupabaseTranscriptAdapter`
 * in `./index.ts` for the production wiring.
 *
 * Resilience: every adapter call is wrapped so a DB failure can never crash
 * the media pipe. Transcripts are best-effort — losing a call's transcript is
 * preferable to hanging up the caller.
 */

import type { LiveServerMessage } from "@google/genai";

export type TranscriptRole = "caller" | "assistant";

export type TranscriptAdapter = {
  createTranscript: (input: {
    businessId: string;
    callControlId: string;
    callerE164: string;
    model: string;
  }) => Promise<string | null>;
  insertTurn: (input: {
    transcriptId: string;
    role: TranscriptRole;
    content: string;
    turnIndex: number;
  }) => Promise<void>;
  finalizeTranscript: (input: {
    transcriptId: string;
    status: "completed" | "errored";
  }) => Promise<void>;
};

export type TranscriptRecorder = {
  ingest: (message: LiveServerMessage | null | undefined) => Promise<void>;
  finalize: (opts?: { errored?: boolean }) => Promise<void>;
};

export type TranscriptRecorderInit = {
  businessId: string;
  callControlId: string;
  callerE164: string;
  model: string;
};

/**
 * Narrow the Live-API server content frame to the transcription fields we
 * care about. The `@google/genai` types don't yet declare
 * `inputTranscription` / `outputTranscription`, so we access them through an
 * `unknown` cast with runtime shape checks.
 */
function extractTranscriptionFrame(message: LiveServerMessage): {
  callerText: string;
  assistantText: string;
  turnComplete: boolean;
} {
  const sc = (message as unknown as {
    serverContent?: {
      inputTranscription?: { text?: unknown };
      outputTranscription?: { text?: unknown };
      turnComplete?: unknown;
    };
  }).serverContent;
  if (!sc || typeof sc !== "object") {
    return { callerText: "", assistantText: "", turnComplete: false };
  }
  const callerText =
    typeof sc.inputTranscription?.text === "string" ? sc.inputTranscription.text : "";
  const assistantText =
    typeof sc.outputTranscription?.text === "string" ? sc.outputTranscription.text : "";
  return { callerText, assistantText, turnComplete: sc.turnComplete === true };
}

export function createTranscriptRecorder(
  adapter: TranscriptAdapter,
  init: TranscriptRecorderInit
): TranscriptRecorder {
  let transcriptId: string | null = null;
  let createInFlight: Promise<string | null> | null = null;
  let callerBuf = "";
  let assistantBuf = "";
  let turnIndex = 0;
  let finalized = false;

  async function ensureTranscript(): Promise<string | null> {
    if (transcriptId) return transcriptId;
    if (!createInFlight) {
      createInFlight = (async () => {
        try {
          const id = await adapter.createTranscript(init);
          transcriptId = id;
          return id;
        } catch (err) {
          console.error("voice-transcript: createTranscript", err);
          return null;
        }
      })();
    }
    return createInFlight;
  }

  async function flushTurn(): Promise<void> {
    const caller = callerBuf.trim();
    const assistant = assistantBuf.trim();
    callerBuf = "";
    assistantBuf = "";
    if (!caller && !assistant) return;
    const id = await ensureTranscript();
    if (!id) return;
    if (caller) {
      try {
        await adapter.insertTurn({
          transcriptId: id,
          role: "caller",
          content: caller,
          turnIndex: turnIndex++
        });
      } catch (err) {
        console.error("voice-transcript: insertTurn(caller)", err);
      }
    }
    if (assistant) {
      try {
        await adapter.insertTurn({
          transcriptId: id,
          role: "assistant",
          content: assistant,
          turnIndex: turnIndex++
        });
      } catch (err) {
        console.error("voice-transcript: insertTurn(assistant)", err);
      }
    }
  }

  async function ingest(message: LiveServerMessage | null | undefined): Promise<void> {
    if (finalized || !message) return;
    const { callerText, assistantText, turnComplete } = extractTranscriptionFrame(message);
    if (callerText) callerBuf += callerText;
    if (assistantText) assistantBuf += assistantText;
    if (turnComplete) {
      await flushTurn();
    }
  }

  async function finalize(opts: { errored?: boolean } = {}): Promise<void> {
    if (finalized) return;
    finalized = true;
    await flushTurn();
    if (!transcriptId) return;
    try {
      await adapter.finalizeTranscript({
        transcriptId,
        status: opts.errored ? "errored" : "completed"
      });
    } catch (err) {
      console.error("voice-transcript: finalizeTranscript", err);
    }
  }

  return { ingest, finalize };
}

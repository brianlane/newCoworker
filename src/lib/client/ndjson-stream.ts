/**
 * Tiny NDJSON line splitter shared by streaming dashboard surfaces
 * (currently /api/dashboard/chat). Pure helper — accepts a chunk of
 * decoded text and a buffer-state object, returns parsed JSON values
 * for any complete lines.
 *
 * Why extracted: the client component (`DashboardChat.tsx`) used to
 * inline this logic, which made it both untestable in our `node`
 * vitest environment AND tempting to subtly diverge from the server's
 * NDJSON contract on a quick edit. Pulling the parser out here gives
 * us:
 *
 *   1. Direct unit tests in `tests/client-ndjson-stream.test.ts`
 *      against the same line-buffer semantics the component uses.
 *   2. A stable contract surface — any future change to NDJSON
 *      framing (e.g. adding a length-prefix) lands in exactly one
 *      place.
 *
 * Framing rules (mirrors server-side `route.ts`):
 *   - Each event is a JSON object terminated by `\n`.
 *   - The final partial line (no trailing newline) stays buffered.
 *   - Blank lines are ignored (some intermediaries emit keep-alive
 *     newlines).
 *   - Malformed JSON lines are reported via `onParseError` so the
 *     caller decides whether to drop or surface them; we never throw
 *     because losing a single garbled event shouldn't kill the
 *     stream.
 */

export type NdjsonBuffer = { buffer: string };

export type NdjsonChunkResult<T> = {
  /** Parsed events from any complete lines in this chunk. */
  events: T[];
  /** Number of lines that failed JSON.parse — caller-visible diagnostic. */
  parseErrorCount: number;
};

export function consumeNdjsonChunk<T>(
  state: NdjsonBuffer,
  chunkText: string
): NdjsonChunkResult<T> {
  state.buffer += chunkText;
  const events: T[] = [];
  let parseErrorCount = 0;
  let nlIdx: number;
  while ((nlIdx = state.buffer.indexOf("\n")) !== -1) {
    const rawLine = state.buffer.slice(0, nlIdx).trim();
    state.buffer = state.buffer.slice(nlIdx + 1);
    if (!rawLine) continue;
    try {
      events.push(JSON.parse(rawLine) as T);
    } catch {
      parseErrorCount += 1;
    }
  }
  return { events, parseErrorCount };
}

/**
 * Drain any trailing partial line as a final attempt — used when the
 * upstream stream closes. A well-formed server always ends events with
 * `\n` (so this is a no-op), but tolerating clipped final newlines
 * means an intermediary stripping the trailing byte doesn't drop our
 * `done` event.
 */
export function flushNdjsonBuffer<T>(state: NdjsonBuffer): NdjsonChunkResult<T> {
  const trailing = state.buffer.trim();
  state.buffer = "";
  if (!trailing) return { events: [], parseErrorCount: 0 };
  try {
    return { events: [JSON.parse(trailing) as T], parseErrorCount: 0 };
  } catch {
    return { events: [], parseErrorCount: 1 };
  }
}

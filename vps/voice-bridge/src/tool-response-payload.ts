/**
 * The exact object a tool handler's result becomes on the Gemini Live wire.
 *
 * Extracted from `sendToolResponse` (gemini-telnyx-bridge.ts) because the
 * enumeration of forwarded fields IS the bug surface: the wire payload used
 * to be built inline from `ok`/`detail`/`message`/`data` only, while the
 * `voicemail_reached` handler passed its `script` through an object spread
 * (`...(script ? { script } : {})`). A spread bypasses TypeScript's
 * excess-property check, so the extra field compiled, and `sendToolResponse`
 * silently dropped it.
 *
 * The consequence ran for twelve days (PR #1428, 2026-08-17, through
 * 2026-08-29) before call 5e325829 exposed it: the model was told "read this
 * message aloud word for word, then end the call" WITH NO MESSAGE ATTACHED.
 * Its own tool declaration promises "It returns `script` when there is a
 * message to leave", so the model, holding an instruction to read a script it
 * was never given, reconstructed one from its call briefing, and the briefing
 * never contains a callback number, so it fabricated 480-400-0588. The
 * telemetry row for that call shows the empty payload plainly:
 * `data_type: "none", data_keys: null`.
 *
 * This module exists so a test (tests/voice-bridge-tool-response-payload.test.ts)
 * can pin every ToolResult field to the wire, and a field added to ToolResult
 * without a matching line here fails review as a one-line diff instead of a
 * twelve-day silent drop.
 */

export type ToolResult = {
  ok: boolean;
  detail?: string;
  data?: unknown;
  /** Model-facing guidance the app routes attach on notable outcomes. */
  message?: string;
  /**
   * The voicemail message the model must read aloud word for word
   * (`voicemail_reached` only). The tool declaration promises this field by
   * name, so it must reach the wire under this exact key.
   */
  script?: string;
  /**
   * `voicemail_reached` only: the OTHER path (the edge's deterministic drop)
   * holds the speak claim and is playing the message right now, so the model
   * must stay silent and must NOT end the call.
   */
  alreadyBeingLeft?: boolean;
};

/** Build the `functionResponses[].response` object for one tool result. */
export function toolResponsePayload(response: ToolResult): Record<string, unknown> {
  return {
    ok: response.ok,
    detail: response.detail ?? (response.ok ? "ok" : "error"),
    ...(typeof response.message === "string" ? { message: response.message } : {}),
    ...(response.data !== undefined ? { data: response.data } : {}),
    ...(typeof response.script === "string" && response.script
      ? { script: response.script }
      : {}),
    ...(response.alreadyBeingLeft === true ? { alreadyBeingLeft: true } : {})
  };
}

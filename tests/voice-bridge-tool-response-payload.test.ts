import { describe, expect, it } from "vitest";
import {
  toolResponsePayload,
  type ToolResult
} from "../vps/voice-bridge/src/tool-response-payload";

/**
 * The wire payload a Gemini Live tool result becomes. This enumeration IS the
 * bug surface: `sendToolResponse` used to build the payload inline from
 * ok/detail/message/data only, while the `voicemail_reached` handler passed
 * `script` through an object spread (which TypeScript's excess-property check
 * ignores). The field was silently dropped for twelve days, so the model was
 * told "read this message aloud word for word" WITH NO MESSAGE, and it
 * reconstructed one from its briefing, fabricating the callback number the
 * briefing lacks (call 5e325829, 2026-08-29, spoke 480-400-0588 instead of
 * the script's 602-695-1142).
 */
describe("toolResponsePayload", () => {
  it("forwards the voicemail script under the exact key the tool declaration promises", () => {
    const payload = toolResponsePayload({
      ok: true,
      script: "Hi, this is the office. Call us back at 602-695-1142.",
      detail: "read this message aloud word for word, then end the call"
    });
    expect(payload.script).toBe("Hi, this is the office. Call us back at 602-695-1142.");
    expect(payload.ok).toBe(true);
    expect(payload.detail).toBe("read this message aloud word for word, then end the call");
  });

  it("survives the exact shape that hid the bug: script arriving via an object spread", () => {
    const script = "Call us back at 602-695-1142.";
    const spread: ToolResult = { ok: true, ...(script ? { script } : {}), detail: "read it" };
    expect(toolResponsePayload(spread).script).toBe(script);
  });

  it("forwards alreadyBeingLeft only when literally true", () => {
    expect(toolResponsePayload({ ok: true, alreadyBeingLeft: true }).alreadyBeingLeft).toBe(true);
    expect(toolResponsePayload({ ok: true })).not.toHaveProperty("alreadyBeingLeft");
    expect(
      toolResponsePayload({ ok: true, alreadyBeingLeft: false })
    ).not.toHaveProperty("alreadyBeingLeft");
  });

  it("omits an absent or empty script rather than sending an empty field", () => {
    expect(toolResponsePayload({ ok: true })).not.toHaveProperty("script");
    expect(toolResponsePayload({ ok: true, script: "" })).not.toHaveProperty("script");
  });

  it("defaults detail from ok, and forwards message and data when present", () => {
    expect(toolResponsePayload({ ok: true }).detail).toBe("ok");
    expect(toolResponsePayload({ ok: false }).detail).toBe("error");
    const payload = toolResponsePayload({
      ok: true,
      message: "try again with the same arguments",
      data: { slots: ["9am"] }
    });
    expect(payload.message).toBe("try again with the same arguments");
    expect(payload.data).toEqual({ slots: ["9am"] });
    expect(toolResponsePayload({ ok: true })).not.toHaveProperty("message");
    expect(toolResponsePayload({ ok: true })).not.toHaveProperty("data");
  });

  it("forwards EVERY ToolResult field: a key added to the type must reach the wire", () => {
    // A field on ToolResult with no wire mapping is exactly the dropped-script
    // bug waiting to recur. `ok` and `detail` always render; the optional
    // fields must each appear when set.
    const full: Required<ToolResult> = {
      ok: true,
      detail: "d",
      data: 1,
      message: "m",
      script: "s",
      alreadyBeingLeft: true
    };
    const payload = toolResponsePayload(full);
    for (const key of Object.keys(full) as Array<keyof ToolResult>) {
      expect(payload).toHaveProperty(key);
    }
  });
});

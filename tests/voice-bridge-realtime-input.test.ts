import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

/**
 * Regression guard for the Gemini Live realtime-input payload shape used by
 * the voice bridge.
 *
 * Background: in May 2026 the deployed bridge silently failed every call
 * with "ring then silence". The Telnyx WS opened, ~10 inbound L16 frames
 * reached Gemini, then the Live API closed the WS with code 1007:
 *   "realtime_input.media_chunks is deprecated.
 *    Use audio, video, or text instead."
 *
 * Root cause: `session.sendRealtimeInput({ media: { ... } })` — the SDK's
 * `liveSendRealtimeInputParametersToMldev` converter routes `media` straight
 * to the deprecated server field `media_chunks`. The fix is to use the
 * `audio:` field, which routes to the modern `audio` server field via
 * `tAudioBlob`. See vps/voice-bridge/src/gemini-telnyx-bridge.ts for the
 * inline rationale at the call site.
 *
 * This test is intentionally a static source check rather than a runtime
 * one because the bridge file is monolithic and we don't want to refactor
 * solely to make the call site mockable. The static check is precise: it
 * asserts no `media:` form is reintroduced and the `audio:` form is the
 * only one in use.
 */
describe("voice-bridge realtime input field", () => {
  const bridgePath = resolve(
    fileURLToPath(new URL("..", import.meta.url)),
    "vps/voice-bridge/src/gemini-telnyx-bridge.ts"
  );

  it("uses sendRealtimeInput({ audio: ... }) for inbound caller audio", async () => {
    const src = await readFile(bridgePath, "utf8");
    expect(
      /session\.sendRealtimeInput\(\{\s*audio:\s*\{/.test(src),
      "expected the bridge to forward caller audio with the modern `audio:` field"
    ).toBe(true);
  });

  it("never forwards caller audio with the deprecated `media:` field", async () => {
    const src = await readFile(bridgePath, "utf8");
    // The deprecated form is `sendRealtimeInput({ media: { ... } })`. We
    // strip line/block comments first so the in-source rationale (which
    // intentionally quotes the deprecated wording) doesn't false-fire this
    // guard.
    const stripped = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|\s)\/\/[^\n]*/g, "$1");
    const hasDeprecated =
      /session\.sendRealtimeInput\(\{\s*media:\s*\{/.test(stripped);
    expect(
      hasDeprecated,
      "Gemini Live closes the WS with code 1007 when `media:` is used; switch to `audio:`"
    ).toBe(false);
  });
});

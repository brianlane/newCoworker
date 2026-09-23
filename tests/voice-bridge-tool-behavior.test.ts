import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildVoiceToolDeclarations,
  LIVE_FUNCTION_BEHAVIOR,
  withBlockingToolBehavior
} from "../vps/voice-bridge/src/tool-declarations";

const ROOT = join(__dirname, "..");

describe("withBlockingToolBehavior", () => {
  it("stamps BLOCKING without mutating the text-stand-in declarations", () => {
    const decls = buildVoiceToolDeclarations();
    const stamped = withBlockingToolBehavior(decls);
    expect(stamped).toHaveLength(decls.length);
    expect(stamped.every((d) => d.behavior === LIVE_FUNCTION_BEHAVIOR)).toBe(true);
    expect(decls.every((d) => !("behavior" in d))).toBe(true);
    expect(stamped.map((d) => d.name)).toEqual(decls.map((d) => d.name));
  });

  it("stamps inline bridge tools on the way out to Gemini Live", () => {
    const bridge = readFileSync(
      join(ROOT, "vps/voice-bridge/src/gemini-telnyx-bridge.ts"),
      "utf8"
    );
    expect(bridge).toContain("withBlockingToolBehavior(declarations)");
  });
});

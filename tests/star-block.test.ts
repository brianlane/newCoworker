import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hasStarRow,
  STAR_ROW,
  starBlock
} from "../supabase/functions/_shared/star_block";
import { STAR_ROW as ONESHOT_STAR_ROW } from "../scripts/oneshot/realtor-retrigger-guard";
import { STAR_ROW as BRIDGE_STAR_ROW } from "../vps/voice-bridge/src/intake";
import {
  buildOwnerMessage,
  buildRecipientMessage
} from "../supabase/functions/_shared/warm_transfer_notify";

const ROOT = join(__dirname, "..");

describe("starBlock", () => {
  it("frames a body in a row of asterisks above and below", () => {
    expect(starBlock("Dave missed a warm transfer.")).toBe(
      `${STAR_ROW}\nDave missed a warm transfer.\n${STAR_ROW}`
    );
  });

  it("keeps a multi-line body intact between the rows", () => {
    const framed = starBlock("Line one\nLine two");
    expect(framed.split("\n")).toEqual([STAR_ROW, "Line one", "Line two", STAR_ROW]);
  });

  it("trims surrounding whitespace so the rows sit flush against the body", () => {
    expect(starBlock("  padded  \n")).toBe(`${STAR_ROW}\npadded\n${STAR_ROW}`);
  });

  it("is idempotent: an already-framed body never stacks a second row", () => {
    const once = starBlock("Live transfer incoming.");
    expect(starBlock(once)).toBe(once);
    expect(starBlock(starBlock(once))).toBe(once);
  });

  it("leaves a body that opens with its own star row alone", () => {
    // The $1M+ owner-direct templates are stored pre-wrapped by
    // realtor-retrigger-guard; re-framing one must not double it.
    const preWrapped = `${STAR_ROW}\nHIGH-VALUE lead kept for you.\n${STAR_ROW}`;
    expect(starBlock(preWrapped)).toBe(preWrapped);
  });

  it("returns an empty/whitespace body unchanged (never sends bare asterisks)", () => {
    expect(starBlock("")).toBe("");
    expect(starBlock("   ")).toBe("   ");
  });
});

describe("hasStarRow", () => {
  it("recognizes a leading row of 4 or more asterisks", () => {
    expect(hasStarRow("****\nbody")).toBe(true);
    expect(hasStarRow(`${STAR_ROW}\nbody`)).toBe(true);
    expect(hasStarRow("  \n")).toBe(false);
  });

  it("recognizes a star row that is the whole message", () => {
    expect(hasStarRow(STAR_ROW)).toBe(true);
  });

  it("rejects short runs and stars that are not on their own first line", () => {
    expect(hasStarRow("***\nbody")).toBe(false);
    expect(hasStarRow("**** body")).toBe(false);
    expect(hasStarRow("body\n****")).toBe(false);
  });
});

describe("star row lockstep copies", () => {
  // Three separate builds (Deno edge, Node one-shots, the voice-bridge
  // package) cannot import one module, so the constant is duplicated. If one
  // drifts, Amy's alerts arrive with mismatched frames.
  it("the edge, one-shot, and voice-bridge constants are identical", () => {
    expect(ONESHOT_STAR_ROW).toBe(STAR_ROW);
    expect(BRIDGE_STAR_ROW).toBe(STAR_ROW);
  });

  it("no copy has been widened or narrowed", () => {
    expect(STAR_ROW).toMatch(/^\*{4,}$/);
    for (const rel of [
      "supabase/functions/_shared/star_block.ts",
      "scripts/oneshot/realtor-retrigger-guard.ts",
      "vps/voice-bridge/src/intake.ts"
    ]) {
      const src = readFileSync(join(ROOT, rel), "utf8");
      expect(src, `${rel} must declare the shared row`).toContain(
        `STAR_ROW = "${STAR_ROW}"`
      );
    }
  });
});

describe("framed warm-transfer notices (what Amy actually receives)", () => {
  const caller = "Homelight Live Transfer +14159851909";
  const recipient = "Dave Lane +16025245719";

  it("frames the owner copy that lands as her own phone starts ringing", () => {
    expect(starBlock(buildOwnerMessage("failed", recipient, caller))).toBe(
      `${STAR_ROW}\n` +
        "Dave Lane +16025245719 missed a warm transfer for Homelight Live Transfer +14159851909.\n" +
        STAR_ROW
    );
  });

  it("frames the recipient copy without touching its wording", () => {
    const plain = buildRecipientMessage("failed", caller);
    const framed = starBlock(plain);
    expect(framed).toContain(plain);
    expect(framed.startsWith(`${STAR_ROW}\n`)).toBe(true);
    expect(framed.endsWith(`\n${STAR_ROW}`)).toBe(true);
  });

  it("frames the answered notices too", () => {
    for (const text of [
      buildRecipientMessage("success", caller),
      buildOwnerMessage("success", recipient, caller)
    ]) {
      expect(starBlock(text)).toBe(`${STAR_ROW}\n${text}\n${STAR_ROW}`);
    }
  });
});

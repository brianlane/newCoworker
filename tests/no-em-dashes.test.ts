import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NO_EM_DASH_PROMPT_LINE } from "../supabase/functions/_shared/sms_prompt_lines";

/**
 * The repo-wide writing rule (README "Writing rule: NO EM DASHES, ever"):
 * user-facing runtime strings never contain an em dash, and every AI
 * worker/model prompt instructs the model to never emit one.
 *
 * Part 1 scans the guarded surfaces whole-file (these files are copy-first,
 * so their comments are held to the rule too). Widen the set as more areas
 * are cleaned; never shrink it. Deliberately NOT guarded:
 *   - src/lib/blog/copy.ts: the stripEmDashes MATCHER must contain the
 *     character it strips;
 *   - the input-parsing regexes in _shared/ai_flows/engine.ts, which match
 *     em dashes CUSTOMERS type (recognizing one is not writing one).
 *
 * Part 2 pins the prompt wiring: the shared NO_EM_DASH_PROMPT_LINE (or its
 * voice-bridge lockstep copy) rides every AI surface's system prompt.
 */

const EM_DASH = "\u2014";
const ROOT = join(__dirname, "..");

/**
 * Stored-data identifiers that must keep their historical spelling: the
 * needs-human toggle looks existing flows up BY NAME, and live tenants
 * already have rows named exactly this (src/lib/ai-flows/needs-human-flow.ts).
 * Renaming it would orphan those flows, so the literal is exempt wherever
 * the copy quotes the real name.
 */
const ALLOWED_LITERALS = [`Human handoff ${EM_DASH} offer to team first`];

function guardedFiles(): string[] {
  const emailTemplatesDir = join(ROOT, "src/lib/email/templates");
  return [
    "messages/en.json",
    "messages/es.json",
    "messages/edge-en.json",
    "messages/edge-es.json",
    "supabase/functions/_shared/sms_prompt_lines.ts",
    "scripts/oneshot/seed-amy-new-lead-intake.ts",
    ...readdirSync(emailTemplatesDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/lib/email/templates/${f}`)
  ];
}

describe("no em dashes (README writing rule)", () => {
  it("guarded user-facing surfaces contain no em dash", () => {
    const offenders: string[] = [];
    for (const rel of guardedFiles()) {
      let text = readFileSync(join(ROOT, rel), "utf8");
      for (const allowed of ALLOWED_LITERALS) {
        text = text.split(allowed).join("");
      }
      if (!text.includes(EM_DASH)) continue;
      text.split("\n").forEach((line, i) => {
        if (line.includes(EM_DASH)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `Em dash found in guarded user-facing files (use a comma, period, or colon):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the shared prompt line practices what it preaches", () => {
    expect(NO_EM_DASH_PROMPT_LINE).toContain("never use an em dash");
    expect(NO_EM_DASH_PROMPT_LINE.includes(EM_DASH)).toBe(false);
  });

  it("every AI surface's prompt assembly carries the no-em-dash instruction", () => {
    // Import-based surfaces reference the shared constant by name.
    const importWired = [
      // Texting coworker (customer AND staff/owner preambles).
      "supabase/functions/sms-inbound-worker/index.ts",
      // Dashboard chat + owner-SMS operator (OWNER_PREAMBLE embeds the line).
      "src/app/api/dashboard/chat/route.ts",
      // Messenger / Instagram DM / WhatsApp conversations.
      "src/lib/messenger/engine.ts",
      // Website webchat.
      "src/lib/webchat/gemini-engine.ts"
    ];
    for (const rel of importWired) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text, `${rel} must inject NO_EM_DASH_PROMPT_LINE`).toContain(
        "NO_EM_DASH_PROMPT_LINE"
      );
    }
    // The voice bridge is a separate package (no cross-import): lockstep copy.
    const bridge = readFileSync(
      join(ROOT, "vps/voice-bridge/src/system-instruction.ts"),
      "utf8"
    );
    expect(bridge).toContain("never use an em dash in anything you write");
    // Agents (document runs) carry the instruction inline in their prompt.
    const agents = readFileSync(join(ROOT, "src/lib/agents/core.ts"), "utf8");
    expect(agents).toContain("Never use an em dash in anything you write");
  });
});

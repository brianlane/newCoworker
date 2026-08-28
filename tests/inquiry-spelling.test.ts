import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { US_SPELLING_PROMPT_LINE } from "../supabase/functions/_shared/sms_prompt_lines";

/**
 * "inquiry", never "enquiry" (Amy Laidlaw, 2026-08-28).
 *
 * Amy's follow-up cadence was opening calls with "We're following up on your
 * enquiry through Clever": the British spelling, read aloud to Arizona
 * homeowners. It came from two independent places, so this guard has two
 * parts, one for each.
 *
 * Part 1 scans the copy-first surfaces whole-file (comments included, same
 * discipline as tests/no-em-dashes.test.ts) so no seeded flow definition,
 * email template, or message catalog can put the spelling back into a
 * tenant's mouth. Widen the set as more areas are cleaned; never shrink it.
 * Deliberately NOT guarded:
 *   - scripts/oneshot/amy-heal-parked-cadence-lead-site.ts, whose
 *     OLD_SITE_FALLBACK is the MATCHER for the value live rows were written
 *     with before this change (recognizing the old spelling is not writing
 *     it), covered instead by its own test's refIsStaleSpelling cases;
 *   - tests/e2e/owner-ask-needs-flow-change.e2e.test.ts, which replays a real
 *     captured production transcript verbatim.
 *
 * Part 2 pins the prompt wiring: models drift into British spelling on turns
 * no template scripts, so US_SPELLING_PROMPT_LINE (or a lockstep copy) rides
 * every AI surface's system prompt, exactly like NO_EM_DASH_PROMPT_LINE.
 */

const BANNED = /enquir/i;
const ROOT = join(__dirname, "..");

/**
 * The one place the banned spelling has to appear: the clause that teaches
 * the model not to use it. Stripped before scanning so the prompt-line
 * modules can be guarded whole-file like everything else. Shared verbatim by
 * sms_prompt_lines.ts, the voice bridge's lockstep copy, and the document
 * agents' inline copy, so one literal covers all three.
 */
const ALLOWED_LITERALS = [
  // The prompt-line modules and their two lockstep copies.
  "enquiry, enquiries, or enquire",
  // The blog/social composers, whose prompts are terse marketing briefs and
  // carry the short form of the same instruction.
  "inquiry, never enquiry"
];

function guardedFiles(): string[] {
  const emailTemplatesDir = join(ROOT, "src/lib/email/templates");
  const oneshotDir = join(ROOT, "scripts/oneshot");
  return [
    // The shared prompt lines, and the two lockstep copies of the spelling
    // instruction. These files state the rule, so they have to keep it.
    "supabase/functions/_shared/sms_prompt_lines.ts",
    "vps/voice-bridge/src/system-instruction.ts",
    "src/lib/agents/core.ts",
    // Model-facing preambles: dashboard/owner chat, owner SMS, Slack.
    "src/lib/owner-surfaces/preambles.ts",
    "src/lib/slack/chat.ts",
    // Every new tenant's voice/SMS flow copy is seeded from here.
    "src/lib/ai-flows/templates.ts",
    // Composes the owner-facing intake alert from the flow's own briefing.
    "vps/voice-bridge/src/intake.ts",
    // Owner-facing findings text from the website/Google outreach probe.
    "src/lib/outreach/probe.ts",
    // The llms.txt brief an AI assistant quotes back to a buyer.
    "src/lib/marketing/llms-content.ts",
    // Blog posts, weekly topic posts, and the weekly digest: AI-composed
    // PUBLIC marketing copy, so the house spelling applies the same as it
    // does to a tenant's SMS.
    "src/lib/blog/ai.ts",
    "src/lib/blog/weekly-topics.ts",
    "src/lib/blog/weekly-digest.ts",
    "messages/en.json",
    "messages/es.json",
    "messages/edge-en.json",
    "messages/edge-es.json",
    // The tenant AiFlow definition modules: the spoken personas, voicemail
    // scripts, SMS bodies, email bodies, and extraction-field instructions
    // that get seeded into live flows. This is where the Amy wording lived,
    // and a re-seed from an unguarded module would put it straight back.
    ...readdirSync(oneshotDir)
      .filter((f) => f.endsWith("-definition.ts"))
      .map((f) => `scripts/oneshot/${f}`),
    "scripts/oneshot/_amy-email-followup-block.ts",
    ...readdirSync(emailTemplatesDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/lib/email/templates/${f}`)
  ];
}

describe('"inquiry", never "enquiry"', () => {
  it("guarded copy-first surfaces never spell it the British way", () => {
    const offenders: string[] = [];
    for (const rel of guardedFiles()) {
      let text = readFileSync(join(ROOT, rel), "utf8");
      for (const allowed of ALLOWED_LITERALS) {
        text = text.split(allowed).join("");
      }
      if (!BANNED.test(text)) continue;
      text.split("\n").forEach((line, i) => {
        if (BANNED.test(line)) offenders.push(`${rel}:${i + 1}`);
      });
    }
    expect(
      offenders,
      `British "enquiry" found in guarded copy (write inquiry / inquiries / inquire):\n${offenders.join("\n")}`
    ).toEqual([]);
  });

  it("the shared prompt line names the banned spelling and the replacement", () => {
    expect(US_SPELLING_PROMPT_LINE).toContain("Never write enquiry, enquiries, or enquire");
    expect(US_SPELLING_PROMPT_LINE).toContain("inquiry, inquiries, and inquire");
    // Stripping the one sanctioned clause must leave the line clean, which is
    // what lets Part 1 guard the module that defines it.
    let stripped = US_SPELLING_PROMPT_LINE;
    for (const allowed of ALLOWED_LITERALS) stripped = stripped.split(allowed).join("");
    expect(BANNED.test(stripped)).toBe(false);
  });

  it("every AI surface's prompt assembly carries the spelling instruction", () => {
    // Import-based surfaces reference the shared constant by name.
    const importWired = [
      // Texting coworker (customer AND staff/owner preambles).
      "supabase/functions/sms-inbound-worker/index.ts",
      // Dashboard chat, owner SMS operator, and the Slack owner branch all
      // compose OWNER_PREAMBLE, which embeds the line.
      "src/lib/owner-surfaces/preambles.ts",
      // Slack team branch (team members are not owners, separate preamble).
      "src/lib/slack/chat.ts",
      // Messenger / Instagram DM / WhatsApp conversations.
      "src/lib/messenger/engine.ts",
      // Website webchat.
      "src/lib/webchat/gemini-engine.ts"
    ];
    // AiFlow field extraction is wired to the SHORT constant, deliberately.
    // Its output is pasted verbatim into owner SMS and send_email bodies, so
    // it needs the guard, but the full line's trailing list of other British
    // spellings measurably breaks the person-role disambiguation instruction
    // that sits above it in the same prompt: 5/24 correct against 8/8 without
    // it, answering with our own agent's name (the Pamela replay, nightly
    // 2026-08-28). Asserting the EXACT constant matters here: a bare
    // "US_SPELLING_PROMPT_LINE" substring check passes on the extraction
    // constant by accident, which would let a future edit swap either one for
    // the other unnoticed.
    const extractionSurface = readFileSync(
      join(ROOT, "supabase/functions/_shared/ai_flows/engine.ts"),
      "utf8"
    );
    expect(
      extractionSurface,
      "AiFlow extraction must inject US_SPELLING_PROMPT_LINE_EXTRACTION"
    ).toContain("US_SPELLING_PROMPT_LINE_EXTRACTION");
    expect(
      /US_SPELLING_PROMPT_LINE(?!_EXTRACTION)/.test(extractionSurface),
      "AiFlow extraction must NOT take the full line: its word list breaks person-role disambiguation"
    ).toBe(false);

    for (const rel of importWired) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text, `${rel} must inject US_SPELLING_PROMPT_LINE`).toContain(
        "US_SPELLING_PROMPT_LINE"
      );
    }
    // The voice bridge is a separate package (no cross-import): lockstep copy.
    // This is the surface the wrong spelling was actually HEARD on.
    const bridge = readFileSync(
      join(ROOT, "vps/voice-bridge/src/system-instruction.ts"),
      "utf8"
    );
    expect(bridge).toContain("Spelling: write in American English");
    expect(bridge).toContain("usSpellingLine");
    // Agents (document runs) carry the instruction inline in their prompt.
    const agents = readFileSync(join(ROOT, "src/lib/agents/core.ts"), "utf8");
    expect(agents).toContain("Write in American English");
    // The blog and social composers carry the short inline form.
    for (const rel of [
      "src/lib/blog/ai.ts",
      "src/lib/blog/weekly-topics.ts",
      "src/lib/blog/weekly-digest.ts"
    ]) {
      const text = readFileSync(join(ROOT, rel), "utf8");
      expect(text, `${rel} must instruct American spelling`).toContain(
        "Write in American English"
      );
    }
  });
});

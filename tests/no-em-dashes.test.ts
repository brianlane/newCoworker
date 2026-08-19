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
  const workflowsDir = join(ROOT, ".github/workflows");
  return [
    // The file that states the rule has to keep it. Guarded since Aug 2026
    // because `next dev` used to append a managed block containing an em dash
    // (see `agentRules: false` in next.config.ts); this is the backstop for
    // that and for any other tool that decides to write here.
    "CLAUDE.md",
    "messages/en.json",
    "messages/es.json",
    "messages/edge-en.json",
    "messages/edge-es.json",
    "supabase/functions/_shared/sms_prompt_lines.ts",
    // The llms.txt brief is copy an AI assistant quotes back to a buyer.
    "src/lib/marketing/llms-content.ts",
    // The AiFlow compiler prompt: model-facing text is held to the rule the
    // same as customer copy (rule 4 covers AI prompts), and its validation
    // messages surface verbatim in the flow editor.
    "src/lib/ai-flows/compile.ts",
    // Dashboard panels whose inline JSX and setError strings are owner-facing.
    "src/components/dashboard/CampaignsManager.tsx",
    "src/components/dashboard/SocialPostsManager.tsx",
    // Builds an SMS body (seen live in an unassigned-booking alert text).
    "src/lib/calendar-tools/unassigned-booking-alert.ts",
    "scripts/oneshot/seed-amy-new-lead-intake.ts",
    // VFM second-brand rollout on KYP: lead-flow SMS/email copy and the
    // vault sections the coworker serves verbatim.
    "scripts/oneshot/vfm-lead-flow-definition.ts",
    "scripts/oneshot/vfm-brand-content.ts",
    // Seeds the HQ demo-line / webchat follow-up SMS bodies. The live flows
    // read clean only because patch-hq-booking-offer.ts swept them after the
    // fact; an unguarded re-run would put the em dashes straight back.
    "scripts/oneshot/setup-hq-dogfood-flows.ts",
    // The HQ team-inbox alerts. Its em dash shipped as a bare "-" in a live
    // text (gsmSafeSmsText rewrites the character on the way out), which is
    // how the rule got broken in production copy without anyone noticing.
    // The definition module holds the SMS bodies and the model prompts; the
    // applier beside it is guarded too so its prose cannot drift back.
    "scripts/oneshot/hq-inbox-reply-drafter.ts",
    "scripts/oneshot/hq-inbox-triage-definition.ts",
    "scripts/oneshot/setup-hq-inbox-triage-flow.ts",
    ...readdirSync(emailTemplatesDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => `src/lib/email/templates/${f}`),
    // Workflows compose text that leaves the repo: main-failure-watch.yml
    // builds the deploy-failure EMAIL body and subject, and ci.yml posts a
    // preview-URL comment on the PR. Rule 4 already covered those surfaces,
    // but nothing enforced it here, so the alert email shipped four em
    // dashes (subject included) until the 2026-08-06 deploy investigation
    // read one in an inbox. The whole directory is guarded, not just the
    // emailing file, so the next workflow that sends mail is covered the
    // day it lands rather than the day someone notices.
    ...readdirSync(workflowsDir)
      .filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
      .map((f) => `.github/workflows/${f}`)
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
      "src/lib/webchat/gemini-engine.ts",
      // Slack team chat (the team preamble; the owner branch reuses
      // OWNER_PREAMBLE, which embeds the line already).
      "src/lib/slack/chat.ts",
      // AiFlow field extraction. Its output is pasted verbatim into owner SMS
      // and send_email bodies; only the SMS path is GSM-normalized, so email
      // shipped whatever the model wrote. (buildClassifyPrompt in the same
      // file needs no line: it can only return one of the flow author's fixed
      // category values, never prose.)
      "supabase/functions/_shared/ai_flows/engine.ts"
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

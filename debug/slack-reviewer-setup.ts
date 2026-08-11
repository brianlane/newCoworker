/**
 * Provision the Slack Marketplace reviewer test account (idempotent).
 * Mirrors debug/google-reviewer-setup.ts: a Supabase auth user (email
 * confirmed, password rotated + printed on every apply) plus a "Slack Review
 * Sandbox (internal)" business owned by that email, so the reviewer's login
 * lands on a real dashboard with the Integrations page and the Slack connect
 * flow.
 *
 * Beyond the shared shape, this one also seeds the demo automation the
 * reviewer test plan (/integrations/slack/review-test-plan) walks through: a
 * manual-trigger flow (notify_owner -> approval_gate -> notify_owner) started
 * from the dashboard's "Run now" button. The first alert exercises the Slack
 * alert card, the gate posts the Approve / Skip / Cancel card, and the final
 * step proves the Slack decision drove the run. The definition is validated
 * with the real schema + semantics walker before writing, so a builder drift
 * breaks this script loudly instead of seeding an invalid flow.
 *
 * NOT created here (the reviewer does it, that is the review): connecting
 * their own test workspace from Dashboard -> Integrations -> Slack and
 * picking the alert channel.
 *
 * Owner mapping note for the submission Q&A: owner-only Slack actions unlock
 * for the Slack user whose VERIFIED EMAIL equals businesses.owner_email
 * (slack.reviewer@newcoworker.com). If the reviewer cannot put that email on
 * a member of their test workspace, re-point owner_email at their member's
 * email:
 *   tsx debug/slack-reviewer-setup.ts --apply --owner-email reviewer@example.com
 * The login email/password stay unchanged. Because dashboard access also
 * binds through owner_email, the override upserts an ACTIVE manager
 * business_members row for the login, so Integrations and Run now keep
 * working while the Slack owner match points at the reviewer's member.
 *
 * Usage:
 *   tsx debug/slack-reviewer-setup.ts          # dry-run
 *   tsx debug/slack-reviewer-setup.ts --apply
 *   tsx debug/slack-reviewer-setup.ts --apply --owner-email <email>
 */
import { randomBytes } from "node:crypto";
import { loadEnv } from "./_shared.ts";
import {
  aiFlowDefinitionSchema,
  validateDefinitionSemantics
} from "../src/lib/ai-flows/schema.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const ownerFlagIdx = process.argv.indexOf("--owner-email");
const OWNER_EMAIL_OVERRIDE = ownerFlagIdx >= 0 ? process.argv[ownerFlagIdx + 1] : undefined;
if (ownerFlagIdx >= 0 && !OWNER_EMAIL_OVERRIDE?.includes("@")) {
  throw new Error("--owner-email needs an email address argument");
}

const REVIEWER_EMAIL = "slack.reviewer@newcoworker.com";
const BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000004";
const BUSINESS_NAME = "Slack Review Sandbox (internal)";
// Fixed id so reruns update the same row instead of stacking duplicates.
const DEMO_FLOW_ID = "e2b7a1c4-0004-4000-8000-000000000001";
const DEMO_FLOW_NAME = "Slack review demo: approval in Slack";

// The three-step demo the test plan narrates. Gate guards the step after it:
// approve runs it, skip jumps it, cancel stops the run; every outcome is
// visible on the card the app rewrites in Slack.
const DEMO_DEFINITION = {
  version: 1,
  trigger: { channel: "manual" },
  steps: [
    {
      id: "s_alert",
      type: "notify_owner",
      message:
        "Demo automation started. This is New Coworker's alert card in your chosen Slack channel. The run now parks at an approval step; decide it from the card that follows."
    },
    {
      id: "s_gate",
      type: "approval_gate",
      prompt:
        "The demo automation is parked at its approval step. Approve to run the final step, skip to jump past it, or cancel to stop the run."
    },
    {
      id: "s_done",
      type: "notify_owner",
      message:
        "Demo complete: the final step ran because you approved from Slack. Decisions on the card drive the automation itself."
    }
  ]
} as const;

const { createClient } = await import("@supabase/supabase-js");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

// Validate the seed before touching anything, apply or not: parse enforces the
// step shapes, the semantics walk enforces cross-step rules (gate targets etc).
const parsed = aiFlowDefinitionSchema.parse(DEMO_DEFINITION);
const problems = validateDefinitionSemantics(parsed);
if (problems.length > 0) {
  throw new Error(`demo flow definition invalid: ${problems.join("; ")}`);
}

console.log("[setup] plan:", {
  email: REVIEWER_EMAIL,
  ownerEmail: OWNER_EMAIL_OVERRIDE ?? REVIEWER_EMAIL,
  businessId: BUSINESS_ID,
  name: BUSINESS_NAME,
  demoFlow: DEMO_FLOW_NAME
});

if (!APPLY) {
  console.log("[setup] demo flow definition valid. Dry run complete. Re-run with --apply to create.");
  process.exit(0);
}

// 1. Auth user (password rotated on every apply so a rerun always yields
//    known-good credentials). Minted at runtime, never hardcoded or stored
//    in the repo; it is pasted into the Marketplace submission notes only.
const minted = ["Sr", randomBytes(12).toString("base64url")].join("-");
{
  let existing: { id: string } | undefined;
  for (let page = 1; ; page++) {
    const { data: list, error: listErr } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (listErr) throw new Error(`list users: ${listErr.message}`);
    existing = list.users.find(
      (u) => (u.email ?? "").toLowerCase() === REVIEWER_EMAIL.toLowerCase()
    );
    if (existing || list.users.length < 1000) break;
  }
  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, { password: minted });
    if (error) throw new Error(`update user: ${error.message}`);
    console.log("[setup] auth user exists, password rotated");
  } else {
    const { error } = await db.auth.admin.createUser({
      email: REVIEWER_EMAIL,
      password: minted,
      email_confirm: true
    });
    if (error) throw new Error(`create user: ${error.message}`);
    console.log("[setup] auth user created");
  }
}

// 2. Business row. owner_email is what Slack owner-mapping matches, so the
//    --owner-email override moves ONLY this column, not the login.
{
  const { error } = await db.from("businesses").upsert(
    {
      id: BUSINESS_ID,
      name: BUSINESS_NAME,
      owner_email: OWNER_EMAIL_OVERRIDE ?? REVIEWER_EMAIL,
      owner_name: "Slack Reviewer",
      tier: "standard",
      status: "online",
      is_paused: false,
      timezone: "America/Phoenix",
      business_type: "other"
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(`business upsert: ${error.message}`);
  console.log("[setup] business row ready");
}

// 2b. With --owner-email, owner_email no longer matches the login, and
//     dashboard access resolves through owner_email OR business_members.
//     A manager membership keeps the login working (Integrations + Run now
//     need manage_settings/manage_aiflows, which manager has; billing is
//     owner-only and the test plan never touches it).
if (OWNER_EMAIL_OVERRIDE) {
  const { error } = await db.from("business_members").upsert(
    {
      business_id: BUSINESS_ID,
      email: REVIEWER_EMAIL.toLowerCase(),
      role: "manager",
      status: "active",
      invited_by: REVIEWER_EMAIL.toLowerCase()
    },
    { onConflict: "business_id,email" }
  );
  if (error) throw new Error(`membership upsert: ${error.message}`);
  console.log("[setup] manager membership keeps the login's dashboard access");
}

// 3. Demo approval flow, enabled, at a fixed id.
{
  const { error } = await db.from("ai_flows").upsert(
    {
      id: DEMO_FLOW_ID,
      business_id: BUSINESS_ID,
      name: DEMO_FLOW_NAME,
      enabled: true,
      definition: parsed
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(`demo flow upsert: ${error.message}`);
  console.log("[setup] demo approval flow ready");
}

console.log("\n=== Reviewer credentials (paste into the Marketplace submission notes) ===");
console.log(`  URL:      https://www.newcoworker.com/login`);
console.log(`  Email:    ${REVIEWER_EMAIL}`);
console.log(`  Password: ${minted}`);
console.log("===========================================================================");
console.log("\nReviewer path: sign in, Integrations -> Slack -> Connect Slack, pick the");
console.log("alert channel, then AiFlows -> \"" + DEMO_FLOW_NAME + "\" -> Run now.");

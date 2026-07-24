/**
 * Provision the Google OAuth verification reviewer test account (idempotent).
 * Mirrors debug/zoom-reviewer-setup.ts / debug/meta-reviewer-setup.ts: a
 * Supabase auth user (email confirmed, password rotated + printed on every
 * apply, no MFA, so Google's Trust and Safety reviewers hit zero
 * authentication blockers) plus a "Google Review Sandbox (internal)" business
 * owned by that email, so the reviewer's login lands on a real dashboard with
 * the Integrations page and the Google (Nango) connect flow.
 *
 * NOT created here (manual, once): the reviewer connects THEIR OWN Google
 * account on the sandbox (Dashboard -> Integrations -> Connect Google); that
 * grant is exactly what they are reviewing. Stage an enabled email-triggered
 * flow on the sandbox before submission so the gmail.modify demo in the test
 * plan (read -> AI reply from the owner's address -> original marked read) is
 * end-to-end real.
 *
 * Usage:
 *   tsx debug/google-reviewer-setup.ts          # dry-run
 *   tsx debug/google-reviewer-setup.ts --apply
 */
import { randomBytes } from "node:crypto";
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const REVIEWER_EMAIL = "google.reviewer@newcoworker.com";
const BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000003";
const BUSINESS_NAME = "Google Review Sandbox (internal)";

const { createClient } = await import("@supabase/supabase-js");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

console.log("[setup] plan:", { email: REVIEWER_EMAIL, businessId: BUSINESS_ID, name: BUSINESS_NAME });

if (!APPLY) {
  console.log("[setup] dry run complete. Re-run with --apply to create.");
  process.exit(0);
}

// 1. Auth user (password rotated on every apply so a rerun always yields
//    known-good credentials). Minted at runtime, never hardcoded or stored
//    in the repo; it is pasted into the verification reply only.
const minted = ["Gr", randomBytes(12).toString("base64url")].join("-");
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

// 2. Business row owned by the reviewer email.
{
  const { error } = await db.from("businesses").upsert(
    {
      id: BUSINESS_ID,
      name: BUSINESS_NAME,
      owner_email: REVIEWER_EMAIL,
      owner_name: "Google Reviewer",
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

console.log("\n=== Reviewer credentials (paste into the verification email reply) ===");
console.log(`  URL:      https://www.newcoworker.com/login`);
console.log(`  Email:    ${REVIEWER_EMAIL}`);
console.log(`  Password: ${minted}`);
console.log("=======================================================================");
console.log("\nRemaining manual steps before resubmission:");
console.log("  1. Sign in as this account once and confirm the dashboard loads.");
console.log("  2. Enable an email-triggered flow on the sandbox so the gmail.modify");
console.log("     steps in /integrations/google/review-test-plan are demonstrable.");

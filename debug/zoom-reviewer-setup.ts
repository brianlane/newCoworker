/**
 * Provision the Zoom Marketplace reviewer test account (idempotent).
 *
 * Creates:
 *   1. A Supabase auth user (email confirmed, password printed once) for the
 *      Zoom reviewer to sign in at newcoworker.com/login.
 *   2. A "Zoom Review Sandbox (internal)" business owned by that email, so
 *      the login lands on a real dashboard with the Integrations page and
 *      the dashboard chat booking tools.
 *
 * NOT created here (manual, once): a connected calendar on the sandbox
 * business — sign in as the reviewer account and connect a Google/Microsoft
 * calendar so the test plan's booking steps are end-to-end real.
 *
 * Usage:
 *   tsx debug/zoom-reviewer-setup.ts          # dry-run
 *   tsx debug/zoom-reviewer-setup.ts --apply
 */
import { randomBytes } from "node:crypto";
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const REVIEWER_EMAIL = "zoom.reviewer@newcoworker.com";
const BUSINESS_ID = "e2b7a1c4-0000-4000-8000-00000000z00m".replace("z00m", "0001");
const BUSINESS_NAME = "Zoom Review Sandbox (internal)";

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

// 1. Auth user (credential reset to a fresh value on every apply so a rerun
//    always yields known-good credentials to paste into the release notes).
//    Minted at runtime — there is no hardcoded value here.
const minted = ["Zr", randomBytes(12).toString("base64url")].join("-");
{
  // Paginate the whole user list so idempotency survives >1000 auth users.
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
    console.log("[setup] auth user exists — password rotated");
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
      owner_name: "Zoom Reviewer",
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

console.log("\n=== Reviewer credentials (paste into the Zoom release notes) ===");
console.log(`  URL:      https://www.newcoworker.com/login`);
console.log(`  Email:    ${REVIEWER_EMAIL}`);
console.log(`  Password: ${minted}`);
console.log("=================================================================");
console.log("\nRemaining manual step: sign in as this account and connect a calendar");
console.log("(Dashboard → Integrations) so the booking steps in the test plan work.");

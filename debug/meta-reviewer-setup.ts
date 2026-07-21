/**
 * Provision the Meta App Review reviewer test account (idempotent).
 * Mirrors debug/zoom-reviewer-setup.ts: a Supabase auth user (email
 * confirmed, password printed once) plus a "Meta Review Sandbox (internal)"
 * business owned by that email, so the reviewer's login lands on a real
 * dashboard with the Integrations page and the Meta connect flow.
 *
 * Usage:
 *   tsx debug/meta-reviewer-setup.ts          # dry-run
 *   tsx debug/meta-reviewer-setup.ts --apply
 */
import { randomBytes } from "node:crypto";
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const REVIEWER_EMAIL = "meta.reviewer@newcoworker.com";
const BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000002";
const BUSINESS_NAME = "Meta Review Sandbox (internal)";

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
//    known-good credentials). Minted at runtime — no hardcoded value.
const minted = ["Mr", randomBytes(12).toString("base64url")].join("-");
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
      owner_name: "Meta Reviewer",
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

console.log("\n=== Reviewer credentials (paste into the App Review reviewer instructions) ===");
console.log(`  URL:      https://www.newcoworker.com/login`);
console.log(`  Email:    ${REVIEWER_EMAIL}`);
console.log(`  Password: ${minted}`);
console.log("===============================================================================");

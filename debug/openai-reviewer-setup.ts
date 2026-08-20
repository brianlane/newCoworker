#!/usr/bin/env tsx
/**
 * Provision the OpenAI / ChatGPT app reviewer sandbox (idempotent).
 *
 * WHY THIS EXISTS: v1.0.0 was rejected on 2026-08-19 with "We're unable to
 * complete your sign-in or OAuth flow. Please ensure valid, working
 * credentials are included". The cause was not the OAuth code: there was no
 * sandbox tenant at all, so the Testing step's credentials field was empty and
 * the reviewer had nothing to sign in with. The OAuth flow itself verifies
 * fine end to end.
 *
 * Follows debug/zoom-reviewer-setup.ts and debug/slack-reviewer-setup.ts: the
 * password is minted at runtime and printed once, never hardcoded and never
 * committed. Re-running rotates it, so a rerun always yields known-good
 * credentials to paste into the submission form.
 *
 * Creates:
 *   1. An owner auth user (email confirmed, no MFA) for the reviewer.
 *   2. A staff auth user on the same business, so the reviewer test plan can
 *      SHOW role enforcement server-side rather than assert it.
 *   3. The "Cedar Street Dental (demo)" business, America/Phoenix.
 *   4. The seed data the five submitted test cases name by name: Maria
 *      Alvarez (text thread), Tom Becker (completed call with a summary),
 *      Priya Nair (contact only).
 *
 * Contact numbers use the +1 555 01XX range, which is reserved for fiction
 * and cannot reach a real person. That satisfies "sample data only", and it
 * is also why test case 5's send will fail at the carrier: see the note this
 * script prints at the end.
 *
 * Usage:
 *   tsx debug/openai-reviewer-setup.ts            # dry run
 *   tsx debug/openai-reviewer-setup.ts --apply
 */
import { randomBytes } from "node:crypto";
import { normalizeContactNumber } from "../src/lib/telnyx/format.ts";
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

const OWNER_EMAIL = "openai.reviewer@newcoworker.com";
const STAFF_EMAIL = "openai.reviewer.staff@newcoworker.com";
const BUSINESS_ID = "e2b7a1c4-0000-4000-8000-000000000005";
const BUSINESS_NAME = "Cedar Street Dental (demo)";
const TIMEZONE = "America/Phoenix";

/**
 * Reserved fictional range: these cannot reach a real person.
 *
 * Tom and Priya stay fictional because nothing ever texts them. Maria is the
 * one contact test case 5 sends to, so a fictional number there means the
 * carrier rejects the send and the reviewer sees "Could not send". Pass a real
 * line you control to make that case actually pass:
 *
 *   tsx debug/openai-reviewer-setup.ts --apply --sms-target +1XXXXXXXXXX
 *   OPENAI_SANDBOX_SMS_TARGET=+1XXXXXXXXXX tsx debug/openai-reviewer-setup.ts --apply
 *
 * It is a flag and not a constant on purpose: the only sensible values are
 * someone's real phone number, and personal numbers do not belong in a repo.
 * The line must have NO AI automation attached, or our own coworker answers
 * the reviewer's test and texts the sandbox back.
 */
const TOM = "+15550177";
const PRIYA = "+15550198";

const smsFlagIdx = process.argv.indexOf("--sms-target");
const SMS_TARGET_RAW =
  (smsFlagIdx >= 0 ? process.argv[smsFlagIdx + 1] : undefined) ??
  process.env.OPENAI_SANDBOX_SMS_TARGET;
const MARIA_FALLBACK = "+15550142";
// Normalize through the SAME helper send_sms uses, so the number we seed is
// byte-identical to the one the reviewer's send resolves to. A bare 10-digit
// NANP number works; anything it refuses is refused here too, loudly, rather
// than silently seeding a contact nothing can text.
let MARIA = MARIA_FALLBACK;
if (SMS_TARGET_RAW) {
  const result = normalizeContactNumber(SMS_TARGET_RAW);
  if (!result.ok) {
    throw new Error(`--sms-target ${SMS_TARGET_RAW} is not a usable number: ${result.reason}`);
  }
  MARIA = result.value;
}
const SMS_TARGET_IS_REAL = MARIA !== MARIA_FALLBACK;

/**
 * The number test case 5's text is sent FROM.
 *
 * Without this row the sandbox has no messaging config, so
 * getTelnyxMessagingForBusiness falls back to the platform profile and Telnyx
 * picks whichever attached number it likes. That pool contains PAYING
 * CUSTOMERS' numbers, so a reviewer's demo text would appear to come from a
 * real customer's business line, and any reply would land in that customer's
 * inbox. Pinning it to +16023131823, our own New Coworker DID, keeps both the
 * send and any reply inside a business we own.
 */
const SMS_FROM_DEFAULT = "+16023131823";
const fromFlagIdx = process.argv.indexOf("--sms-from");
const SMS_FROM =
  (fromFlagIdx >= 0 ? process.argv[fromFlagIdx + 1] : undefined) ?? SMS_FROM_DEFAULT;

const CALL_ID = "e2b7a1c4-0005-4000-8000-000000000001";
const CALL_CONTROL_ID = "demo-call-tom-becker-0001";

const { createClient } = await import("@supabase/supabase-js");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

console.log("[setup] plan:", {
  business: BUSINESS_NAME,
  businessId: BUSINESS_ID,
  owner: OWNER_EMAIL,
  staff: STAFF_EMAIL,
  contacts: [MARIA, TOM, PRIYA],
  smsFrom: SMS_FROM,
  smsTarget: SMS_TARGET_IS_REAL
    ? `${MARIA} (real line, test case 5 will send)`
    : `${MARIA} (fictional, test case 5 WILL FAIL)`
});

if (!APPLY) {
  console.log("\n[setup] dry run complete. Re-run with --apply to create.");
  process.exit(0);
}

/**
 * A password Supabase will actually accept.
 *
 * Supabase enforces one character from each of lower, upper, digit and
 * symbol. `randomBytes().toString("base64url")` satisfies that only by luck,
 * so a rerun failed with "Password should contain at least one character of
 * each". This guarantees one of each, fills the rest from the full alphabet,
 * and shuffles with rejection-sampled randomness so no class sits at a fixed
 * position.
 */
function mintPassword(prefix: string): string {
  const classes = [
    "abcdefghijkmnopqrstuvwxyz",
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "23456789",
    "!@#$%^&*_-+="
  ];
  const all = classes.join("");
  const pick = (set: string): string => {
    // Rejection sampling: a plain modulo would bias toward the low end of the
    // set whenever 256 is not a multiple of its length.
    const limit = 256 - (256 % set.length);
    for (;;) {
      const b = randomBytes(1)[0];
      if (b < limit) return set[b % set.length];
    }
  };
  const chars = [...classes.map(pick)];
  while (chars.length < 20) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const limit = 256 - (256 % (i + 1));
    let b: number;
    do {
      b = randomBytes(1)[0];
    } while (b >= limit);
    const j = b % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return `${prefix}-${chars.join("")}`;
}

/** Find an auth user by email, paginating so >1000 users stays correct. */
async function findUser(email: string): Promise<{ id: string } | undefined> {
  for (let page = 1; ; page++) {
    const { data, error } = await db.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`list users: ${error.message}`);
    const hit = data.users.find(
      (u) => (u.email ?? "").toLowerCase() === email.toLowerCase()
    );
    if (hit) return hit;
    if (data.users.length < 1000) return undefined;
  }
}

/** Create or rotate one reviewer login. Returns the minted password. */
async function ensureUser(email: string, prefix: string): Promise<string> {
  const minted = mintPassword(prefix);
  const existing = await findUser(email);
  if (existing) {
    const { error } = await db.auth.admin.updateUserById(existing.id, {
      password: minted,
      email_confirm: true
    });
    if (error) throw new Error(`update ${email}: ${error.message}`);
    console.log(`[setup] ${email}: password rotated`);
  } else {
    const { error } = await db.auth.admin.createUser({
      email,
      password: minted,
      email_confirm: true
    });
    if (error) throw new Error(`create ${email}: ${error.message}`);
    console.log(`[setup] ${email}: created`);
  }
  return minted;
}

const ownerPassword = await ensureUser(OWNER_EMAIL, "Oai");
const staffPassword = await ensureUser(STAFF_EMAIL, "Oas");

// Business. owner_email is what the owner-role check matches on.
{
  const { error } = await db.from("businesses").upsert(
    {
      id: BUSINESS_ID,
      name: BUSINESS_NAME,
      owner_email: OWNER_EMAIL,
      owner_name: "Dana Reyes",
      tier: "standard",
      status: "online",
      is_paused: false,
      timezone: TIMEZONE,
      business_type: "other"
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(`business upsert: ${error.message}`);
  console.log("[setup] business row ready");
}

// Messaging config, so a send does not borrow a customer's number.
{
  const { error } = await db.from("business_telnyx_settings").upsert(
    { business_id: BUSINESS_ID, telnyx_sms_from_e164: SMS_FROM },
    { onConflict: "business_id" }
  );
  if (error) throw new Error(`telnyx settings: ${error.message}`);
  console.log(`[setup] messaging from-number pinned to ${SMS_FROM}`);
}

// Staff membership. This is the only thing that makes step 4 of the reviewer
// test plan a demonstration rather than a claim.
{
  const staffUser = await findUser(STAFF_EMAIL);
  const ownerUser = await findUser(OWNER_EMAIL);
  if (!ownerUser) throw new Error("owner auth user missing, cannot attribute the invite");
  const { data: existing } = await db
    .from("business_members")
    .select("id")
    .eq("business_id", BUSINESS_ID)
    .eq("email", STAFF_EMAIL)
    .maybeSingle();
  const row = {
    business_id: BUSINESS_ID,
    email: STAFF_EMAIL,
    user_id: staffUser?.id ?? null,
    role: "staff",
    status: "active",
    // NOT NULL: the roster records who issued the invite. The owner did.
    invited_by: ownerUser.id,
    accepted_at: new Date().toISOString(),
    revoked_at: null
  };
  const { error } = existing
    ? await db.from("business_members").update(row).eq("id", existing.id)
    : await db.from("business_members").insert(row);
  if (error) throw new Error(`staff member: ${error.message}`);
  console.log("[setup] staff membership ready");
}

// Contacts the submitted test cases name by name.
{
  const now = Date.now();
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const contacts = [
    {
      business_id: BUSINESS_ID,
      customer_e164: MARIA,
      display_name: "Maria Alvarez",
      type: "customer",
      tags: ["patient"],
      email: "maria.alvarez@example.com",
      pinned_md: "Prefers late-afternoon appointments.",
      summary_md:
        "Existing patient. Asked to move her cleaning off Tuesday; open to Thursday afternoon.",
      last_channel: "sms",
      last_interaction_at: iso(90),
      interaction_count: 3,
      total_interaction_count: 3
    },
    {
      business_id: BUSINESS_ID,
      customer_e164: TOM,
      display_name: "Tom Becker",
      // CONTACT_TYPES has no "lead"; a prospective patient is a customer here.
      type: "customer",
      tags: ["new-patient"],
      email: "tom.becker@example.com",
      summary_md: "Called asking what a crown costs and whether we take his insurance.",
      last_channel: "voice",
      last_interaction_at: iso(240),
      interaction_count: 1,
      total_interaction_count: 1
    },
    {
      business_id: BUSINESS_ID,
      customer_e164: PRIYA,
      display_name: "Priya Nair",
      type: "customer",
      tags: [],
      email: "priya.nair@example.com",
      last_channel: null,
      last_interaction_at: null,
      interaction_count: 0,
      total_interaction_count: 0
    }
  ];
  const { error } = await db
    .from("contacts")
    .upsert(contacts, { onConflict: "business_id,customer_e164" });
  if (error) throw new Error(`contacts upsert: ${error.message}`);
  console.log(`[setup] ${contacts.length} contacts ready`);
}

// Maria's text thread. Inbound rows live in sms_inbound_jobs with the Telnyx
// webhook envelope shape the reader expects; the AI reply rides on the same
// row (assistant_reply_text), which is why two messages come from one job.
{
  const now = Date.now();
  const iso = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  const inbound = (id: string, text: string, minutesAgo: number, reply: string | null) => ({
    id,
    business_id: BUSINESS_ID,
    telnyx_event_id: `demo-${id}`,
    customer_e164: MARIA,
    status: "done",
    channel: "sms",
    reply_channel: "sms",
    assistant_reply_text: reply,
    created_at: iso(minutesAgo),
    updated_at: iso(minutesAgo),
    payload: {
      data: {
        payload: {
          from: { phone_number: MARIA },
          text
        }
      }
    }
  });

  const jobs = [
    inbound(
      "e2b7a1c4-0005-4000-8000-000000000011",
      "Hi, I need to move my cleaning on Tuesday. Anything later in the week?",
      180,
      "Of course. We have Thursday afternoon open. Would 2:00 PM Arizona time work?"
    ),
    inbound(
      "e2b7a1c4-0005-4000-8000-000000000012",
      "Thursday could work, let me check with my office and get back to you.",
      90,
      "No rush. I'll hold Thursday afternoon for you until tomorrow."
    )
  ];
  const { error } = await db
    .from("sms_inbound_jobs")
    .upsert(jobs, { onConflict: "id" });
  if (error) throw new Error(`sms jobs upsert: ${error.message}`);
  console.log(`[setup] ${jobs.length} inbound jobs (with AI replies) ready`);
}

// Tom's completed call, with the summary the test case reads.
{
  const started = new Date(Date.now() - 240 * 60_000).toISOString();
  const ended = new Date(Date.now() - 236 * 60_000).toISOString();
  const { error } = await db.from("voice_call_transcripts").upsert(
    {
      id: CALL_ID,
      business_id: BUSINESS_ID,
      call_control_id: CALL_CONTROL_ID,
      caller_e164: TOM,
      direction: "inbound",
      call_kind: "ai",
      status: "completed",
      model: "demo-seed",
      started_at: started,
      ended_at: ended,
      summarized_at: ended,
      sentiment: "neutral",
      summary:
        "Tom Becker asked what a crown costs and whether the practice takes his insurance. Quoted the standard range and offered to verify his plan. He asked for a callback once coverage is confirmed."
    },
    { onConflict: "id" }
  );
  if (error) throw new Error(`call upsert: ${error.message}`);

  const turns = [
    ["assistant", "Thanks for calling Cedar Street Dental, how can I help?"],
    ["caller", "Hi, I was wondering how much a crown runs, and do you take Delta Dental?"],
    ["assistant", "A crown is typically in the twelve to fifteen hundred range before insurance. We do work with Delta Dental. I can verify your specific plan and call you back."],
    ["caller", "That would be great, thanks."],
    ["assistant", "I'll confirm your coverage and follow up. Have a good day."]
  ].map(([role, content], i) => ({
    // No explicit id: this table's id is a bigint sequence, not a uuid.
    transcript_id: CALL_ID,
    role,
    content,
    turn_index: i,
    started_at: new Date(Date.parse(started) + i * 20_000).toISOString()
  }));
  // Replace rather than upsert: the id is sequence-assigned, so there is no
  // stable key to conflict on. Scoped to this demo transcript only.
  const { error: delErr } = await db
    .from("voice_call_transcript_turns")
    .delete()
    .eq("transcript_id", CALL_ID);
  if (delErr) throw new Error(`turns clear: ${delErr.message}`);
  const { error: turnErr } = await db
    .from("voice_call_transcript_turns")
    .insert(turns);
  if (turnErr) throw new Error(`turns insert: ${turnErr.message}`);
  console.log(`[setup] call + ${turns.length} transcript turns ready`);
}

console.log("\n=== Reviewer credentials (paste into the submission form, NOT into the repo) ===");
console.log(`  Sign-in URL:     https://www.newcoworker.com/login`);
console.log(`  Owner email:     ${OWNER_EMAIL}`);
console.log(`  Owner password:  ${ownerPassword}`);
console.log(`  Staff email:     ${STAFF_EMAIL}`);
console.log(`  Staff password:  ${staffPassword}`);
console.log("================================================================================");
console.log(`
Remaining manual steps:

  1. Connect a calendar on this business (Dashboard, Integrations) with at
     least one open slot in the next seven days, or test case 4
     (calendar_find_slots) returns nothing.
${
  SMS_TARGET_IS_REAL
    ? `  2. Test case 5 will send to ${MARIA}. Confirm that line has no AI
     automation attached, or our own coworker answers the reviewer's test
     and texts the sandbox back.`
    : `  2. Test case 5 (send_sms) WILL FAIL as seeded. Maria's number is in the
     reserved +1 555 01XX fictional range, so the carrier rejects the send and
     the reviewer sees "Could not send". Re-run with a real line you control:
       tsx debug/openai-reviewer-setup.ts --apply --sms-target +1XXXXXXXXXX`
}
`);

/**
 * patch-hq-booking-offer.ts — teach the HQ follow-up flows to offer a
 * discovery call (the "HQ Discovery-Call Booking" plan, Jul 2026).
 *
 * The two HQ dogfood follow-up flows ("Demo caller follow-up (HQ)" and
 * "Webchat lead follow-up (HQ)", seeded by setup-hq-dogfood-flows.ts) pitch
 * and nudge but never invite the prospect to book. HQ's calendar
 * (newcoworkerteam@gmail.com via Nango) and Zoom (team@newcoworker.com) have
 * been connected since Jul 18-20 with zero bookings ever. This script
 * rewrites the `s_intro` and `s_nudge` SMS bodies in both flows so the
 * prospect is asked to reply with a day and time for a 15-minute discovery
 * call; the texting coworker already holds calendar_find_slots /
 * calendar_book_appointment, so it books the reply and the Zoom link rides
 * the confirmation. The existing `appointment_booked` goal step then stops
 * the nudge sequence.
 *
 * Also sweeps the legacy em dashes out of the touched bodies (repo writing
 * rule: no em dashes, ever).
 *
 * Idempotent: a body already equal to the target is a noop. Previous bodies
 * are printed on apply for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/patch-hq-booking-offer.ts          # dry-run
 *   npx tsx scripts/oneshot/patch-hq-booking-offer.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const BOOKING_NUDGE_BODY =
  "Quick follow-up from New Coworker. If you'd like your own AI coworker " +
  "answering your business calls and texts, setup takes about 10 minutes at " +
  "newcoworker.com. Or reply with a day and time that works and I'll book " +
  "you a quick 15-minute discovery call with our founder, Zoom link included.";

/** flow name → step id → replacement SMS body. */
const BODY_PATCHES: Record<string, Record<string, string>> = {
  "Demo caller follow-up (HQ)": {
    s_intro:
      "Hi {{vars.lead_name}}, thanks for calling the New Coworker demo line! " +
      "You just talked to the product itself: a 24/7 AI coworker that answers " +
      "calls and texts, books appointments, and follows up (like right now). " +
      "Plans start at $9.99/mo at newcoworker.com. Want to see how it fits " +
      "your business? Reply with a day and time and I'll book you a quick " +
      "15-minute discovery call with our founder.",
    s_nudge: BOOKING_NUDGE_BODY
  },
  "Webchat lead follow-up (HQ)": {
    s_intro:
      "Hi {{vars.lead_name}}, thanks for chatting with us at newcoworker.com! " +
      "That chat was the product itself: a 24/7 AI coworker that answers calls " +
      "and texts, books appointments, and follows up (like right now). Plans " +
      "start at $9.99/mo. Want to see how it fits your business? Reply with a " +
      "day and time and I'll book you a quick 15-minute discovery call with " +
      "our founder.",
    s_nudge: BOOKING_NUDGE_BODY
  }
};

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const { data: rows, error: listErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", HQ_BUSINESS_ID)
  .in("name", Object.keys(BODY_PATCHES));

if (listErr) {
  console.error("[oneshot] flow listing failed:", listErr.message);
  process.exit(1);
}

type FlowRow = {
  id: string;
  name: string;
  enabled: boolean;
  definition: { steps?: Array<Record<string, unknown>> } & Record<string, unknown>;
};

const flows = (rows ?? []) as FlowRow[];
const missing = Object.keys(BODY_PATCHES).filter((n) => !flows.some((f) => f.name === n));
if (missing.length > 0) {
  console.error("[oneshot] HQ flows not found:", missing.join(", "));
  process.exit(1);
}

const patched: Array<{
  id: string;
  name: string;
  definition: unknown;
  previousBodies: Record<string, string>;
}> = [];

for (const flow of flows) {
  const stepPatches = BODY_PATCHES[flow.name];
  const steps = Array.isArray(flow.definition.steps) ? flow.definition.steps : [];
  const previousBodies: Record<string, string> = {};
  let changed = 0;

  const nextSteps = steps.map((step) => {
    const stepId = typeof step.id === "string" ? step.id : "";
    const nextBody = stepPatches[stepId];
    if (!nextBody) return step;
    if (step.body === nextBody) return step;
    previousBodies[stepId] = String(step.body ?? "");
    changed += 1;
    return { ...step, body: nextBody };
  });

  const expected = Object.keys(stepPatches);
  const found = expected.filter((id) => steps.some((s) => s.id === id));
  if (found.length !== expected.length) {
    console.error(
      `[oneshot] "${flow.name}" is missing expected step(s): ` +
        expected.filter((id) => !found.includes(id)).join(", ")
    );
    process.exit(1);
  }

  if (changed === 0) {
    console.log(`[oneshot] noop   "${flow.name}" — bodies already patched`);
    continue;
  }

  let definition;
  try {
    definition = parseAiFlowDefinition({ ...flow.definition, steps: nextSteps });
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`[oneshot] "${flow.name}" failed validation:`, err.issues);
    } else {
      console.error(`[oneshot] "${flow.name}" failed validation:`, err);
    }
    process.exit(1);
  }

  console.log(`[oneshot] patch  "${flow.name}" (enabled=${flow.enabled}) → ${changed} body(ies)`);
  patched.push({ id: flow.id, name: flow.name, definition, previousBodies });
}

if (patched.length === 0) {
  console.log("[oneshot] nothing to patch.");
  process.exit(0);
}

if (!APPLY) {
  console.log(
    `[oneshot] dry run complete (${patched.length} flow(s) would change). Re-run with --apply to write.`
  );
  process.exit(0);
}

for (const p of patched) {
  console.log(`[oneshot] previous bodies for "${p.name}" (rollback reference):`);
  console.log(JSON.stringify(p.previousBodies, null, 2));
  const { error: updateErr } = await db
    .from("ai_flows")
    .update({ definition: p.definition, updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .eq("business_id", HQ_BUSINESS_ID);
  if (updateErr) {
    console.error(`[oneshot] update failed for "${p.name}":`, updateErr.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  "${p.name}"`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "patch-hq-booking-offer.ts",
  businessId: HQ_BUSINESS_ID,
  details: {
    flow_ids: patched.map((p) => p.id),
    flow_names: patched.map((p) => p.name),
    patched_steps: Object.fromEntries(
      patched.map((p) => [p.name, Object.keys(p.previousBodies)])
    )
  }
});

console.log("[oneshot] applied.");

/**
 * sync-hq-booking-copy.ts: make the HQ follow-up SMS copy quote the discovery
 * call's REAL length, read from the booking page rather than hardcoded.
 *
 * The defect (Jul 30 2026). One call had three different lengths attached to
 * it. The flow copy from patch-hq-booking-offer.ts advertised a "quick
 * 15-minute discovery call". HQ's `booking_meeting_types` row said 60 minutes,
 * which is what a prospect clicking the link actually books. And a prospect
 * who instead REPLIES with a time gets whatever `calendar_find_slots` decides,
 * which defaults to 30, because an AI-made booking carries no
 * `meeting_type_id` to inherit a length from. So the same text promised 15,
 * the click path booked 60, and the reply path booked 30.
 *
 * The reply path is fixed in code alongside this script: the scheduling prompt
 * line (src/lib/booking-page/prompt-line.ts) now states each meeting's
 * duration and instructs the coworker to book and quote exactly that. This
 * script fixes the copy, by deriving the number instead of restating it, so
 * the two can never drift again: re-run it after any change to HQ's meeting
 * length and the SMS bodies follow.
 *
 * Why a regex patch and not a body rewrite: the live bodies have drifted from
 * every script in the repo. patch-hq-booking-offer.ts wrote the booking offer,
 * then enable-hq-booking-page.ts appended an "Or book a time directly: <link>"
 * line. Rewriting whole bodies would silently drop that link, so only the
 * "N-minute discovery call" phrase is replaced, in place.
 *
 * Idempotent: a body already quoting the current duration is a noop. Previous
 * bodies are printed on apply for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/sync-hq-booking-copy.ts          # dry-run
 *   npx tsx scripts/oneshot/sync-hq-booking-copy.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const FLOW_NAMES = ["Demo caller follow-up (HQ)", "Webchat lead follow-up (HQ)"];
const PATCH_STEP_IDS = ["s_intro", "s_nudge"];

/**
 * Which meeting the copy is talking about. Matched case-insensitively against
 * the visible meeting names; the first hit wins, else the first visible
 * meeting (a page whose only meeting IS the discovery call).
 */
const DISCOVERY_NAME_HINT = /discovery/i;

/**
 * "a quick 15-minute discovery call", "a 60 minute discovery call", etc. The
 * optional "a" and "quick" are captured so they can be re-decided: "quick"
 * belongs on a 15-minute call and is a lie on an hour-long one.
 */
const DURATION_PHRASE_RE = /\b(a )?(quick )?(\d{1,3})[- ]minute (discovery call)/gi;

/** Past this, calling it "quick" oversells it. */
const QUICK_MAX_MINUTES = 30;

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { listMeetingTypes, visibleMeetingTypes } = await import(
  "../../src/lib/booking-page/meeting-types.ts"
);
const { recordOneshotApplied } = await import("./_ledger.ts");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

type FlowRow = {
  id: string;
  name: string;
  enabled: boolean;
  definition: { steps?: Array<Record<string, unknown>> } & Record<string, unknown>;
};

// --- 1. The source of truth: HQ's own booking page ------------------------

const visible = visibleMeetingTypes(await listMeetingTypes(HQ_BUSINESS_ID, db as never));
if (visible.length === 0) {
  console.error("[oneshot] HQ has no visible meeting types: nothing to derive a duration from.");
  process.exit(1);
}
const discovery = visible.find((t) => DISCOVERY_NAME_HINT.test(t.name)) ?? visible[0];
const durationMinutes = discovery.duration_minutes;
console.log(
  `[oneshot] booking page says: "${discovery.name}" runs ${durationMinutes} minutes` +
    ` (of ${visible.length} visible meeting(s))`
);

// --- 2. Patch the phrase in place ----------------------------------------

const { data: rows, error: listErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", HQ_BUSINESS_ID)
  .in("name", FLOW_NAMES);
if (listErr) {
  console.error("[oneshot] flow listing failed:", listErr.message);
  process.exit(1);
}
const flows = (rows ?? []) as FlowRow[];
const missing = FLOW_NAMES.filter((n) => !flows.some((f) => f.name === n));
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
  const steps = Array.isArray(flow.definition.steps) ? flow.definition.steps : [];
  const found = PATCH_STEP_IDS.filter((id) => steps.some((s) => s.id === id));
  if (found.length !== PATCH_STEP_IDS.length) {
    console.error(
      `[oneshot] "${flow.name}" is missing expected step(s): ` +
        PATCH_STEP_IDS.filter((id) => !found.includes(id)).join(", ")
    );
    process.exit(1);
  }

  const previousBodies: Record<string, string> = {};
  let changed = 0;

  const nextSteps = steps.map((step) => {
    const stepId = typeof step.id === "string" ? step.id : "";
    if (!PATCH_STEP_IDS.includes(stepId) || typeof step.body !== "string") return step;
    const body = step.body;
    const nextBody = body.replace(
      DURATION_PHRASE_RE,
      (_full, article: string | undefined, _quick: string | undefined, _mins: string, tail: string) =>
        `${article ?? ""}${durationMinutes <= QUICK_MAX_MINUTES ? "quick " : ""}` +
        `${durationMinutes}-minute ${tail}`
    );
    if (nextBody === body) return step;
    previousBodies[stepId] = body;
    changed += 1;
    return { ...step, body: nextBody };
  });

  if (changed === 0) {
    console.log(`[oneshot] noop   "${flow.name}": already quotes ${durationMinutes} minutes`);
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

  console.log(`[oneshot] patch  "${flow.name}" (enabled=${flow.enabled}): ${changed} body(ies)`);
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
  const { error } = await db
    .from("ai_flows")
    .update({ definition: p.definition, updated_at: new Date().toISOString() })
    .eq("id", p.id)
    .eq("business_id", HQ_BUSINESS_ID);
  if (error) {
    console.error(`[oneshot] update failed for "${p.name}":`, error.message);
    process.exit(1);
  }
  console.log(`[oneshot] wrote  "${p.name}"`);
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1] ?? "sync-hq-booking-copy.ts",
  businessId: HQ_BUSINESS_ID,
  details: {
    meeting_name: discovery.name,
    duration_minutes: durationMinutes,
    flow_ids: patched.map((p) => p.id),
    flow_names: patched.map((p) => p.name)
  }
});

console.log("[oneshot] applied.");

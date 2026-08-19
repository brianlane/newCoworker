/**
 * enable-hq-booking-page.ts, dogfood the native booking page on the HQ
 * tenant (the "HQ Discovery-Call Booking" plan, Jul 2026):
 *
 *   1. validate the flow patches FIRST (both HQ follow-up flows must carry
 *      the expected s_intro / s_nudge steps, and the patched definitions
 *      must pass parseAiFlowDefinition, using a placeholder link when the
 *      page row does not exist yet, so even the first dry run surfaces a
 *      validation failure before anything is written);
 *   2. on --apply: create-or-update HQ's booking_pages row (enabled,
 *      60-minute notice, sales-facing description), print the public
 *      /book/<token> link, then append an
 *      "Or book a time directly: <link>" line to the s_intro and s_nudge
 *      SMS bodies so a prospect can reply with a time OR click.
 *
 * Idempotent: the page upsert never rotates an existing token, bodies
 * already carrying the current link are left untouched, and a re-run
 * after a token rotation REPLACES the old link line. Previous bodies are
 * printed on apply for rollback.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/enable-hq-booking-page.ts          # dry-run
 *   npx tsx scripts/oneshot/enable-hq-booking-page.ts --apply  # write
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";
const PUBLIC_ORIGIN = "https://newcoworker.com";
const FLOW_NAMES = ["Demo caller follow-up (HQ)", "Webchat lead follow-up (HQ)"];
const PATCH_STEP_IDS = ["s_intro", "s_nudge"];
const LINK_LINE_RE = / Or book a time directly: \S+/;
/** Shape-identical stand-in for validation before the real token exists. */
const PLACEHOLDER_URL = `${PUBLIC_ORIGIN}/book/ncb_${"0".repeat(64)}`;

const { createClient } = await import("@supabase/supabase-js");
const { parseAiFlowDefinition, AiFlowValidationError } = await import(
  "../../src/lib/ai-flows/schema.ts"
);
const { upsertBookingPage, getBookingPageForBusiness } = await import(
  "../../src/lib/booking-page/db.ts"
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

/**
 * Patched definition + previous bodies for a flow, or null when every
 * target body already carries `url`. Throws on validation failure.
 */
function buildPatch(
  flow: FlowRow,
  url: string
): { definition: unknown; previousBodies: Record<string, string> } | null {
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
    if (!PATCH_STEP_IDS.includes(stepId)) return step;
    const body = String(step.body ?? "");
    const nextBody = `${body.replace(LINK_LINE_RE, "")} Or book a time directly: ${url}`;
    if (nextBody === body) return step;
    previousBodies[stepId] = body;
    changed += 1;
    return { ...step, body: nextBody };
  });
  if (changed === 0) return null;

  try {
    return { definition: parseAiFlowDefinition({ ...flow.definition, steps: nextSteps }), previousBodies };
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error(`[oneshot] "${flow.name}" failed validation:`, err.issues);
    } else {
      console.error(`[oneshot] "${flow.name}" failed validation:`, err);
    }
    process.exit(1);
  }
}

// --- 1. Load state, validate every write BEFORE any write ----------------

const existingPage = await getBookingPageForBusiness(HQ_BUSINESS_ID, db as never);
const knownUrl = existingPage ? `${PUBLIC_ORIGIN}/book/${existingPage.token}` : null;
console.log(
  `[oneshot] booking page: ${existingPage ? `exists (enabled=${existingPage.enabled})` : "will be created"}`
);
if (knownUrl) console.log(`[oneshot] existing link: ${knownUrl}`);

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

// Step presence + validation run with the real URL when it exists, else a
// shape-identical placeholder, so a definition that cannot take the link
// fails HERE, before the page row is ever created.
const validationUrl = knownUrl ?? PLACEHOLDER_URL;
for (const flow of flows) {
  const patch = buildPatch(flow, validationUrl);
  console.log(
    patch
      ? `[oneshot] patch  "${flow.name}" (enabled=${flow.enabled}), validated`
      : `[oneshot] noop   "${flow.name}", link already present`
  );
}

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

// --- 2. Apply: page row first (validated writes only from here on) -------

const page = await upsertBookingPage(
  HQ_BUSINESS_ID,
  {
    enabled: true,
    // Legacy: meeting types own the length a visitor actually books
    // (effectiveTypeSettings), so this list only matters for a page with zero
    // meeting types. HQ has several, so what it books is the meeting's
    // duration_minutes, not anything here.
    allowedDurations: [15, 30],
    minNoticeMinutes: 60,
    description:
      "Pick a time for a quick discovery call with our founder. " +
      "We'll look at how an AI coworker fits your business. No pitch, no pressure."
  },
  db as never
);
const bookingUrl = `${PUBLIC_ORIGIN}/book/${page.token}`;
console.log(`[oneshot] booking page enabled: ${bookingUrl}`);

const patchedIds: string[] = [];
for (const flow of flows) {
  const patch = buildPatch(flow, bookingUrl);
  if (!patch) {
    console.log(`[oneshot] noop   "${flow.name}", link already present`);
    continue;
  }
  console.log(`[oneshot] previous bodies for "${flow.name}" (rollback reference):`);
  console.log(JSON.stringify(patch.previousBodies, null, 2));
  const { error: updateErr } = await db
    .from("ai_flows")
    .update({ definition: patch.definition, updated_at: new Date().toISOString() })
    .eq("id", flow.id)
    .eq("business_id", HQ_BUSINESS_ID);
  if (updateErr) {
    console.error(`[oneshot] update failed for "${flow.name}":`, updateErr.message);
    process.exit(1);
  }
  patchedIds.push(flow.id);
  console.log(`[oneshot] wrote  "${flow.name}"`);
}

await recordOneshotApplied(db as never, {
  scriptPath: process.argv[1] ?? "enable-hq-booking-page.ts",
  businessId: HQ_BUSINESS_ID,
  details: { booking_url: bookingUrl, flow_ids: patchedIds }
});

console.log("[oneshot] applied.");

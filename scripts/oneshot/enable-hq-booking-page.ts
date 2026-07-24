/**
 * enable-hq-booking-page.ts — dogfood the native booking page on the HQ
 * tenant (the "HQ Discovery-Call Booking" plan, Jul 2026):
 *
 *   1. create-or-update HQ's booking_pages row (enabled, 15/30-minute
 *      discovery calls, 60-minute notice, sales-facing description) and
 *      print the public /book/<token> link;
 *   2. append a "book directly" line carrying that link to the `s_intro`
 *      and `s_nudge` SMS bodies of the two HQ follow-up flows, so a
 *      prospect can reply with a time OR click the link.
 *
 * Idempotent: the page upsert never rotates an existing token, and a flow
 * body already carrying a /book/ link is left untouched (re-running after
 * a token rotation REPLACES the old link line). Previous bodies are
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

// --- 1. Booking page row -------------------------------------------------

const existingPage = await getBookingPageForBusiness(HQ_BUSINESS_ID, db as never);
console.log(
  `[oneshot] booking page: ${existingPage ? `exists (enabled=${existingPage.enabled})` : "will be created"}`
);

let bookingUrl: string | null = existingPage
  ? `${PUBLIC_ORIGIN}/book/${existingPage.token}`
  : null;

if (APPLY) {
  const page = await upsertBookingPage(
    HQ_BUSINESS_ID,
    {
      enabled: true,
      allowedDurations: [15, 30],
      minNoticeMinutes: 60,
      description:
        "Pick a time for a quick discovery call with our founder. " +
        "We'll look at how an AI coworker fits your business. No pitch, no pressure."
    },
    db as never
  );
  bookingUrl = `${PUBLIC_ORIGIN}/book/${page.token}`;
  console.log(`[oneshot] booking page enabled: ${bookingUrl}`);
} else if (bookingUrl) {
  console.log(`[oneshot] existing link: ${bookingUrl}`);
} else {
  console.log("[oneshot] dry run: page row + link will be minted on --apply");
}

// --- 2. Flow copy: append the link ---------------------------------------

const { data: rows, error: listErr } = await db
  .from("ai_flows")
  .select("id, name, enabled, definition")
  .eq("business_id", HQ_BUSINESS_ID)
  .in("name", FLOW_NAMES);

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
  const previousBodies: Record<string, string> = {};
  let changed = 0;

  const nextSteps = steps.map((step) => {
    const stepId = typeof step.id === "string" ? step.id : "";
    if (!PATCH_STEP_IDS.includes(stepId)) return step;
    const body = String(step.body ?? "");
    // Without --apply the link may not exist yet; the dry run reports the
    // patch as pending instead of writing a placeholder.
    if (!bookingUrl) {
      changed += 1;
      return step;
    }
    const linkLine = ` Or book a time directly: ${bookingUrl}`;
    const stripped = body.replace(LINK_LINE_RE, "");
    const nextBody = `${stripped}${linkLine}`;
    if (nextBody === body) return step;
    previousBodies[stepId] = body;
    changed += 1;
    return { ...step, body: nextBody };
  });

  if (changed === 0) {
    console.log(`[oneshot] noop   "${flow.name}" — link already present`);
    continue;
  }
  if (!bookingUrl) {
    console.log(`[oneshot] patch  "${flow.name}" — link line pending (minted on --apply)`);
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

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
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

await recordOneshotApplied(db as never, {
  scriptPath: process.argv[1] ?? "enable-hq-booking-page.ts",
  businessId: HQ_BUSINESS_ID,
  details: {
    booking_url: bookingUrl,
    flow_ids: patched.map((p) => p.id),
    flow_names: patched.map((p) => p.name)
  }
});

console.log("[oneshot] applied.");

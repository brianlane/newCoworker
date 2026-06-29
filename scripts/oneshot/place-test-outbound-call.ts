#!/usr/bin/env tsx
/**
 * One-shot: place a REAL outbound AI call to verify the origination path end to
 * end (pre-dial budget probe -> Telnyx dial -> post-dial reserve -> ai_intake
 * session -> VPS bridge on answer -> post-call summary text).
 *
 * It ensures the business has an enabled OUTBOUND voice flow (creating a small
 * "Outbound test call (dev)" flow if none exists), then invokes the
 * telnyx-voice-originate Edge function with a per-call `toE164` override so the
 * call rings whatever number you pass (default: the dev's cell). Answer it to
 * confirm the AI talks, then hang up and check that the summary text arrives.
 *
 * Dry-run by default. Pass --apply to actually dial.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/place-test-outbound-call.ts                 # dry run
 *   npx tsx scripts/oneshot/place-test-outbound-call.ts --apply         # dial +16026866672
 *   npx tsx scripts/oneshot/place-test-outbound-call.ts --apply --to +1602...   # dial another #
 *   npx tsx scripts/oneshot/place-test-outbound-call.ts --apply --flow-id <uuid>  # use an existing flow
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's).
 */
import { createClient } from "@supabase/supabase-js";

type Args = {
  apply: boolean;
  businessId: string | null;
  flowId: string | null;
  to: string;
};

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DEFAULT_TO = "+16026866672"; // dev cell (per the live-test plan)
const TEST_FLOW_NAME = "Outbound test call (dev)";
const E164 = /^\+[1-9][0-9]{6,14}$/;

const INTAKE_PERSONA =
  "Hi, this is a quick test call from Amy Laidlaw's office — just confirming our outbound calling works. Can you hear me okay?";
const CAPTURE_FIELDS = ["name", "notes"];

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null, flowId: null, to: DEFAULT_TO };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else if (a === "--flow-id") args.flowId = argv[++i] ?? null;
    else if (a === "--to") args.to = argv[++i] ?? DEFAULT_TO;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const businessId =
    args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  if (!E164.test(args.to)) {
    console.error(`--to must be E.164: ${args.to}`);
    process.exit(2);
  }

  console.log(`Business : ${businessId}`);
  console.log(`Dialing  : ${args.to}`);

  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  if (!args.apply) {
    console.log("\n[dry-run] Not dialing. Re-run with --apply to place a real call.");
    return;
  }

  // Resolve a flow id: explicit --flow-id, else reuse an existing enabled
  // outbound voice flow, else create a small dev test flow.
  let flowId = args.flowId;
  if (!flowId) {
    const { data: existing, error: selErr } = await db
      .from("ai_flows")
      .select("id")
      .eq("business_id", businessId)
      .eq("definition->trigger->>channel", "voice")
      .eq("definition->trigger->>direction", "outbound")
      .eq("enabled", true)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (selErr) {
      console.error(`flow lookup failed: ${selErr.message}`);
      process.exit(1);
    }
    if (existing?.id) {
      flowId = existing.id as string;
      console.log(`Using existing outbound voice flow ${flowId}.`);
    } else {
      const definition = {
        version: 1,
        trigger: { channel: "voice", direction: "outbound" },
        steps: [
          {
            id: "call",
            type: "outbound_call",
            toE164: args.to,
            notifyE164: args.to,
            persona: INTAKE_PERSONA,
            captureFields: CAPTURE_FIELDS
          }
        ]
      };
      const { data: inserted, error: insErr } = await db
        .from("ai_flows")
        .insert({ business_id: businessId, name: TEST_FLOW_NAME, enabled: true, definition })
        .select("id")
        .single();
      if (insErr || !inserted?.id) {
        console.error(`flow insert failed: ${insErr?.message ?? "no id"}`);
        process.exit(1);
      }
      flowId = inserted.id as string;
      console.log(`Created test outbound voice flow ${flowId} ("${TEST_FLOW_NAME}").`);
    }
  }

  const res = await fetch(`${supabaseUrl.replace(/\/$/, "")}/functions/v1/telnyx-voice-originate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ businessId, flowId, toE164: args.to })
  });
  const out = (await res.json().catch(() => null)) as
    | { ok?: boolean; error?: string; reason?: string; callControlId?: string; to?: string }
    | null;

  if (res.ok && out?.ok) {
    console.log(`\nPlaced. call_control_id=${out.callControlId} to=${out.to}`);
    console.log("Answer your phone to confirm the AI speaks, then hang up and watch for the summary text.");
    return;
  }
  console.error(
    `\nNot placed (http ${res.status}): ${out?.reason ?? out?.error ?? "unknown"}`
  );
  process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

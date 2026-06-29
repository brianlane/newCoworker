#!/usr/bin/env tsx
/**
 * One-shot: migrate legacy voice routing rows into AiFlows `voice` flows so the
 * routing is authored / visible / CRUD-able in the AiFlows UI (the user ask).
 *
 * Reads, per business:
 *   - voice_handoff_chains   -> a handoff voice flow (ring_handoff* [+ voice_ai_intake])
 *   - voice_caller_transfer_rules -> a single voice_transfer flow
 * and inserts an equivalent enabled `ai_flows` row. The Telnyx voice webhook
 * already PREFERS a matching voice AiFlow and only falls back to these legacy
 * tables, so this migration is additive: we DON'T delete the legacy rows here
 * (a follow-up cleanup can, once live calls confirm the AiFlow path). Each
 * definition is validated with the real authoring schema before insert, so a
 * malformed legacy row fails loudly instead of persisting junk.
 *
 * Idempotent: skips a table row when an enabled-or-not voice flow already exists
 * for the same (business_id, trigger.fromE164). Dry-run by default.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/migrate-voice-routing-to-aiflows.ts            # dry run (Amy)
 *   npx tsx scripts/oneshot/migrate-voice-routing-to-aiflows.ts --apply
 *   npx tsx scripts/oneshot/migrate-voice-routing-to-aiflows.ts --apply --all
 *   npx tsx scripts/oneshot/migrate-voice-routing-to-aiflows.ts --apply --disable
 *
 * Required env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Business id: AIFLOW_SEED_BUSINESS_ID or --business-id <uuid> (defaults to Amy's);
 * pass --all to migrate every business that has legacy rows.
 */
import { createClient } from "@supabase/supabase-js";
import {
  parseAiFlowDefinition,
  type AiFlowDefinition,
  type FlowStep
} from "../../src/lib/ai-flows/schema";

type Args = { apply: boolean; all: boolean; disable: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, all: false, disable: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--all") args.all = true;
    else if (a === "--disable") args.disable = true;
    else if (a === "--business-id") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

type ChainRow = {
  business_id: string;
  from_e164: string;
  steps: unknown;
  ai_takeover: unknown;
  enabled: boolean;
};

type RuleRow = {
  business_id: string;
  from_e164: string;
  to_e164: string;
  whisper: string | null;
};

let stepSeq = 0;
function stepId(prefix: string): string {
  stepSeq += 1;
  return `${prefix}${stepSeq}`;
}

/** Build a handoff voice definition from a legacy chain row. */
function chainToDefinition(row: ChainRow): AiFlowDefinition {
  const steps: FlowStep[] = [];
  const rawSteps = Array.isArray(row.steps) ? (row.steps as unknown[]) : [];
  for (const s of rawSteps) {
    const o = (s ?? {}) as Record<string, unknown>;
    const to = typeof o.to_e164 === "string" ? o.to_e164 : "";
    if (!to) continue;
    const ringRaw = typeof o.ring_secs === "number" ? o.ring_secs : Number(o.ring_secs);
    const ringSeconds = Number.isFinite(ringRaw) && ringRaw >= 5 && ringRaw <= 120
      ? Math.floor(ringRaw)
      : undefined;
    steps.push({
      id: stepId("ring"),
      type: "ring_handoff",
      toE164: to,
      ...(ringSeconds ? { ringSeconds } : {})
    });
  }
  const ai = (row.ai_takeover ?? null) as Record<string, unknown> | null;
  if (ai && typeof ai.notify_e164 === "string" && ai.notify_e164) {
    const captureFields = Array.isArray(ai.capture_fields)
      ? (ai.capture_fields as unknown[]).filter((x): x is string => typeof x === "string")
      : [];
    steps.push({
      id: stepId("ai"),
      type: "voice_ai_intake",
      notifyE164: ai.notify_e164,
      ...(typeof ai.persona === "string" && ai.persona ? { persona: ai.persona } : {}),
      ...(captureFields.length > 0 ? { captureFields } : {})
    });
  }
  return parseAiFlowDefinition({
    version: 1,
    trigger: { channel: "voice", fromE164: row.from_e164 },
    steps
  });
}

/** Build a single blind-transfer voice definition from a legacy caller rule. */
function ruleToDefinition(row: RuleRow): AiFlowDefinition {
  const whisper = (row.whisper ?? "").trim();
  return parseAiFlowDefinition({
    version: 1,
    trigger: { channel: "voice", fromE164: row.from_e164 },
    steps: [
      {
        id: stepId("transfer"),
        type: "voice_transfer",
        toE164: row.to_e164,
        ...(whisper ? { whisper } : {})
      }
    ]
  });
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const supabaseUrl = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const serviceKey = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Defined as closures over `db` (rather than typed top-level helpers) so they
  // use the client's inferred schema type — aliasing it via ReturnType erases
  // it to `never` rows under the current supabase-js typings.

  /** All voice-flow caller numbers already in ai_flows for a business. */
  const existingVoiceFroms = async (businessId: string): Promise<Set<string>> => {
    const { data, error } = await db
      .from("ai_flows")
      .select("definition")
      .eq("business_id", businessId)
      .eq("definition->trigger->>channel", "voice");
    if (error) throw new Error(`existingVoiceFroms: ${error.message}`);
    const out = new Set<string>();
    for (const r of (data ?? []) as Array<{ definition?: { trigger?: { fromE164?: string } } }>) {
      const from = r.definition?.trigger?.fromE164;
      if (typeof from === "string" && from) out.add(from);
    }
    return out;
  };

  const insertFlow = async (
    businessId: string,
    name: string,
    enabled: boolean,
    definition: AiFlowDefinition
  ): Promise<void> => {
    const { error } = await db.from("ai_flows").insert({
      business_id: businessId,
      name: name.slice(0, 120),
      enabled,
      definition
    });
    if (error) throw new Error(`insert ${name}: ${error.message}`);
  };

  const scopeBusiness = args.all
    ? null
    : args.businessId ?? process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;

  console.log(`Scope    : ${scopeBusiness ?? "ALL businesses"}`);
  console.log(`Enabled  : ${!args.disable} (legacy rows kept as fallback)\n`);

  let chainQ = db.from("voice_handoff_chains").select("business_id, from_e164, steps, ai_takeover, enabled");
  if (scopeBusiness) chainQ = chainQ.eq("business_id", scopeBusiness);
  const { data: chainData, error: chainErr } = await chainQ;
  if (chainErr) {
    console.error(`Load voice_handoff_chains failed: ${chainErr.message}`);
    process.exit(1);
  }

  let ruleQ = db.from("voice_caller_transfer_rules").select("business_id, from_e164, to_e164, whisper");
  if (scopeBusiness) ruleQ = ruleQ.eq("business_id", scopeBusiness);
  const { data: ruleData, error: ruleErr } = await ruleQ;
  if (ruleErr) {
    console.error(`Load voice_caller_transfer_rules failed: ${ruleErr.message}`);
    process.exit(1);
  }

  const chains = (chainData ?? []) as ChainRow[];
  const rules = (ruleData ?? []) as RuleRow[];

  // Per-business existing voice-flow caller numbers (idempotency).
  const businessIds = new Set<string>([
    ...chains.map((c) => c.business_id),
    ...rules.map((r) => r.business_id)
  ]);
  const existingByBiz = new Map<string, Set<string>>();
  for (const bid of businessIds) existingByBiz.set(bid, await existingVoiceFroms(bid));

  let planned = 0;
  let skipped = 0;

  type Plan = {
    businessId: string;
    name: string;
    enabled: boolean;
    fromE164: string;
    summary: string;
    definition: AiFlowDefinition;
  };
  const plans: Plan[] = [];

  for (const c of chains) {
    const existing = existingByBiz.get(c.business_id)!;
    if (existing.has(c.from_e164)) {
      skipped += 1;
      console.log(`SKIP chain  ${c.business_id} ${c.from_e164} (voice flow already exists)`);
      continue;
    }
    const definition = chainToDefinition(c);
    const rings = definition.steps.filter((s) => s.type === "ring_handoff").length;
    const hasAi = definition.steps.some((s) => s.type === "voice_ai_intake");
    plans.push({
      businessId: c.business_id,
      name: `Voice routing — calls from ${c.from_e164}`,
      // Preserve the legacy chain's on/off state (unless --disable forces off).
      enabled: args.disable ? false : Boolean(c.enabled),
      fromE164: c.from_e164,
      summary: `ring ${rings} human(s)${hasAi ? " + AI takeover" : ""}`,
      definition
    });
    existing.add(c.from_e164); // guard against a dup chain+rule on the same from
  }

  for (const r of rules) {
    const existing = existingByBiz.get(r.business_id)!;
    if (existing.has(r.from_e164)) {
      skipped += 1;
      console.log(`SKIP rule   ${r.business_id} ${r.from_e164} (voice flow already exists)`);
      continue;
    }
    const definition = ruleToDefinition(r);
    plans.push({
      businessId: r.business_id,
      name: `Voice routing — calls from ${r.from_e164}`,
      enabled: !args.disable,
      fromE164: r.from_e164,
      summary: `transfer to ${r.to_e164}`,
      definition
    });
    existing.add(r.from_e164);
  }

  for (const p of plans) {
    planned += 1;
    console.log(
      `PLAN  ${p.businessId} ${p.fromE164} -> "${p.name}" [${p.summary}] enabled=${p.enabled}`
    );
  }

  console.log(`\nPlanned ${planned} new voice flow(s), skipped ${skipped} existing.`);

  if (!args.apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    return;
  }

  for (const p of plans) {
    await insertFlow(p.businessId, p.name, p.enabled, p.definition);
    console.log(`OK    inserted "${p.name}" (${p.fromE164}) for ${p.businessId}`);
  }
  console.log(`\nDone. Inserted ${plans.length} voice flow(s).`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

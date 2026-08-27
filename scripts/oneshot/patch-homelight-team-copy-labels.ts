#!/usr/bin/env tsx
/**
 * One-shot: label the lead facts in the HomeLight Referral flow's team copy
 * so a missed portal extraction reads as facts instead of "none none none".
 *
 * Fleet fallback-composition audit, Aug 27 2026. The HomeLight portal
 * extraction misses constantly (lead_phone held its 'none' fallback on 19 of
 * the 25 most recent runs, see docs/tenants/homelight-flow.md for why), and
 * the team surfaces composed the fields as a bare run-on:
 * "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}".
 * That FIRED six times between Jul 31 and Aug 14 2026: emails to
 * amy@amylaidlaw.com read "Lead: none ()  Address: Mesa" and one subject was
 * "none QT HL CC DAVE".
 *
 * Fix: the label style from Amy's cadence fix (PR #1673). Team copy now says
 * "Name/Phone/Email:" per fact, so a miss reads "Phone: none", a fact, not a
 * sentence fragment. The two `voice_brief` notes get the same treatment; the
 * AI reading them mid-call can say "I don't have their phone yet" from
 * "phone none" but only invent from "none none". Possessives over the
 * unpinned `lead_first_name` ("just sent {{vars.lead_first_name}}'s") become
 * "the client's": that var renders EMPTY on a miss, which read
 * "just sent's contact info".
 *
 * DELIBERATELY NOT CHANGED: the QT email subject
 * "{{vars.lead_name}} QT HL CC DAVE" (seed-homelight-lead-aiflow.ts,
 * env-pinned via AIFLOW_HOMELIGHT_QT_SUBJECT). Its trailing tokens are
 * Amy's own filing convention and likely feed inbox rules; a miss renders
 * "none QT HL CC DAVE", which is label-ish and keeps every token her rules
 * match on. Changing every subject to fix a rare cosmetic miss is the wrong
 * trade.
 *
 * Template-only: no step is added, removed, or moved, so flat step indices
 * are unchanged and parked runs are safe. Whole-phrase matching: sites that
 * drifted from the expected wording are reported and left alone. The dead
 * steps[26] owner notice (guarded on the impossible
 * "owner-notice-disabled-by-amy-2026-08-17" value) is out of scope.
 *
 * Idempotent, dry-run by default, validates through parseAiFlowDefinition,
 * prints the previous definition for rollback, records in applied_oneshots.
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-homelight-team-copy-labels.ts --business <uuid>
 *   npx tsx scripts/oneshot/patch-homelight-team-copy-labels.ts --business <uuid> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { parseAiFlowDefinition } from "../../src/lib/ai-flows/schema";
import { recordOneshotApplied } from "./_ledger";

export const HOMELIGHT_FLOW_NAME = "HomeLight Referral";

export type CopyFix = {
  /** The step property the phrase lives in; nothing else is touched. */
  key: "noteTemplate" | "body" | "message";
  old: string;
  new: string;
  /** How many sites the live flow carried on Aug 27 2026. */
  expected: number;
  label: string;
};

export const HOMELIGHT_COPY_FIXES: readonly CopyFix[] = [
  {
    key: "noteTemplate",
    old: "contact details: {{vars.lead_phone}} {{vars.lead_email}}. Property address:",
    new: "contact details: phone {{vars.lead_phone}}, email {{vars.lead_email}}. Property address:",
    expected: 2,
    label: "voice_brief release notes"
  },
  {
    key: "body",
    old: "assigned to you: {{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\nAddress:",
    new: "assigned to you: {{vars.lead_name}}. Phone: {{vars.lead_phone}}. Email: {{vars.lead_email}}\nAddress:",
    expected: 1,
    label: "claim SMS to the teammate"
  },
  {
    key: "body",
    old: "Lead: {{vars.lead_name}} ({{vars.lead_phone}}) {{vars.lead_email}}\nAddress:",
    new: "Lead: {{vars.lead_name}}. Phone: {{vars.lead_phone}}. Email: {{vars.lead_email}}\nAddress:",
    expected: 1,
    label: "QT email body"
  },
  {
    key: "body",
    old: "just sent {{vars.lead_first_name}}'s contact info: {{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\nAddress:",
    new: "just sent the client's contact info: {{vars.lead_name}}. Phone: {{vars.lead_phone}}. Email: {{vars.lead_email}}\nAddress:",
    expected: 2,
    label: "late contact-release SMS"
  },
  {
    key: "message",
    old: "just revealed {{vars.lead_first_name}}'s details: {{vars.lead_name}} {{vars.lead_phone}} {{vars.lead_email}}\nAddress:",
    new: "just revealed the client's details: {{vars.lead_name}}. Phone: {{vars.lead_phone}}. Email: {{vars.lead_email}}\nAddress:",
    expected: 3,
    label: "unclaimed reveal notifies"
  }
];

export type TransformResult = {
  definition: Record<string, unknown>;
  changed: boolean;
  notes: string[];
};

/** Apply every copy fix, wherever its step nests. Pure and exported for tests. */
export function relabelTeamCopy(input: unknown): TransformResult {
  const definition = structuredClone(input) as Record<string, unknown>;
  const notes: string[] = [];
  const patchedCount = new Map<CopyFix, number>();
  const fixedCount = new Map<CopyFix, number>();

  const visit = (node: unknown, path: string): void => {
    if (Array.isArray(node)) {
      node.forEach((v, i) => visit(v, `${path}[${i}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    const obj = node as Record<string, unknown>;
    for (const [key, value] of Object.entries(obj)) {
      const at = path ? `${path}.${key}` : key;
      if (typeof value === "string") {
        let text = value;
        for (const fix of HOMELIGHT_COPY_FIXES) {
          if (fix.key !== key) continue;
          if (text.includes(fix.old)) {
            text = text.split(fix.old).join(fix.new);
            patchedCount.set(fix, (patchedCount.get(fix) ?? 0) + 1);
            notes.push(`${at}: ${fix.label} labelled`);
          } else if (text.includes(fix.new)) {
            fixedCount.set(fix, (fixedCount.get(fix) ?? 0) + 1);
          }
        }
        if (text !== value) obj[key] = text;
        continue;
      }
      visit(value, at);
    }
  };
  visit(definition, "");

  let changed = false;
  for (const fix of HOMELIGHT_COPY_FIXES) {
    const patched = patchedCount.get(fix) ?? 0;
    const already = fixedCount.get(fix) ?? 0;
    if (patched > 0) changed = true;
    if (patched + already !== fix.expected) {
      notes.push(
        `${fix.label}: found ${patched + already} site(s), expected ${fix.expected}. ` +
          "The others drifted from the Aug 27 2026 wording; resolve by hand."
      );
    }
  }
  if (!changed) {
    const anyFixed = [...fixedCount.values()].some((n) => n > 0);
    notes.push(anyFixed ? "already patched" : "no known phrase found: the copy drifted, resolve by hand");
  }
  return { definition, changed, notes };
}

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  if (!args.businessId || !/^[0-9a-f-]{36}$/i.test(args.businessId)) {
    console.error("Pass --business <uuid>");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", args.businessId)
    .eq("name", HOMELIGHT_FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No "${HOMELIGHT_FLOW_NAME}" flow for ${args.businessId}`);
    process.exit(1);
  }

  console.log(`=== ${HOMELIGHT_FLOW_NAME} (${row.id}, enabled=${row.enabled}) ===`);
  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}`);

  const result = relabelTeamCopy(row.definition);
  for (const note of result.notes) console.log(`  - ${note}`);
  if (!result.changed) return;

  try {
    parseAiFlowDefinition(result.definition);
  } catch (e) {
    console.error(`  ! Patched definition is invalid: ${(e as Error).message}`);
    process.exit(1);
  }

  if (!args.apply) {
    console.log("  [dry-run] Not writing. Re-run with --apply.");
    return;
  }

  const { error: writeErr } = await db
    .from("ai_flows")
    .update({ definition: result.definition })
    .eq("id", row.id);
  if (writeErr) {
    console.error(`  ! Write failed: ${writeErr.message}`);
    process.exit(1);
  }
  console.log("  Written.");

  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId: args.businessId,
    details: { flow: `${HOMELIGHT_FLOW_NAME} (${row.id})`, fix: "team copy fact labels" }
  });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

/**
 * audit-phone-field-names.ts: find live extraction fields whose NAME reads as a
 * phone field but whose VALUE is not a phone number.
 *
 * `isPhoneFieldName` matches a phone token anywhere in a field name, by design:
 * it drives the "fill an empty phone field from the page text" fallback, where
 * a loose match is cheap and a miss is costly. That looseness becomes dangerous
 * the moment the name is used to gate something destructive. PR #885 (Jul 24
 * 2026) began running `sanitizeExtractedPhone` behind that predicate, which
 * rewrote Amy Laidlaw's `phone_lead_type` gate ("buyer"/"seller"/"both") to
 * "none" on every ReferralExchange run: all three route_to_team steps skipped
 * and 11 leads were texted but never offered to her team.
 *
 * Answering "which tenant flows would a change to phone-field handling touch?"
 * meant walking every live definition by hand. This is that walk, so the next
 * person edits phone-field code with the blast radius already in front of them.
 *
 *   tsx debug/audit-phone-field-names.ts              # at-risk fields only
 *   tsx debug/audit-phone-field-names.ts --all        # every phone-named field
 *   tsx debug/audit-phone-field-names.ts --json       # machine-readable
 *
 * Read-only. Requires SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY in `.env`.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { isPhoneFieldName } from "../supabase/functions/_shared/ai_flows/engine.ts";

loadEnv();

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required (.env)");
  process.exit(1);
}

const showAll = process.argv.includes("--all");
const asJson = process.argv.includes("--json");

type Step = {
  id?: string;
  type?: string;
  fields?: Array<{ name?: string; description?: string }>;
  when?: { var?: string; equals?: string; notEquals?: string; contains?: string };
  branches?: Array<{ id?: string; steps?: Step[]; condition?: { var?: string } }>;
  else?: Step[];
};

type Finding = {
  business: string;
  flow: string;
  flowId: string;
  enabled: boolean;
  step: string;
  field: string;
  description: string;
  /** The `when` guards that read this field: what breaks if it is clobbered. */
  readers: string[];
  atRisk: boolean;
};

/**
 * A phone-named field is AT RISK when its extraction prompt asks for a fixed
 * token rather than a number. Every gate field in the fleet is written as an
 * "answer exactly <token>" instruction, so `exactly` is the tell; a genuine
 * phone field either has no such instruction ("The phone number of the buyer")
 * or pairs it with a number format ("digits and + only ... exactly 'none'"),
 * which the format check below excludes.
 */
function looksLikeGateField(description: string): boolean {
  const d = description.toLowerCase();
  if (/e\.164|\+1\b|digits/.test(d)) return false;
  return /\bexactly\b/.test(d);
}

function collectReaders(steps: Step[], varName: string, path = ""): string[] {
  const out: string[] = [];
  for (const s of steps ?? []) {
    const here = `${path}${s.id ?? "?"}`;
    if (s.when?.var === varName) {
      const op =
        s.when.equals !== undefined
          ? `equals "${s.when.equals}"`
          : s.when.notEquals !== undefined
            ? `notEquals "${s.when.notEquals}"`
            : `contains "${s.when.contains}"`;
      out.push(`${here} (${s.type}) when ${op}`);
    }
    for (const b of s.branches ?? []) {
      if (b.condition?.var === varName) out.push(`${here}/${b.id} branch condition`);
      out.push(...collectReaders(b.steps ?? [], varName, `${here}/${b.id}: `));
    }
    out.push(...collectReaders(s.else ?? [], varName, `${here}/else: `));
  }
  return out;
}

function collectFields(steps: Step[], acc: Array<{ step: Step; name: string; desc: string }>): void {
  for (const s of steps ?? []) {
    for (const f of s.fields ?? []) {
      if (f.name) acc.push({ step: s, name: f.name, desc: f.description ?? "" });
    }
    for (const b of s.branches ?? []) collectFields(b.steps ?? [], acc);
    collectFields(s.else ?? [], acc);
  }
}

async function main(): Promise<void> {
  const db = createClient(SUPABASE_URL, SERVICE_KEY, { auth: { persistSession: false } });

  const [{ data: businesses, error: bizErr }, { data: flows, error: flowErr }] = await Promise.all([
    db.from("businesses").select("id,name"),
    db.from("ai_flows").select("id,business_id,name,enabled,definition")
  ]);
  if (bizErr || flowErr) {
    console.error(`Read failed: ${(bizErr ?? flowErr)?.message}`);
    process.exit(1);
  }
  const bizName = new Map((businesses ?? []).map((b) => [b.id as string, b.name as string]));

  const findings: Finding[] = [];
  for (const flow of flows ?? []) {
    const steps = ((flow.definition as { steps?: Step[] } | null)?.steps ?? []) as Step[];
    const fields: Array<{ step: Step; name: string; desc: string }> = [];
    collectFields(steps, fields);
    for (const f of fields) {
      if (!isPhoneFieldName(f.name)) continue;
      findings.push({
        business: bizName.get(flow.business_id as string) ?? (flow.business_id as string),
        flow: flow.name as string,
        flowId: flow.id as string,
        enabled: Boolean(flow.enabled),
        step: f.step.id ?? "?",
        field: f.name,
        description: f.desc,
        readers: collectReaders(steps, f.name),
        atRisk: looksLikeGateField(f.desc)
      });
    }
  }

  const shown = showAll ? findings : findings.filter((f) => f.atRisk);

  if (asJson) {
    console.log(JSON.stringify({ total: findings.length, atRisk: findings.filter((f) => f.atRisk).length, findings: shown }, null, 2));
    return;
  }

  console.log(
    `${findings.length} phone-named extraction field(s) across ${flows?.length ?? 0} flows; ` +
      `${findings.filter((f) => f.atRisk).length} hold non-phone values.`
  );
  if (!showAll) console.log("Showing at-risk only; pass --all for every phone-named field.\n");
  else console.log("");

  for (const f of shown) {
    const flag = f.atRisk ? "AT RISK" : "  phone";
    console.log(`${flag}  [${f.enabled ? "on " : "off"}] ${f.business} / ${f.flow}`);
    console.log(`         step ${f.step} defines ${f.field}`);
    if (f.description) console.log(`         "${f.description.slice(0, 120)}"`);
    for (const r of f.readers) console.log(`         read by ${r}`);
    console.log("");
  }
  if (shown.length === 0) console.log("Nothing to report.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

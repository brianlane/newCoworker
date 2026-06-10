#!/usr/bin/env tsx
/**
 * Seed (or inspect) a business's `ai_flow_team_members` roster — the
 * deterministic source for AiFlow `route_to_team` agent selection.
 *
 * With roster rows present, the ai-flow-worker offers leads to active members
 * in `last_offered_at` order (nulls first) and stamps the cursor on each
 * offer — engine-owned round-robin instead of asking Rowboat's memory. With
 * no rows, the worker falls back to the legacy Rowboat pick.
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/seed-aiflow-team.ts <businessId>                      # list current roster
 *   tsx debug/seed-aiflow-team.ts <businessId> "Name=+1480..." ...  # dry-run upsert
 *   tsx debug/seed-aiflow-team.ts <businessId> "Name=+1480..." --apply
 *
 * Member args are "<name>=<phone>"; phones may be loose NANP ("480 703 9575")
 * and are normalized to E.164. Existing rows for the same phone are updated
 * (name + reactivated), never duplicated. Rows NOT listed are left untouched —
 * deactivate manually if someone leaves the team.
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";

function normalizeNanpToE164(raw: string): string | null {
  if (/^\+[1-9]\d{6,14}$/.test(raw.trim())) return raw.trim();
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const positional = args.filter((a) => !a.startsWith("--"));
  const businessId = positional[0];
  if (!businessId) {
    console.error('Usage: tsx debug/seed-aiflow-team.ts <businessId> ["Name=+1480..." ...] [--apply]');
    process.exit(2);
  }

  const members: { name: string; phone_e164: string }[] = [];
  for (const spec of positional.slice(1)) {
    const eq = spec.indexOf("=");
    if (eq <= 0) {
      console.error(`Bad member spec (want "<name>=<phone>"): ${spec}`);
      process.exit(2);
    }
    const name = spec.slice(0, eq).trim();
    const phone = normalizeNanpToE164(spec.slice(eq + 1));
    if (!name || !phone) {
      console.error(`Bad member spec (name or phone unusable): ${spec}`);
      process.exit(2);
    }
    members.push({ name, phone_e164: phone });
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (members.length > 0) {
    console.log(`${apply ? "Upserting" : "[dry-run] Would upsert"} ${members.length} member(s):`);
    for (const m of members) console.log(`  ${m.name}  ${m.phone_e164}`);
    if (apply) {
      const { error } = await db
        .from("ai_flow_team_members")
        .upsert(
          members.map((m) => ({ business_id: businessId, ...m, active: true })),
          { onConflict: "business_id,phone_e164" }
        );
      if (error) {
        console.error(`Upsert failed: ${error.message}`);
        process.exit(1);
      }
      console.log("Upserted.");
    }
  }

  const { data, error } = await db
    .from("ai_flow_team_members")
    .select("name, phone_e164, active, last_offered_at, created_at")
    .eq("business_id", businessId)
    .order("last_offered_at", { ascending: true, nullsFirst: true })
    .order("created_at", { ascending: true });
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  console.log(`\nRoster for ${businessId} (rotation order — next offer goes to the top):`);
  if (!data?.length) {
    console.log("  (empty — route_to_team uses the legacy Rowboat memory pick)");
    return;
  }
  for (const r of data) {
    console.log(
      `  ${r.active ? "✓" : "✗"} ${r.name.padEnd(20)} ${r.phone_e164}  last_offered=${r.last_offered_at ?? "never"}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

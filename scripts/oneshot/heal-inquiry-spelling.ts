#!/usr/bin/env tsx
/**
 * One-shot: rewrite the British "enquiry" family to American spelling in
 * every live AiFlow definition and every open flow run's variable bag.
 *
 * WHY THIS EXISTS. Amy Laidlaw's leads were being called with "We're
 * following up on your enquiry through Clever". The spelling came from two
 * independent places and needed two different fixes:
 *
 *   1. The MODELS' own drift on turns nothing scripts. Fixed in the prompt:
 *      US_SPELLING_PROMPT_LINE (supabase/functions/_shared/sms_prompt_lines.ts)
 *      now rides every AI surface, with tests/inquiry-spelling.test.ts
 *      guarding the repo's copy-first surfaces so it cannot come back.
 *
 *   2. STORED COPY that literally instructs the model to say it. That is what
 *      this script fixes. A prompt line cannot win an argument with a flow
 *      whose persona template says the word verbatim, and the repo-side fix
 *      to the definition modules only changes what a FUTURE re-seed writes.
 *      The live rows are the source of truth for what runs tonight.
 *
 * WHAT IT TOUCHES, as measured on 2026-08-28:
 *   - ai_flows.definition: 3 flows, 17 occurrences. "Needs Follow Up (AI
 *     cadence)" and "ReferralExchange Lead" (both Amy, both ENABLED) carry it
 *     in spoken personas, voicemail scripts, team context templates, an email
 *     body, and the lead_site_ref extraction-field instruction. KIN
 *     Integrated Child Health's "New Lead Intake" (disabled) carries it in
 *     one greeting.
 *   - ai_flow_runs.context.vars: 15 runs parked in `awaiting_reply` on Amy's
 *     cadence, each holding lead_site_ref "your enquiry through <site>",
 *     written by the pre-fix extraction. These are the ones that would have
 *     spoken the wrong spelling on their NEXT call regardless of what the
 *     definition says, because the phrase is already baked into the run.
 *
 * A TEXT SUBSTITUTION, NOT A RE-SEED. The definition modules beside this
 * script regenerate a whole flow; edit_aiflow regenerates it through a model.
 * Both are the wrong tool for a six-letter spelling change on a live
 * automation, because they replace far more than they need to. This walks the
 * stored JSON and rewrites only the matching substrings, leaving structure,
 * ids, and every other byte untouched.
 *
 * SAFE TO RUN AND RE-RUN:
 *   - Dry-run by default; --apply is required to write.
 *   - Idempotent: healed rows match nothing on the next pass and are skipped.
 *   - Flow writes stamp edit_source/edit_actor, so the definition-versions
 *     trigger (migration 20260822182135) snapshots the prior bytes and the
 *     change is reversible from ai_flow_definition_versions.
 *   - Run writes are a compare-and-swap on `revision`: a worker that resumed
 *     the run between read and write bumps it, the update matches zero rows,
 *     and the run is reported as a skip rather than clobbering live state.
 *     PostgREST reports a zero-row update as success, so the row count is
 *     checked explicitly.
 *   - Only `awaiting_reply` and `queued` runs are considered. A `done` or
 *     `canceled` run has nothing left to say, and rewriting it would edit the
 *     record of what was actually sent.
 *   - Enqueues nothing and sends nothing.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/heal-inquiry-spelling.ts
 *   npx tsx scripts/oneshot/heal-inquiry-spelling.ts --apply
 *   npx tsx scripts/oneshot/heal-inquiry-spelling.ts --business <uuid> --apply
 */

/** Run statuses whose stored copy still has a future. */
export const OPEN_RUN_STATUSES = ["awaiting_reply", "queued"] as const;

/**
 * Case-preserving rewrite of the banned spelling family.
 *
 * Only the leading "e" actually changes, so the rest of each word (and every
 * suffix: -y, -ies, -ed, -ing) survives untouched and no word list is needed.
 * Casing is read off the match so "Enquiry" and "ENQUIRIES" come back as
 * "Inquiry" and "INQUIRIES" rather than being flattened to lower case.
 */
export function toAmericanInquirySpelling(text: string): string {
  return text.replace(/enquir/gi, (match) => {
    if (match[0] === match[0].toLowerCase()) return "inquir";
    return match === match.toUpperCase() ? "INQUIR" : "Inquir";
  });
}

/** Whether a value (of any shape) still holds the banned spelling anywhere. */
export function hasBannedSpelling(value: unknown): boolean {
  return /enquir/i.test(JSON.stringify(value ?? null));
}

/**
 * Rewrite every string inside an arbitrary JSON value, in place structurally
 * but returning a fresh value, and report how many strings changed.
 *
 * Walks the tree rather than round-tripping through JSON.stringify so a
 * string that happens to contain JSON punctuation, or a key that happens to
 * contain the spelling, is handled as data instead of as text. Object KEYS
 * are deliberately left alone: a flow's step ids and variable names are
 * referenced by other stored copy ("{{vars.lead_site_ref}}"), and none of the
 * live keys carry the spelling anyway.
 */
export function healJsonSpelling<T>(value: T): { healed: T; changed: number } {
  let changed = 0;
  const walk = (node: unknown): unknown => {
    if (typeof node === "string") {
      const next = toAmericanInquirySpelling(node);
      if (next !== node) changed += 1;
      return next;
    }
    if (Array.isArray(node)) return node.map(walk);
    if (node !== null && typeof node === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = walk(v);
      return out;
    }
    return node;
  };
  return { healed: walk(value) as T, changed };
}

/* c8 ignore start -- the IO shell; the pure helpers above are tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { recordOneshotApplied } = await import("./_ledger.ts");
  const { basename } = await import("node:path");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const BUSINESS_ID = argOf("business");
  const SCRIPT = basename(process.argv[1]);

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  console.log(APPLY ? "MODE: APPLY (writing)" : "MODE: DRY RUN (no writes)");
  if (BUSINESS_ID) console.log(`Scoped to business ${BUSINESS_ID}`);

  // ---------------------------------------------------------------------
  // 1. Flow definitions.
  // ---------------------------------------------------------------------
  // .limit() explicitly: an un-limited PostgREST select silently truncates at
  // 1000 rows, and a truncated scan would report a clean sweep it never made.
  let flowQuery = db
    .from("ai_flows")
    .select("id, business_id, name, enabled, definition")
    .order("created_at")
    .limit(5000);
  if (BUSINESS_ID) flowQuery = flowQuery.eq("business_id", BUSINESS_ID);
  const { data: flows, error: fErr } = await flowQuery;
  if (fErr) {
    console.error(`flow read failed: ${fErr.message}`);
    process.exit(1);
  }

  const flowResults: Array<Record<string, unknown>> = [];
  for (const flow of flows ?? []) {
    if (!hasBannedSpelling(flow.definition)) continue;
    const { healed, changed } = healJsonSpelling(flow.definition);
    console.log(
      `FLOW ${flow.id} "${flow.name}" (enabled=${flow.enabled}): ${changed} string(s)`
    );
    if (!APPLY) {
      flowResults.push({ id: flow.id, name: flow.name, strings: changed, applied: false });
      continue;
    }
    const { data: written, error: wErr } = await db
      .from("ai_flows")
      .update({
        definition: healed,
        // Consumed and cleared by the snapshot trigger; this is what makes
        // the edit attributable and reversible from the versions table.
        edit_source: "oneshot",
        edit_actor: SCRIPT
      })
      .eq("id", flow.id as string)
      .select("id");
    if (wErr) {
      console.error(`  write failed: ${wErr.message}`);
      process.exit(1);
    }
    if ((written ?? []).length !== 1) {
      console.error(`  write matched ${(written ?? []).length} rows, expected 1`);
      process.exit(1);
    }
    console.log("  written");
    flowResults.push({ id: flow.id, name: flow.name, strings: changed, applied: true });
  }

  // ---------------------------------------------------------------------
  // 2. Open runs' variable bags.
  // ---------------------------------------------------------------------
  let runQuery = db
    .from("ai_flow_runs")
    .select("id, flow_id, business_id, status, revision, context")
    .in("status", OPEN_RUN_STATUSES as unknown as string[])
    .order("created_at")
    .limit(5000);
  if (BUSINESS_ID) runQuery = runQuery.eq("business_id", BUSINESS_ID);
  const { data: runs, error: rErr } = await runQuery;
  if (rErr) {
    console.error(`run read failed: ${rErr.message}`);
    process.exit(1);
  }

  const runResults: Array<Record<string, unknown>> = [];
  let skipped = 0;
  for (const run of runs ?? []) {
    if (!hasBannedSpelling(run.context)) continue;
    const { healed, changed } = healJsonSpelling(run.context);
    console.log(`RUN ${run.id} (${run.status}, flow ${run.flow_id}): ${changed} string(s)`);
    if (!APPLY) {
      runResults.push({ id: run.id, strings: changed, applied: false });
      continue;
    }
    const { data: written, error: wErr } = await db
      .from("ai_flow_runs")
      .update({ context: healed })
      .eq("id", run.id as string)
      // Compare-and-swap: a worker that touched the run since the read has
      // bumped revision, so this matches nothing and the run is left alone.
      .eq("revision", run.revision as number)
      .select("id");
    if (wErr) {
      console.error(`  write failed: ${wErr.message}`);
      process.exit(1);
    }
    if ((written ?? []).length !== 1) {
      console.log("  SKIPPED: run advanced between read and write (revision moved)");
      skipped += 1;
      runResults.push({ id: run.id, strings: changed, applied: false, skipped: true });
      continue;
    }
    console.log("  written");
    runResults.push({ id: run.id, strings: changed, applied: true });
  }

  console.log(
    `\nSummary: ${flowResults.length} flow(s), ${runResults.length} run(s)` +
      (skipped > 0 ? `, ${skipped} run(s) skipped on revision` : "")
  );
  if (!APPLY) {
    console.log("Dry run: nothing written. Re-run with --apply.");
  } else if (flowResults.length > 0 || runResults.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1],
      businessId: BUSINESS_ID,
      details: { flows: flowResults, runs: runResults, skippedRuns: skipped }
    });
  }
}

/* c8 ignore stop */

#!/usr/bin/env tsx
/**
 * One-shot: seed the spoken site phrase (`lead_site_ref`) on PARKED "Needs
 * Follow Up (AI cadence)" runs, and fill a fallen-back `lead_site` from the
 * contact row's own record.
 *
 * The companion to re-seeding the cadence after its templates learned the
 * two-var site scheme (see amy-needs-follow-up-definition.ts, "THE SITE IS
 * TWO VARS"). The re-seed fixes the FUTURE: new runs extract both vars. It
 * cannot fix runs already in flight, whose variable bag was written by the
 * old extraction: they have no `lead_site_ref` at all, and the new persona
 * reads it, so an unhealed parked run that reaches its next call would render
 * a hole where the phrase belongs ("We're following up on about your move").
 * Four of the twelve parked runs on 2026-08-27 also hold the old fallback
 * `lead_site` ("your recent enquiry"), the value that composed into the
 * gibberish this whole change exists to stop (call 68ca8cdb, Sandy Baldwin).
 *
 * EVIDENCE FIRST, FALLBACK SECOND. For a run whose `lead_site` is the old
 * fallback (or empty, or "unknown"), the truth is looked up on the contact
 * row: `contacts.lead_source` is stamped by the platform from the filing
 * flow, and on 2026-08-27 all twelve parked runs' contacts carried a real
 * one (ReferralExchange or Clever). Only a lead whose contact row has no
 * `lead_source` gets the composable fallbacks ("unknown" for team copy,
 * "your recent inquiry" for spoken copy). A run whose extraction already
 * produced a real site keeps it; the contact row fills gaps, it does not
 * overrule the run.
 *
 * ORDERING: run this BEFORE `seed-amy-needs-follow-up-aiflow.ts --apply`.
 * Nothing in the OLD definition reads `lead_site_ref`, so seeding it first
 * is invisible; applied the other way round there is a window where the new
 * persona reads a var the parked runs do not have.
 *
 * Scoped to `awaiting_reply` runs, like the lead-type heal beside this one:
 * a `queued` run is mid-flight in the worker (and the two queued today are
 * deep in the email arm, which references neither site var); a `done` or
 * `canceled` run has nothing left to say.
 *
 * The write is a compare-and-swap on `revision`: a worker that resumed the
 * run between read and write bumps it, the update matches zero rows, and the
 * run is reported as a skip. PostgREST reports a zero-row update as success,
 * so the row count is checked explicitly.
 *
 * Idempotent (a healed run decides "already_right" on the next pass).
 * Dry-run by default. Records to applied_oneshots on --apply. Enqueues
 * nothing, sends nothing, and never touches a definition.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-heal-parked-cadence-lead-site.ts --business <uuid>
 *   npx tsx scripts/oneshot/amy-heal-parked-cadence-lead-site.ts --business <uuid> --apply
 */
import { CADENCE_FLOW_NAME } from "./amy-cadence-lead-type-from-note";

/** What the pre-fix extraction wrote for an unknown site, verbatim. */
export const OLD_SITE_FALLBACK = "your recent enquiry";

/** The post-fix team-facing fallback ("source: unknown"). */
export const UNKNOWN_SITE = "unknown";

/**
 * The post-fix spoken fallback. Same words as OLD_SITE_FALLBACK apart from
 * the spelling: saying "your recent inquiry" was always the right thing to
 * SAY, it was only ever wrong as the object of "through". The British
 * "enquiry" this used to write is now banned platform-wide
 * (US_SPELLING_PROMPT_LINE, tests/inquiry-spelling.test.ts), so OLD_SITE_FALLBACK
 * above survives ONLY as the matcher for rows written before 2026-08-28.
 */
export const UNKNOWN_SITE_REF = "your recent inquiry";

/** The spoken reference for a known site, matching the extraction's wording. */
export function siteRefFor(site: string): string {
  return `your inquiry through ${site}`;
}

/**
 * A ref carrying the pre-2026-08-28 British spelling is stale no matter which
 * site it names, so it gets recomposed rather than kept. Without this a
 * parked run healed after the spelling change would keep saying "your
 * enquiry through Clever" on its next call.
 */
export function refIsStaleSpelling(ref: string): boolean {
  return /enquir/i.test(ref);
}

export type SiteHealDecision =
  /** Write these values; `changed` names which of the two vars moved. */
  | { outcome: "set"; site: string; ref: string; changed: Array<"lead_site" | "lead_site_ref"> }
  /** Both vars already hold what this rule would write. */
  | { outcome: "already_right" };

/**
 * What to do with one parked run's site vars, given the contact row's
 * `lead_source`. Pure, so the rule is testable without a database and cannot
 * drift from what the script actually writes.
 */
export function decideSiteHeal(
  vars: Record<string, unknown>,
  leadSource: string | null | undefined
): SiteHealDecision {
  const rawSite = typeof vars.lead_site === "string" ? vars.lead_site : "";
  const rawRef = typeof vars.lead_site_ref === "string" ? vars.lead_site_ref : "";
  const currentSite = rawSite.trim();
  const currentRef = rawRef.trim();
  const truth =
    typeof leadSource === "string" && leadSource.trim() !== "" ? leadSource.trim() : null;
  // The run's own extraction wins when it produced a real site; the contact
  // row fills in only where the extraction fell back.
  const runKnows =
    currentSite !== "" && currentSite !== OLD_SITE_FALLBACK && currentSite !== UNKNOWN_SITE;
  const site = runKnows ? currentSite : (truth ?? UNKNOWN_SITE);
  // A ref that already names a site is kept; the bare fallback ref, and any
  // ref still spelled the British way, is recomposed from the site above.
  const refKnows =
    currentRef !== "" && currentRef !== UNKNOWN_SITE_REF && !refIsStaleSpelling(currentRef);
  const ref = refKnows ? currentRef : site === UNKNOWN_SITE ? UNKNOWN_SITE_REF : siteRefFor(site);
  // Compared against the RAW stored values, so a whitespace-padded var is
  // normalized on write (templates render var values verbatim, padding
  // included) while a clean one is left untouched.
  const changed: Array<"lead_site" | "lead_site_ref"> = [];
  if (site !== rawSite) changed.push("lead_site");
  if (ref !== rawRef) changed.push("lead_site_ref");
  if (changed.length === 0) return { outcome: "already_right" };
  return { outcome: "set", site, ref, changed };
}

/* c8 ignore start -- the IO shell; the pure decision above is tested */

if (import.meta.url === `file://${process.argv[1]}`) {
  const { loadEnv } = await import("../../debug/_shared.ts");
  loadEnv();
  const { createClient } = await import("@supabase/supabase-js");
  const { recordOneshotApplied } = await import("./_ledger.ts");

  const argOf = (name: string): string | null => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    return v && !v.startsWith("--") ? v : null;
  };
  const APPLY = process.argv.includes("--apply");
  const BUSINESS_ID = argOf("business");
  if (!BUSINESS_ID) {
    console.error(
      "Usage: tsx scripts/oneshot/amy-heal-parked-cadence-lead-site.ts --business <uuid> [--apply]"
    );
    process.exit(2);
  }
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY required in .env");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: flow, error: fErr } = await db
    .from("ai_flows")
    .select("id")
    .eq("business_id", BUSINESS_ID)
    .eq("name", CADENCE_FLOW_NAME)
    .maybeSingle();
  if (fErr) {
    console.error(`flow read failed: ${fErr.message}`);
    process.exit(1);
  }
  if (!flow) {
    console.error(`"${CADENCE_FLOW_NAME}" not found on business ${BUSINESS_ID}.`);
    process.exit(2);
  }

  const { data: parked, error: pErr } = await db
    .from("ai_flow_runs")
    .select("id, status, revision, created_at, context")
    .eq("flow_id", flow.id as string)
    .eq("status", "awaiting_reply")
    .order("created_at")
    .limit(1000);
  if (pErr) {
    console.error(`parked run read failed: ${pErr.message}`);
    process.exit(1);
  }

  const phones = [
    ...new Set(
      (parked ?? [])
        .map((r) => {
          const vars = ((r.context as Record<string, unknown>)?.vars ?? {}) as Record<
            string,
            unknown
          >;
          return typeof vars.lead_phone === "string" ? vars.lead_phone.trim() : "";
        })
        .filter((p) => p !== "")
    )
  ];
  const sourceOf = new Map<string, string>();
  if (phones.length > 0) {
    const { data: contacts, error: cErr } = await db
      .from("contacts")
      .select("customer_e164, lead_source")
      .eq("business_id", BUSINESS_ID)
      .in("customer_e164", phones);
    if (cErr) {
      console.error(`contact read failed: ${cErr.message}`);
      process.exit(1);
    }
    for (const c of contacts ?? []) {
      if (typeof c.lead_source === "string" && c.lead_source.trim() !== "") {
        sourceOf.set(c.customer_e164 as string, c.lead_source.trim());
      }
    }
  }

  type Target = {
    id: string;
    revision: number;
    name: string;
    site: string;
    ref: string;
    changed: string[];
    ctx: Record<string, unknown>;
  };
  const targets: Target[] = [];
  let alreadyRight = 0;

  console.log(`Business ${BUSINESS_ID}: ${(parked ?? []).length} parked cadence run(s).\n`);
  for (const run of parked ?? []) {
    const ctx = (run.context ?? {}) as Record<string, unknown>;
    const vars = (ctx.vars ?? {}) as Record<string, unknown>;
    const phone = typeof vars.lead_phone === "string" ? vars.lead_phone.trim() : "";
    const label = `${String(vars.lead_name ?? "(no name)")} (${phone || "no phone"})`;
    const decision = decideSiteHeal(vars, phone ? sourceOf.get(phone) : null);
    if (decision.outcome === "already_right") {
      alreadyRight++;
      continue;
    }
    console.log(
      `  SET  ${label}: lead_site=${JSON.stringify(decision.site)} lead_site_ref=${JSON.stringify(decision.ref)} (${decision.changed.join(", ")})`
    );
    targets.push({
      id: run.id as string,
      revision: run.revision as number,
      name: label,
      site: decision.site,
      ref: decision.ref,
      changed: decision.changed,
      ctx
    });
  }

  console.log(`\n  ${targets.length} to write, ${alreadyRight} already right.`);

  if (targets.length === 0) {
    console.log("\nNothing to do.");
    process.exit(0);
  }
  if (!APPLY) {
    console.log("\n[dry-run] Not writing. Re-run with --apply.");
    process.exit(0);
  }

  const healed: string[] = [];
  const skipped: string[] = [];
  for (const t of targets) {
    const nextVars = {
      ...((t.ctx.vars ?? {}) as Record<string, unknown>),
      lead_site: t.site,
      lead_site_ref: t.ref
    };
    const { data: updated, error } = await db
      .from("ai_flow_runs")
      .update({ context: { ...t.ctx, vars: nextVars } })
      .eq("id", t.id)
      // Optimistic concurrency: a worker that resumed this run since the read
      // has bumped revision, and this update then matches nothing.
      .eq("revision", t.revision)
      .eq("status", "awaiting_reply")
      .select("id");
    if (error) {
      console.error(`update ${t.name} failed: ${error.message}`);
      skipped.push(t.name);
      continue;
    }
    if ((updated ?? []).length !== 1) {
      console.error(`${t.name}: the run moved since it was read (revision changed), NOT written.`);
      skipped.push(t.name);
      continue;
    }
    healed.push(t.id);
    console.log(`Healed ${t.name}: ${t.changed.join(", ")}`);
  }
  if (healed.length > 0) {
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? "amy-heal-parked-cadence-lead-site.ts",
      businessId: BUSINESS_ID,
      details: { run_ids: healed }
    });
  }
  if (skipped.length > 0) {
    console.error(`\n${skipped.length} run(s) not written: ${skipped.join(", ")}. Re-run to retry.`);
    process.exit(1);
  }
  console.log("\nDone. Parked runs now speak the site phrase and show the team a real source.");
}

/* c8 ignore stop */

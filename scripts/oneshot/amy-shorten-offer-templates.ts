#!/usr/bin/env tsx
/**
 * One-shot: shorten Amy's team-offer copy so an unclaimed lead costs fewer
 * billed SMS segments, without dropping a single fact from the message.
 *
 * WHY, measured 2026-08-28 against `telnyx_cost_daily` and `sms_outbound_log`.
 * Telnyx went $30.78 (July) -> $50.95 (Aug 1-28). The per-segment rate did not
 * move ($0.00836 -> $0.00841); the volume did. Amy's `agent_offer` sends went
 * 101 -> 464 because the Aug 10-15 team-routing work (#1270, #1272, #1317,
 * #1397) fans every offer out to all four roster members instead of one. That
 * fan-out is what Amy asked for and is NOT what this script touches.
 *
 * What it touches is the cost of each individual offer. A carrier bills SMS in
 * SEGMENTS: 153 characters each in GSM-7, and only 67 each once any character
 * falls outside GSM-7 and forces UCS-2. Amy's 31 live `route_to_team` steps
 * carry ~190 characters of repeated reply-syntax boilerplate in every offer,
 * and two of them carry an emoji that halves the whole message's capacity.
 *
 * The four transforms, all mechanical and all reversible:
 *
 *   1. REPLY-SYNTAX BLOCK -> ONE LINE. The two explanatory lines ("You can
 *      also reply \"1, <ETA>\"..." and "Passing? You can reply
 *      \"2, <reason>\"...") become one shorter line that names all three
 *      things a reply can carry, including the lead-name form the old copy
 *      never mentioned. ~80 characters off every offer.
 *   2. CALL-SUMMARY SENTENCE -> SHORTER. "Whoever the AI rang first has the
 *      full call summary with what they want, their timeline, and when they
 *      asked to be called back." keeps its meaning in a third of the space.
 *   3. NON-ASCII CHARACTERS OUT. A single emoji (the two Realtor.com
 *      templates end "Thanks." plus a grinning face) drops the whole message
 *      from 153 to 67 characters per segment, so a 400-character offer costs
 *      6 segments instead of 3. The transform normalizes the characters that
 *      have an ASCII equivalent (curly quotes, dashes, exotic spaces) and
 *      drops the rest.
 *   4. WHITESPACE TIDY. Trailing spaces and 3+ consecutive newlines, which
 *      are billed like any other character.
 *
 * WHAT IT DELIBERATELY DOES NOT DO:
 *
 * - It does not change WHO is offered, the deadline, the reminder ladder, or
 *   the first-to-claim vs next-agent wording. Broadcast steps say "First to
 *   reply 1 gets it" and rotations say "or it goes to the next agent"; that
 *   distinction is load-bearing (see amy-broadcast-realtor-and-offer-copy.ts)
 *   and every transform here leaves both lines byte-identical.
 * - It does not touch `Details: {{trigger.windowText}}` on the Clever route,
 *   which is the single largest line in any offer (the raw referral blob,
 *   ~9 segments per send). Cutting it is a judgement call about what the team
 *   needs to see, not a mechanical saving, so it stays Amy's decision. The
 *   dry-run prints what removing it would save.
 * - It cannot fix the largest single waste, because that one is not in the
 *   copy at all: `{{offer.deadline}}` renders through `formatInTimeZone`
 *   (supabase/functions/_shared/ai_flows/quiet_hours.ts), whose
 *   `Intl.DateTimeFormat` emits U+202F (a narrow no-break space) between the
 *   time and "PM" on the Edge runtime's ICU. That one invisible character
 *   forces UCS-2 on EVERY offer that names a deadline, halving capacity
 *   fleet-wide. It needs a one-line engine fix, not a tenant one-shot.
 *
 * Read-modify-write against the LIVE definitions, validated through the same
 * parseAiFlowDefinition the dashboard uses, idempotent (every transform is a
 * match-and-replace that finds nothing on a second pass), dry-run by default.
 * `--revert` restores the exact previous definition from the ledger.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/amy-shorten-offer-templates.ts            # dry run
 *   npx tsx scripts/oneshot/amy-shorten-offer-templates.ts --apply
 *   npx tsx scripts/oneshot/amy-shorten-offer-templates.ts --revert --apply
 *
 * Exit codes: 0 patched/no-op/dry-run - 1 Supabase error - 2 bad env or shape.
 */
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { AiFlowValidationError, parseAiFlowDefinition } from "@/lib/ai-flows/schema";
import { smsSegmentInfo } from "@/lib/sms/segment-info";
import { recordOneshotApplied } from "./_ledger";

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const SCRIPT = "amy-shorten-offer-templates.ts";

/** What Telnyx actually charged per segment in Aug 2026, for the dry-run math. */
const CENTS_PER_SEGMENT_USD = 0.0084;

// ---------------------------------------------------------------------------
// Segment accounting
// ---------------------------------------------------------------------------

/**
 * Billed segments for one body, through the SAME calculator the SMS meter and
 * the composer UI use (`smsSegmentInfo`). Deliberately not a second
 * implementation: the whole point of this script is the 153-vs-67 cliff, and
 * two copies of that rule would eventually disagree about which side of it a
 * message sits on.
 */
export function segmentsFor(text: string): { segments: number; encoding: "gsm" | "ucs2" } {
  const info = smsSegmentInfo(text);
  return { segments: info.segments, encoding: info.encoding };
}

// ---------------------------------------------------------------------------
// The transforms
// ---------------------------------------------------------------------------

/**
 * The reply-syntax explanation, in the two shapes Amy's flows actually carry,
 * and the one line that replaces both. Matching is on the literal text so a
 * template that has already been shortened is left alone (idempotence).
 */
export const ETA_LINE =
  'You can also reply "1, <ETA>" to claim and tell us when you\'ll reach out (e.g. "1, 20 min").';
export const PASS_LINE_LONG =
  'Passing? You can reply "2, <reason>" to tell us why (e.g. "2, out of town").';
export const PASS_LINE_SHORT = 'Passing? Reply "2, <reason>" to say why (e.g. "2, out of town").';
/**
 * Names all three things a reply can carry, in one line instead of two
 * sentences. The lead-name form is real and has been since PR #1270: with two
 * or more offers pending, "1, <name>" matches against the sender's own live
 * offers (accents folded, exact beats partial) and only falls through to the
 * ETA parser when nothing matches. A bare "1" with several pending asks which
 * lead, which is the confusion this line exists to prevent.
 */
export const COMPACT_REPLY_LINE =
  '1 to claim, or add a note if useful: "1, <ETA to call>", ' +
  '"1, <Name of lead (if multiple)>" or "2, out of town".';

/**
 * Collapse the reply-syntax boilerplate to one line.
 *
 * Both source lines teach the same thing: a reply may carry a comma and a
 * note. The compact line keeps both worked examples, which is the part a
 * teammate actually copies, and drops the sentence around them. A template
 * carrying only one of the two lines still collapses, so the shapes cannot
 * drift apart.
 */
export function compactReplySyntax(template: string): string {
  const lines = template.split("\n");
  const isBoilerplate = (l: string): boolean => {
    const t = l.trim();
    return t === ETA_LINE || t === PASS_LINE_LONG || t === PASS_LINE_SHORT;
  };
  if (!lines.some(isBoilerplate)) return template;
  const out: string[] = [];
  let placed = false;
  for (const line of lines) {
    if (!isBoilerplate(line)) {
      out.push(line);
      continue;
    }
    // The compact line takes the position of the FIRST boilerplate line, so
    // the message keeps its existing shape and the mode-specific lines around
    // it ("First to reply 1 gets it." / "or it goes to the next agent") stay
    // exactly where the reader expects them.
    if (!placed) {
      out.push(COMPACT_REPLY_LINE);
      placed = true;
    }
  }
  return out.join("\n");
}

/**
 * Shorten the call-summary sentence.
 *
 * It appears verbatim on the Clever buyer route and all three ReferralExchange
 * routes, is 126 characters, and is repeated to every teammate on every offer
 * and never changes. The replacement keeps the one fact a teammate acts on:
 * the person the AI rang first is the one who knows the details.
 */
export const CALL_SUMMARY_LONG =
  "Whoever the AI rang first has the full call summary with what they want, " +
  "their timeline, and when they asked to be called back.";
export const CALL_SUMMARY_SHORT =
  "Whoever the AI rang first has the full call summary.";

export function compactCallSummary(template: string): string {
  return template.includes(CALL_SUMMARY_LONG)
    ? template.split(CALL_SUMMARY_LONG).join(CALL_SUMMARY_SHORT)
    : template;
}

/**
 * Characters with an exact ASCII equivalent, mirroring the worker's own
 * `gsmSafeSmsText` normalization table (supabase/functions/_shared/ai_flows/
 * compliance.ts) so a template shortened here renders byte-identically to what
 * the worker would have produced anyway.
 *
 * TWO ADDITIONS the worker's table does not have, both invisible and both
 * expensive: U+202F (narrow no-break space, which is what `Intl` puts between
 * the time and "PM", so it rides in on anything pasted from a rendered
 * message) and the zero-width family including U+FE0F, the variation selector
 * that follows most emoji.
 */
const ASCII_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/[\u2018\u2019\u02BC\u201B]/g, "'"],
  [/[\u201C\u201D]/g, '"'],
  [/[\u2013\u2014]/g, "-"],
  [/\u2026/g, "..."],
  [/[\u00A0\u202F\u2007\u2009\u200A]/g, " "],
  [/[\u200B\u200C\u200D\uFEFF\uFE0F]/g, ""],
  [/\u2022/g, "-"]
];

/**
 * Force a template to ASCII, which is the test the biller actually applies:
 * `smsSegmentInfo` (and the worker before it) treats ANY non-ASCII character
 * as forcing UCS-2, cutting every segment from 153 characters to 67. One emoji
 * therefore doubles the price of a 400-character offer with no visible change
 * to the reader.
 *
 * Anything without an ASCII equivalent is dropped rather than transliterated.
 * That is safe here because these are offer templates written in English; it
 * would NOT be safe on tenant-facing copy in a language that needs accents,
 * which is why this lives in a one-shot and not in the engine.
 *
 * Template placeholders survive untouched: `{`, `}` and `<` are all ASCII.
 */
export function forceAscii(template: string): string {
  let out = template;
  for (const [pattern, replacement] of ASCII_SUBSTITUTIONS) out = out.replace(pattern, replacement);
  return out.replace(/[^\x00-\x7F]/gu, "");
}

/** Trailing spaces and runs of blank lines, billed like any other character. */
export function tidyWhitespace(template: string): string {
  return template
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Every transform, in the order the dry-run reports them. */
export function shortenTemplate(template: string): string {
  return tidyWhitespace(forceAscii(compactCallSummary(compactReplySyntax(template))));
}

// ---------------------------------------------------------------------------
// Walking the definitions
// ---------------------------------------------------------------------------

type AnyStep = Record<string, unknown> & { id?: string; type?: string };
type Definition = { steps?: AnyStep[] };

/**
 * Every `route_to_team` step in a definition, including the ones nested in
 * branch arms. Amy has 31 of them across 8 enabled flows and they are NOT all
 * top-level, so a flat scan silently misses most of the spend.
 */
export function routeSteps(steps: AnyStep[]): AnyStep[] {
  const out: AnyStep[] = [];
  for (const s of steps) {
    if (s.type === "route_to_team") out.push(s);
    if (s.type === "branch") {
      for (const arm of (s.branches as Array<{ steps?: AnyStep[] }> | undefined) ?? []) {
        out.push(...routeSteps(arm.steps ?? []));
      }
      out.push(...routeSteps((s.else as AnyStep[] | undefined) ?? []));
    }
  }
  return out;
}

export type FieldChange = {
  step: string;
  field: string;
  before: string;
  after: string;
  segmentsBefore: number;
  segmentsAfter: number;
  encodingBefore: string;
};

/**
 * Shorten every offer and reminder-details template in one definition, in
 * place. Returns one entry per field that actually changed, so a re-run
 * reports nothing and writes nothing.
 */
export function patchDefinition(def: Definition): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const step of routeSteps(def.steps ?? [])) {
    const id = String(step.id ?? "(unnamed)");

    const offer = step.offerTemplate;
    if (typeof offer === "string") {
      const next = shortenTemplate(offer);
      if (next !== offer) {
        step.offerTemplate = next;
        const b = segmentsFor(offer);
        changes.push({
          step: id,
          field: "offerTemplate",
          before: offer,
          after: next,
          segmentsBefore: b.segments,
          segmentsAfter: segmentsFor(next).segments,
          encodingBefore: b.encoding
        });
      }
    }

    // The reminder ladder re-sends `detailsTemplate` up to three more times to
    // everyone who was offered, so a character saved here is a character saved
    // three or four times over.
    const reminders = step.unclaimedReminders as { detailsTemplate?: unknown } | undefined;
    const details = reminders?.detailsTemplate;
    if (reminders && typeof details === "string") {
      const next = shortenTemplate(details);
      if (next !== details) {
        reminders.detailsTemplate = next;
        const b = segmentsFor(details);
        changes.push({
          step: id,
          field: "unclaimedReminders.detailsTemplate",
          before: details,
          after: next,
          segmentsBefore: b.segments,
          segmentsAfter: segmentsFor(next).segments,
          encodingBefore: b.encoding
        });
      }
    }
  }
  return changes;
}

/**
 * The line this script deliberately leaves alone, reported so the decision is
 * visible rather than silent. `{{trigger.windowText}}` expands to the raw
 * vendor referral blob (~1,500 characters on Clever), which is the single
 * largest thing in any offer.
 */
function reportWindowText(flowName: string, def: Definition): void {
  for (const step of routeSteps(def.steps ?? [])) {
    const t = step.offerTemplate;
    if (typeof t === "string" && t.includes("{{trigger.windowText}}")) {
      console.log(
        `    note: ${flowName} step ${String(step.id)} still carries ` +
          `"Details: {{trigger.windowText}}" (the raw vendor blob, ~9 segments per send). ` +
          `Left as-is on purpose: dropping it is Amy's call, not a mechanical saving.`
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function requireEnv(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (!v) {
    console.error(`Missing required env: ${name}`);
    process.exit(2);
  }
  return v;
}

function argValue(flag: string, fallback: string): string {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

function printChange(c: FieldChange): void {
  const delta = c.segmentsBefore - c.segmentsAfter;
  console.log(
    `  ${c.step}.${c.field}: ${c.before.length} -> ${c.after.length} chars, ` +
      `${c.segmentsBefore} -> ${c.segmentsAfter} segments (${c.encodingBefore})` +
      (delta > 0 ? `, -${delta}` : "")
  );
  if (process.argv.includes("--verbose")) {
    console.log("    --- before ---");
    for (const l of c.before.split("\n")) console.log(`    | ${l}`);
    console.log("    --- after ---");
    for (const l of c.after.split("\n")) console.log(`    | ${l}`);
  }
}

async function revert(
  // deno-lint-ignore no-explicit-any
  db: any,
  businessId: string,
  apply: boolean
): Promise<void> {
  const { data: rows, error } = await db
    .from("applied_oneshots")
    .select("details,applied_at")
    .eq("business_id", businessId)
    .eq("script", basename(SCRIPT))
    .order("applied_at", { ascending: false });
  if (error) {
    console.error(`Ledger read failed: ${error.message}`);
    process.exit(1);
  }
  const newest = new Map<string, Record<string, unknown>>();
  for (const row of (rows ?? []) as Array<{ details: Record<string, unknown> | null }>) {
    const d = row.details;
    const name = String(d?.flow_name ?? "");
    if (!name || d?.reverted === true || !d?.previous_definition) continue;
    if (!newest.has(name)) newest.set(name, d);
  }
  if (newest.size === 0) {
    console.error("No applied ledger rows with a previous_definition to revert to.");
    process.exit(2);
  }
  for (const [name, d] of newest) {
    console.log(`revert ${name} (${String(d.flow_id)})`);
    if (!apply) continue;
    const { error: upErr } = await db
      .from("ai_flows")
      .update({ definition: d.previous_definition })
      .eq("id", String(d.flow_id))
      .eq("business_id", businessId);
    if (upErr) {
      console.error(`Revert failed for ${name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> reverted.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: { flow_id: d.flow_id, flow_name: name, reverted: true }
    });
  }
  if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --revert --apply.");
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const businessId = argValue("--business-id", DEFAULT_BUSINESS_ID);
  const url = requireEnv("NEXT_PUBLIC_SUPABASE_URL", process.env.SUPABASE_URL);
  const key = requireEnv("SUPABASE_SERVICE_ROLE_KEY");
  const db = createClient(url, key, { auth: { persistSession: false } });

  if (process.argv.includes("--revert")) {
    await revert(db, businessId, apply);
    return;
  }

  // ENABLED flows only. A disabled flow sends nothing, so rewording it buys
  // no segments and risks touching something parked for a reason.
  const { data, error } = await db
    .from("ai_flows")
    .select("id,name,definition")
    .eq("business_id", businessId)
    .eq("enabled", true);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  const rows = (data ?? []) as Array<{ id: string; name: string; definition: Definition }>;
  if (rows.length === 0) {
    console.error(`No enabled flows found on business ${businessId}`);
    process.exit(2);
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let touchedFlows = 0;

  for (const row of rows) {
    const previous = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const def = JSON.parse(JSON.stringify(row.definition)) as Definition;
    const changes = patchDefinition(def);
    if (changes.length === 0) continue;

    try {
      parseAiFlowDefinition(def);
    } catch (e) {
      console.error(`${row.name} would become INVALID, aborting before any write:`);
      if (e instanceof AiFlowValidationError) for (const s of e.issues) console.error(`  - ${s}`);
      else console.error(e);
      process.exit(2);
    }

    touchedFlows += 1;
    console.log(`\n${row.name}`);
    for (const c of changes) {
      printChange(c);
      totalBefore += c.segmentsBefore;
      totalAfter += c.segmentsAfter;
    }
    reportWindowText(row.name, def);

    if (!apply) continue;
    const { error: upErr } = await db.from("ai_flows").update({ definition: def }).eq("id", row.id);
    if (upErr) {
      console.error(`Update failed for ${row.name}: ${upErr.message}`);
      process.exit(1);
    }
    console.log("  -> updated.");
    await recordOneshotApplied(db, {
      scriptPath: process.argv[1] ?? SCRIPT,
      businessId,
      details: {
        flow_id: row.id,
        flow_name: row.name,
        touched: changes.map((c) => `${c.step}.${c.field}`),
        segments_before: changes.reduce((n, c) => n + c.segmentsBefore, 0),
        segments_after: changes.reduce((n, c) => n + c.segmentsAfter, 0),
        previous_definition: previous
      }
    });
  }

  if (touchedFlows === 0) {
    console.log("Every offer template is already short. Nothing to do.");
    return;
  }

  const saved = totalBefore - totalAfter;
  console.log(
    `\n${touchedFlows} flow(s). Template segments ${totalBefore} -> ${totalAfter} (-${saved}).`
  );
  // Template segments are NOT the saving. A rendered offer is longer than its
  // template (the vars fill in) and goes to up to four teammates, so the only
  // honest number comes from replaying real sent bodies through these same
  // transforms. Measured over Amy's 450 agent_offer sends of Aug 1-28 2026:
  // 2,072 billed segments as sent -> 1,964 with this reword, which is 108
  // segments or about $0.91 a month at $0.0084/segment.
  //
  // It was $1.54 before the reply line grew to name the "1, <name>" form.
  // That is a deliberate trade: a bare "1" with several offers pending asks
  // which lead, and a teammate who does not know the name form has to answer
  // a second text. Sixty cents a month is worth less than that round trip.
  console.log(
    `Template segments are not the saving: a rendered offer is longer than its ` +
      `template and goes to up to 4 teammates. Replaying Amy's 450 real Aug 2026 ` +
      `offer sends through these transforms gives 2,072 -> 1,964 billed segments, ` +
      `about $${(108 * CENTS_PER_SEGMENT_USD).toFixed(2)} a month.`
  );
  console.log(
    `Two ENGINE fixes are worth more than this script and are not tenant copy: ` +
      `the {{offer.deadline}} narrow no-break space (-475 segments, ` +
      `$${(475 * CENTS_PER_SEGMENT_USD).toFixed(2)}/mo for Amy alone, and it hits every ` +
      `tenant) and the final-reminder banner emoji (-55 segments, ` +
      `$${(55 * CENTS_PER_SEGMENT_USD).toFixed(2)}/mo). Re-measure from telnyx_cost_daily ` +
      `after a full billing period rather than trusting any of these lines.`
  );
  if (!apply) console.log("\n[dry-run] Nothing written. Re-run with --apply.");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

/**
 * undo-spam-flag.ts, reverse a WRONGFUL owner spam flag on a real contact.
 *
 * Background (Jul 24 2026, KYP Ads / Chris Gregoris): James texted "stop
 * texting chris please" about a hot lead who was waiting on a personal call,
 * and the owner-operator turn mapped it onto flag_contact_spam, an
 * irreversible STOP-list block plus a spam tag and a "declared this contact
 * SPAM" pinned note. The right primitive for that intent is
 * contacts.sms_reply_mode='suppress' (no default Coworker reply; manual
 * sends and inbound processing unaffected). This script undoes the flag and
 * applies the intended state.
 *
 * SAFETY GATE: the script scans the contact's ENTIRE inbound history with
 * the same isStopKeyword matcher the compliance handler uses and ABORTS if
 * the person ever texted STOP themselves, a genuine customer opt-out is
 * sacred (CTIA / A2P 10DLC) and only the contact texting START may lift it.
 * Only tool-/owner-written suppression is reversible here.
 *
 * What --apply does (ordered so no sending gap ever opens, the opt-outs
 * clear LAST, after everything that limits sending is in place):
 *   1. Set sms_reply_mode via the shared dashboard helper (alias-aware,
 *      creates a minimal contact row when none exists). Default: suppress,
 *      honoring the owner's actual "stop texting them" request; pass
 *      --reply-mode auto to fully restore the coworker.
 *   2. On suppress intent, cancel the lead's pending automation runs (shared
 *      cancelPendingRunsForLead core); an incomplete sweep ABORTS before the
 *      opt-outs are touched.
 *   3. Contact cleanup: remove the "spam" tag and the pinned-note lines
 *      carrying the spam-declaration marker.
 *   4. sms_clear_opt_out RPC for every identity number, removes the
 *      suppression rows.
 *
 * Usage:
 *   set -a && source .env && set +a
 *   npx tsx scripts/oneshot/undo-spam-flag.ts --business <uuid> --phone +1XXXXXXXXXX            # dry-run
 *   npx tsx scripts/oneshot/undo-spam-flag.ts --business <uuid> --phone +1XXXXXXXXXX --apply    # write
 *   (optional) --reply-mode suppress|auto   (default suppress)
 */
import { loadEnv } from "../../debug/_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const BUSINESS_ID = argValue("--business") ?? "";
const PHONE = argValue("--phone") ?? "";
const REPLY_MODE = argValue("--reply-mode") ?? "suppress";

if (!/^[0-9a-f-]{36}$/i.test(BUSINESS_ID)) {
  console.error("[oneshot] pass --business <uuid>");
  process.exit(1);
}
if (!/^\+\d{8,15}$/.test(PHONE)) {
  console.error("[oneshot] pass --phone <E.164, e.g. +18579289096>");
  process.exit(1);
}
if (!["suppress", "auto"].includes(REPLY_MODE)) {
  console.error("[oneshot] --reply-mode must be suppress or auto");
  process.exit(1);
}

const { createClient } = await import("@supabase/supabase-js");
const { recordOneshotApplied } = await import("./_ledger.ts");
const { isStopKeyword, inboundSmsBody } = await import(
  "../../supabase/functions/_shared/telnyx_sms_compliance.ts"
);
const { cancelPendingRunsForLead, LEAD_STOPPABLE_STATUSES } = await import(
  "@/lib/customer-tools/cancel-lead-runs"
);
const { setContactSmsReplyMode } = await import("@/lib/customer-memory/db");

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
  { auth: { persistSession: false } }
);

const SPAM_TAG = "spam";
/** The exact marker every tool-written spam note carries (flag-spam.ts). */
const SPAM_NOTE_MARKER = "declared this contact SPAM";

// ---------------------------------------------------------------------------
// Current state.
// ---------------------------------------------------------------------------
// Read AFTER the contact resolve below builds the identity set, declared
// here, filled in once identitySet exists.
let optRows: Array<{ sender_e164: string; kind: string; set_at: string }> = [];

// Alias-aware, like mark-lead-spam.ts: --phone may be a merged alias while
// the tag/note live on the canonical row.
const { data: contactRows, error: contactErr } = await db
  .from("contacts")
  .select("id, display_name, customer_e164, alias_e164s, tags, pinned_md, sms_reply_mode")
  .eq("business_id", BUSINESS_ID)
  .or(`customer_e164.eq.${PHONE},alias_e164s.cs.{${PHONE}}`)
  .limit(1);
if (contactErr) {
  console.error("[oneshot] contact read failed:", contactErr.message);
  process.exit(1);
}
const contact = (contactRows ?? [])[0] ?? null;

// Every number the person may have texted from (the STOP scan must cover
// merged aliases too, not just the number the operator quoted).
const identitySet = [
  ...new Set(
    [
      PHONE,
      ...(typeof contact?.customer_e164 === "string" ? [contact.customer_e164] : []),
      ...(Array.isArray(contact?.alias_e164s) ? (contact.alias_e164s as string[]) : [])
    ].filter((n) => /^\+\d{8,15}$/.test(n))
  )
];

// Suppression rows across the whole identity set, a spam flag opted out
// every number, so the undo must clear every number.
const { data: optData, error: optErr } = await db
  .from("sms_opt_outs")
  .select("sender_e164, kind, set_at")
  .eq("business_id", BUSINESS_ID)
  .in("sender_e164", identitySet);
if (optErr) {
  console.error("[oneshot] opt-out read failed:", optErr.message);
  process.exit(1);
}
optRows = (optData ?? []) as typeof optRows;

// ---------------------------------------------------------------------------
// SAFETY GATE: did this person ever text a STOP keyword themselves? Scan the
// business's FULL inbound history (paginated past any row cap) and match the
// sender per row from BOTH the customer_e164 column AND the raw Telnyx
// payload, historical rows can carry the sender only in the payload (NULL /
// mismatched column). Bodies are extracted with the SAME inboundSmsBody
// helper the compliance handler uses (RCS nests text under a body object).
// A genuine customer STOP must never be cleared by platform tooling.
// ---------------------------------------------------------------------------
const identityMatch = new Set(identitySet);
const PAGE = 1000;
const stopTexts: string[] = [];
let scanned = 0;
{
  // Compound keyset cursor (created_at, id): rows sharing a timestamp across
  // a page boundary are still fetched, a strict created_at-only cursor
  // could skip them.
  let cursor: { createdAt: string; id: string } | null = null;
  for (;;) {
    let query = db
      .from("sms_inbound_jobs")
      .select("id, created_at, customer_e164, payload")
      .eq("business_id", BUSINESS_ID)
      .order("created_at", { ascending: true })
      .order("id", { ascending: true })
      .limit(PAGE);
    if (cursor) {
      query = query.or(
        `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`
      );
    }
    const { data: inboundRows, error: inErr } = await query;
    if (inErr) {
      console.error("[oneshot] inbound history read failed:", inErr.message);
      process.exit(1);
    }
    const rows = (inboundRows ?? []) as Array<{
      id: string;
      created_at: string;
      customer_e164: unknown;
      payload: unknown;
    }>;
    for (const row of rows) {
      const inner =
        (row.payload as { data?: { payload?: Record<string, unknown> } })?.data?.payload ?? {};
      const payloadFrom = (inner as { from?: { phone_number?: unknown } }).from?.phone_number;
      const senders = [row.customer_e164, payloadFrom].filter(
        (s): s is string => typeof s === "string"
      );
      if (!senders.some((s) => identityMatch.has(s))) continue;
      scanned += 1;
      const text = inboundSmsBody(inner);
      if (isStopKeyword(text.trim().toUpperCase())) {
        stopTexts.push(`${row.created_at} (${senders.join("/")}): ${text.trim()}`);
      }
    }
    if (rows.length < PAGE) break;
    const last = rows[rows.length - 1];
    cursor = { createdAt: last.created_at, id: last.id };
  }
}
if (stopTexts.length > 0) {
  console.error(
    "[oneshot] ABORT: this contact texted a STOP keyword themselves, a genuine customer " +
      "opt-out can only be lifted by the contact texting START:"
  );
  for (const line of stopTexts) console.error(`[oneshot]   ${line}`);
  process.exit(1);
}

const label = contact?.display_name ? `${contact.display_name} (${PHONE})` : PHONE;
console.log(`[oneshot] contact: ${label} (row ${contact?.id ?? "none"})`);
console.log(`[oneshot] identity set: ${identitySet.join(", ")}`);
console.log(
  `[oneshot] opt-out row(s): ${optRows.length > 0 ? optRows.map((r) => `${r.sender_e164} kind=${r.kind} set_at=${r.set_at}`).join("; ") : "none"}`
);
console.log(`[oneshot] inbound texts scanned: ${scanned}, no STOP keyword found`);
console.log(`[oneshot] tags: ${JSON.stringify(contact?.tags ?? [])}`);
console.log(`[oneshot] sms_reply_mode: ${contact?.sms_reply_mode ?? "(no contact)"} → ${REPLY_MODE}`);

if (!APPLY) {
  console.log("[oneshot] dry run complete. Re-run with --apply to write.");
  process.exit(0);
}

// The order below is deliberate: everything that limits sending (reply mode,
// run cancels) lands BEFORE the opt-outs are cleared, while opt-out rows
// exist no path can text the person, so there is never a gap where an
// uncanceled run could deliver.

// ---------------------------------------------------------------------------
// 1. Reply mode FIRST, via the shared helper the dashboard toggle uses
//    (alias-aware, creates a minimal contact row when none exists, so a
//    wrongful flag whose tag write failed still ends in the intended mode).
// ---------------------------------------------------------------------------
await setContactSmsReplyMode(BUSINESS_ID, PHONE, REPLY_MODE as "suppress" | "auto", db as never);
console.log(`[oneshot] sms_reply_mode set to ${REPLY_MODE}`);

// ---------------------------------------------------------------------------
// 2. On suppress intent, stop any pending automation runs for the lead,
//    runs the original spam-flag sweep missed (or enrolled since) must be
//    dead BEFORE the opt-outs stop shielding the recipient. Same shared core
//    the set_contact_reply_mode suppress path uses.
// ---------------------------------------------------------------------------
if (REPLY_MODE === "suppress") {
  // The shared core cancels at most 25 runs per call (goal-jump parity
  // bound), so DRAIN it until a pass cancels nothing, then verify zero
  // pending matches remain, only that proves it is safe to clear opt-outs.
  let totalCanceled = 0;
  for (let pass = 0; pass < 40; pass++) {
    const cancelResult = await cancelPendingRunsForLead(
      db as never,
      BUSINESS_ID,
      identitySet,
      "owner_stopped_texting"
    );
    totalCanceled += cancelResult.canceledRuns;
    if (!cancelResult.sweepComplete) {
      console.error(
        "[oneshot] ABORT: run sweep hit an error, opt-outs left in place so nothing can send. Re-run."
      );
      process.exit(1);
    }
    if (cancelResult.canceledRuns === 0) break;
  }
  const pendingOr = identitySet
    .flatMap((n) => [
      `context->trigger->>from.eq.${n}`,
      `context->vars->>lead_phone.eq.${n}`,
      `context->waiting_reply->>from.eq.${n}`,
      `context->waiting_call->>to.eq.${n}`
    ])
    .join(",");
  const { count: remaining, error: remErr } = await db
    .from("ai_flow_runs")
    .select("id", { count: "exact", head: true })
    .eq("business_id", BUSINESS_ID)
    .in("status", [...LEAD_STOPPABLE_STATUSES])
    .or(pendingOr);
  if (remErr || (remaining ?? 0) > 0) {
    console.error(
      `[oneshot] ABORT: ${remErr ? `verification failed: ${remErr.message}` : `${remaining} pending run(s) still match`}, opt-outs left in place. Re-run.`
    );
    process.exit(1);
  }
  console.log(`[oneshot] pending runs: ${totalCanceled} canceled, 0 remaining (verified)`);
}

// ---------------------------------------------------------------------------
// 3. Contact cleanup: drop the spam tag + spam-declaration note lines.
// ---------------------------------------------------------------------------
if (contact) {
  const tags: string[] = Array.isArray(contact.tags) ? (contact.tags as string[]) : [];
  const pinned = typeof contact.pinned_md === "string" ? contact.pinned_md : "";
  const keptPinned = pinned
    .split("\n")
    .filter((line) => !line.includes(SPAM_NOTE_MARKER))
    .join("\n")
    .trim();
  const updates: Record<string, unknown> = {
    tags: tags.filter((t) => t !== SPAM_TAG),
    pinned_md: keptPinned.length > 0 ? keptPinned : null,
    updated_at: new Date().toISOString()
  };
  const { error: updErr } = await db.from("contacts").update(updates).eq("id", contact.id);
  if (updErr) {
    console.error("[oneshot] contact update failed:", updErr.message);
    process.exit(1);
  }
  console.log("[oneshot] contact updated: spam tag removed, spam note lines removed");
} else {
  console.log("[oneshot] no contact row existed, nothing to clean (mode row created above)");
}

// ---------------------------------------------------------------------------
// 4. Clear the suppression rows LAST (every identity number), only after
//    the reply mode and run cancels guarantee nothing is waiting to send.
// ---------------------------------------------------------------------------
if (optRows.length > 0) {
  for (const row of optRows) {
    const { data: cleared, error: clearErr } = await db.rpc("sms_clear_opt_out", {
      p_business_id: BUSINESS_ID,
      p_sender_e164: row.sender_e164
    });
    if (clearErr) {
      console.error(`[oneshot] sms_clear_opt_out failed for ${row.sender_e164}:`, clearErr.message);
      process.exit(1);
    }
    console.log(`[oneshot] opt-out cleared for ${row.sender_e164}: ${JSON.stringify(cleared)}`);
  }
} else {
  console.log("[oneshot] no opt-out rows, nothing to clear");
}

await recordOneshotApplied(db, {
  scriptPath: process.argv[1],
  businessId: BUSINESS_ID,
  details: {
    phone: PHONE,
    identity_set: identitySet,
    cleared_opt_outs: optRows.map((r) => r.sender_e164),
    reply_mode: REPLY_MODE
  }
});
console.log("[oneshot] applied.");

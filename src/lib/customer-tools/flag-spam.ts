/**
 * flag_contact_spam core — the machinery behind "he's spam".
 *
 * KYP Ads, Jul 23 2026: James texted "hes spam" about a junk Facebook lead
 * and the owner-operator turn REPLIED "I'll flag Hhh as spam and stop all
 * follow-ups" — but no tool on any owner surface could do either, so the
 * lead's follow-up run stayed parked with three nudges ahead of it. This
 * module makes the promise real. Shared by the inline dashboard-chat path
 * and the owner-SMS operator turn (both owner-verified surfaces; dashboard
 * chat additionally requires the caller's manage_settings role — the same
 * bar as /api/dashboard/sms-optouts); it is deliberately NOT seeded to the
 * Rowboat agents — the customer-facing texting coworker must never hold an
 * irreversible suppression tool (see the DASHBOARD_NAME_MAP exemption in
 * tests/agent-tool-seed-parity.test.ts).
 *
 * Everything operates on the lead's FULL identity set — the number the
 * owner gave, the matched contact's canonical customer_e164, and every
 * merged alias — since flows may hold runs (and send texts) under a
 * different number than the one the owner quoted. What a flag does:
 *
 *   1. `sms_set_opt_out` for the given number — the same STOP-list every
 *      send path already enforces (ai-flow-worker, sms-inbound-worker,
 *      scheduled sends, the Node send sites). This is the load-bearing
 *      step: if it fails, the whole call reports failure. Irreversible
 *      from chat by design — only the contact texting START lifts it.
 *      The rest of the identity set is then suppressed best-effort.
 *   2. Cancel every pending AiFlow run for the lead across the identity
 *      set — every non-terminal state, `running` included (cooperative
 *      cancel, same set as the dashboard owner-stop) — with the owner-stop
 *      shape (`status: canceled` + `context.canceled` audit) so the runs
 *      page renders it natively. Best-effort AFTER the opt-out: even a
 *      missed cancel cannot text the lead (the worker re-checks the
 *      opt-out before every send).
 *   3. Tag the contact "spam" + append a pinned note (creating a minimal
 *      contact row when none exists). A contact already at the 25-tag cap
 *      (contacts_tags_cap_chk) gets the pinned note only — never a failed
 *      write after suppression already landed. Direct writes only —
 *      deliberately NO tag_changed contact-event hook, a spam declaration
 *      must never start MORE automation.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { setSmsOptOut } from "@/lib/sms/opt-outs";
import { normalizeDialableNumber } from "@/lib/telnyx/format";
import { logger } from "@/lib/logger";

/** Tag written to the contact row (also what segments/filters key on). */
export const SPAM_TAG = "spam";

/** `context.canceled.by` marker for a spam-flag cancel. */
export const SPAM_CANCELED_BY = "owner_declared_spam";

/** contacts_tags_cap_chk: a contact holds at most this many tags. */
const CONTACT_TAGS_CAP = 25;

/**
 * Every non-terminal run state — human-parked AND `running` included (spam
 * stops everything). Matches the dashboard owner-stop's
 * CANCELABLE_RUN_STATUSES: a `running` run cancels cooperatively, the
 * worker re-reads status at each step boundary and quits when it sees
 * canceled.
 */
export const SPAM_STOPPABLE_STATUSES = [
  "queued",
  "running",
  "awaiting_reply",
  "awaiting_call",
  "awaiting_approval",
  "awaiting_agent"
] as const;

/** Most runs one flag will cancel (same bound as the goal jumps). */
const MAX_RUNS_PER_FLAG = 25;

export type FlagContactSpamArgs = {
  /** The number to suppress, as the owner gave it (forgiving formats). */
  phone: string;
  /** Optional owner-stated reason, recorded on the pinned note. */
  reason?: string;
};

/** How the contact row ended up marked. */
export type SpamContactOutcome = "tagged" | "note_only" | "failed";

export type FlagContactSpamResult =
  | {
      ok: true;
      phoneE164: string;
      /** Every number suppression covered (given + canonical + aliases). */
      identitySet: string[];
      optedOut: true;
      /** False = an alias opt-out failed (the given number IS suppressed). */
      suppressionComplete: boolean;
      canceledRuns: number;
      /** False = the run sweep hit an error (sends stay blocked regardless). */
      runsSweepComplete: boolean;
      /** "note_only" = the contact is at the tag cap; note written instead. */
      contactOutcome: SpamContactOutcome;
      contactTagged: boolean;
      note: string;
    }
  | { ok: false; message: string };

export type FlagContactSpamDeps = {
  /** Injectable client factory (tests). */
  createDb?: typeof createSupabaseServiceClient;
  /** Injectable opt-out write (tests). */
  setOptOut?: typeof setSmsOptOut;
};

type PendingRun = {
  id: string;
  status: string;
  context: Record<string, unknown> | null;
  revision: number;
};

type ContactRow = {
  id: string;
  customer_e164: unknown;
  alias_e164s: unknown;
  tags: unknown;
  pinned_md: unknown;
};

/**
 * Flag one lead as spam for a business. Never throws — the returned payload
 * is a Gemini functionResponse and must always be relayable.
 */
export async function flagContactSpam(
  businessId: string,
  args: FlagContactSpamArgs,
  deps: FlagContactSpamDeps = {}
): Promise<FlagContactSpamResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const createDb = deps.createDb ?? createSupabaseServiceClient;
  const setOptOut = deps.setOptOut ?? setSmsOptOut;
  /* c8 ignore stop */

  const normalized = normalizeDialableNumber(args.phone);
  if (!normalized.ok) {
    return {
      ok: false,
      message: `invalid_phone, ${normalized.reason}. Ask the owner for the exact number to flag.`
    };
  }
  const phoneE164 = normalized.value;

  // 1. Suppression of the given number — load-bearing, fails the whole call
  // honestly.
  try {
    await setOptOut(businessId, phoneE164);
  } catch (err) {
    logger.error("flag_contact_spam: opt-out write failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message:
        "spam_flag_failed, the number could NOT be suppressed. Nothing was changed; tell the owner honestly and suggest trying again."
    };
  }

  // From here on the suppression is ACTIVE, so any unexpected blow-up
  // degrades to an honest partial result — never a throw, never a false
  // "nothing happened".
  let identitySet = [phoneE164];
  let suppressionComplete = true;
  let canceledRuns = 0;
  let runsSweepComplete = true;
  let contactOutcome: SpamContactOutcome = "failed";
  try {
    const db = await createDb();

    // Resolve the contact by the primary number OR a merged alias — the
    // same resolution the interaction writes use, so a merged contact
    // still gets tagged instead of silently skipped.
    let contact: ContactRow | null = null;
    const { data: contactRows, error: readErr } = await db
      .from("contacts")
      .select("id, customer_e164, alias_e164s, tags, pinned_md")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${phoneE164},alias_e164s.cs.{${phoneE164}}`)
      .limit(1);
    if (readErr) {
      logger.warn("flag_contact_spam: contact lookup failed (continuing on the given number)", {
        businessId,
        error: readErr.message
      });
    } else {
      contact = ((contactRows ?? []) as ContactRow[])[0] ?? null;
    }

    // The full identity set: flows may hold runs under the contact's
    // canonical number even when the owner quoted an alias (and vice
    // versa) — suppression and cancels must cover them all.
    identitySet = [
      ...new Set(
        [
          phoneE164,
          ...(typeof contact?.customer_e164 === "string" ? [contact.customer_e164] : []),
          ...(Array.isArray(contact?.alias_e164s) ? (contact.alias_e164s as string[]) : [])
        ].filter((n) => /^\+\d{8,15}$/.test(n))
      )
    ];
    for (const n of identitySet) {
      if (n === phoneE164) continue; // already suppressed above
      try {
        await setOptOut(businessId, n);
      } catch (err) {
        logger.error("flag_contact_spam: alias opt-out failed", {
          businessId,
          error: err instanceof Error ? err.message : String(err)
        });
        suppressionComplete = false;
      }
    }

    // 2. Cancel pending runs across the identity set (best-effort — the
    // opt-outs above already block sends). Same lead-identity keys the
    // goal jumps / stop-on-response use.
    const runMatchOr = identitySet
      .flatMap((n) => [
        `context->trigger->>from.eq.${n}`,
        `context->vars->>lead_phone.eq.${n}`,
        `context->waiting_reply->>from.eq.${n}`,
        `context->waiting_call->>to.eq.${n}`
      ])
      .join(",");
    const { data: runRows, error: runsErr } = await db
      .from("ai_flow_runs")
      .select("id, status, context, revision")
      .eq("business_id", businessId)
      .in("status", [...SPAM_STOPPABLE_STATUSES])
      .or(runMatchOr)
      .limit(MAX_RUNS_PER_FLAG);
    if (runsErr) {
      logger.error("flag_contact_spam: pending-run lookup failed", {
        businessId,
        error: runsErr.message
      });
      runsSweepComplete = false;
    } else {
      for (const run of (runRows ?? []) as PendingRun[]) {
        const nextContext = {
          ...(run.context ?? {}),
          canceled: {
            by: SPAM_CANCELED_BY,
            at: new Date().toISOString(),
            from_status: run.status
          }
        };
        // Optimistic concurrency, same shape as stop-on-response: gate on the
        // revision we read so a concurrent claim/resume wins cleanly (the
        // opt-out still blocks whatever that run tries to send).
        const { data: updated, error: updErr } = await db
          .from("ai_flow_runs")
          .update({
            status: "canceled",
            context: nextContext,
            claimed_at: null,
            respond_by_at: null,
            updated_at: new Date().toISOString()
          })
          .eq("id", run.id)
          .eq("revision", run.revision)
          .in("status", [...SPAM_STOPPABLE_STATUSES])
          .select("id");
        if (updErr) {
          logger.error("flag_contact_spam: run cancel failed", {
            businessId,
            runId: run.id,
            error: updErr.message
          });
          runsSweepComplete = false;
          continue;
        }
        if (((updated ?? []) as unknown[]).length > 0) canceledRuns += 1;
      }
    }

    // 3. Contact tag + pinned note (best-effort; direct writes, no hooks).
    contactOutcome = await tagContactSpam(db, businessId, phoneE164, contact, args.reason);
  } catch (err) {
    logger.error("flag_contact_spam: cleanup failed after suppression", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    runsSweepComplete = false;
  }

  // The note must mirror what ACTUALLY happened — the model relays it
  // verbatim, and an owner told "tagged spam" when the tag write failed is
  // exactly the dishonesty this tool exists to end.
  const noteParts = [
    suppressionComplete
      ? `this number is now blocked from all texting${identitySet.length > 1 ? ` (their ${identitySet.length - 1} linked number(s) too)` : ""}`
      : "this number is now blocked from all texting, but one of their linked numbers could not be confirmed as blocked — flag it separately to be safe",
    runsSweepComplete
      ? `${canceledRuns} pending automation run(s) were stopped`
      : "some of their pending automation runs could not be confirmed as stopped (they may still show active on the dashboard, but any text they attempt to this number will be skipped)",
    contactOutcome === "tagged"
      ? "the contact is tagged spam"
      : contactOutcome === "note_only"
        ? "the contact is at its tag limit, so a pinned note records the spam declaration instead of a tag"
        : "tagging the contact record failed, so the dashboard may not show a spam tag"
  ];
  return {
    ok: true,
    phoneE164,
    identitySet,
    optedOut: true,
    suppressionComplete,
    canceledRuns,
    runsSweepComplete,
    contactOutcome,
    contactTagged: contactOutcome === "tagged",
    note:
      `Tell the owner: ${noteParts.join("; ")}. ` +
      "The block cannot be undone from chat (only the contact texting START lifts it)."
  };
}

/**
 * Tag the (already-resolved) contact row `spam` and append a pinned note,
 * creating a minimal row when none exists so the flag is visible in the
 * dashboard. A contact at the tag cap gets the note only ("note_only") —
 * never a doomed write.
 */
async function tagContactSpam(
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>,
  businessId: string,
  phoneE164: string,
  contact: ContactRow | null,
  reason: string | undefined
): Promise<SpamContactOutcome> {
  const noteLine =
    `Owner declared this contact SPAM (${new Date().toISOString().slice(0, 10)}). ` +
    `Do not contact; all follow-ups stopped.${reason?.trim() ? ` Reason: ${reason.trim()}` : ""}`;
  try {
    if (!contact) {
      const { error: insErr } = await db.from("contacts").insert({
        business_id: businessId,
        customer_e164: phoneE164,
        tags: [SPAM_TAG],
        pinned_md: `- ${noteLine}`
      });
      if (insErr) throw new Error(insErr.message);
      return "tagged";
    }

    const tags: string[] = Array.isArray(contact.tags) ? [...(contact.tags as string[])] : [];
    const pinned = typeof contact.pinned_md === "string" ? contact.pinned_md : "";
    const atCap = !tags.includes(SPAM_TAG) && tags.length >= CONTACT_TAGS_CAP;
    const updates: Record<string, unknown> = {};
    if (!tags.includes(SPAM_TAG) && !atCap) updates.tags = [...tags, SPAM_TAG];
    // One spam note is enough — a re-flag must not stack duplicates.
    if (!pinned.includes("SPAM")) {
      updates.pinned_md = pinned ? `${pinned.trimEnd()}\n- ${noteLine}` : `- ${noteLine}`;
    }
    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: updErr } = await db
        .from("contacts")
        .update(updates)
        .eq("id", contact.id as string);
      if (updErr) throw new Error(updErr.message);
    }
    return atCap ? "note_only" : "tagged";
  } catch (err) {
    logger.warn("flag_contact_spam: contact tag failed (suppression still active)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return "failed";
  }
}

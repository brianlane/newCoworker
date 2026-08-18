/**
 * set_contact_reply_mode core — the machinery behind "stop texting Chris".
 *
 * KYP Ads, Jul 24 2026 (Chris Gregoris incident): James texted "stop
 * texting chris please" about a hot lead who was waiting on a personal
 * call. The only tool that could stop follow-ups was flag_contact_spam, so
 * the model used it — an IRREVERSIBLE STOP-list block plus a spam tag on a
 * real customer. The correct primitive existed all along:
 * `contacts.sms_reply_mode='suppress'` (built after the realtor.com
 * bot-loop incident precisely because sms_opt_outs was too blunt). This
 * module exposes it to the owner surfaces.
 *
 * What "suppress" does: the coworker stops auto-replying to this contact's
 * texts, and their pending automation runs are canceled (shared core with
 * the spam flag, `owner_stopped_texting` audit marker). Inbound texts are
 * still received and logged, manual sends from the dashboard still work,
 * and calls are unaffected. Fully reversible: mode "auto" turns the
 * coworker back on. NO opt-out row, NO spam tag — this is thread
 * management, not a block.
 *
 * Same surface posture as flag_contact_spam: inline-only (dashboard chat +
 * owner-SMS operator turn), never seeded to the Rowboat agents. Gated by
 * its own Settings toggle at the operate_messages bar — the same
 * permission the dashboard thread's reply-mode control requires — so no
 * manage_settings requirement (unlike the irreversible spam flag).
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { setContactSmsReplyMode } from "@/lib/customer-memory/db";
import { normalizeDialableNumber } from "@/lib/telnyx/format";
import { cancelPendingRunsForLead } from "./cancel-lead-runs";
import { logger } from "@/lib/logger";

/** `context.canceled.by` marker for a stop-texting cancel. */
export const TEXTING_STOPPED_CANCELED_BY = "owner_stopped_texting";

/**
 * Drain bound for the 25-runs-per-call cancel core: 8 × 25 = 200 pending
 * runs, far beyond any real lead. Exhausting it reports an incomplete sweep.
 */
const MAX_CANCEL_DRAIN_PASSES = 8;

export type ContactTextingMode = "suppress" | "auto";

export type SetContactReplyModeArgs = {
  /** The contact's number, as the owner gave it (forgiving formats). */
  phone: string;
  /** "suppress" = stop texting them; "auto" = resume normal replies. */
  mode: ContactTextingMode;
};

export type SetContactReplyModeResult =
  | {
      ok: true;
      phoneE164: string;
      mode: ContactTextingMode;
      canceledRuns: number;
      /** False = the run sweep hit an error (the mode write DID land). */
      runsSweepComplete: boolean;
      note: string;
    }
  | { ok: false; message: string };

export type SetContactReplyModeDeps = {
  /** Injectable client factory (tests). */
  createDb?: typeof createSupabaseServiceClient;
  /** Injectable mode write (tests). */
  setReplyMode?: typeof setContactSmsReplyMode;
  /** Injectable run-cancel core (tests). */
  cancelRuns?: typeof cancelPendingRunsForLead;
};

type ContactNumbersRow = {
  customer_e164: unknown;
  alias_e164s: unknown;
};

/**
 * Set one contact's texting mode for a business. Never throws — the
 * returned payload is a Gemini functionResponse and must always be
 * relayable.
 */
export async function setContactTextingMode(
  businessId: string,
  args: SetContactReplyModeArgs,
  deps: SetContactReplyModeDeps = {}
): Promise<SetContactReplyModeResult> {
  /* c8 ignore start -- production defaults; tests inject */
  const createDb = deps.createDb ?? createSupabaseServiceClient;
  const setReplyMode = deps.setReplyMode ?? setContactSmsReplyMode;
  const cancelRuns = deps.cancelRuns ?? cancelPendingRunsForLead;
  /* c8 ignore stop */

  const normalized = normalizeDialableNumber(args.phone);
  if (!normalized.ok) {
    return {
      ok: false,
      message: `invalid_phone, ${normalized.reason}. Ask the owner for the exact number.`
    };
  }
  const phoneE164 = normalized.value;

  // 1. The mode write — load-bearing, fails the whole call honestly. Alias-
  // aware and creates a minimal contact row when none exists (same helper
  // the dashboard thread toggle uses).
  try {
    await setReplyMode(businessId, phoneE164, args.mode);
  } catch (err) {
    logger.error("set_contact_reply_mode: mode write failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return {
      ok: false,
      message:
        "reply_mode_failed, the change could NOT be saved. Nothing was changed; tell the owner honestly and suggest trying again."
    };
  }

  // 2. On suppress, also stop their pending automation runs — "stop texting
  // them" means the scheduled nudges too, not just default replies.
  // Best-effort AFTER the mode write; a missed cancel leaves a run that can
  // still send its authored texts, which the note reports honestly.
  let canceledRuns = 0;
  let runsSweepComplete = true;
  if (args.mode === "suppress") {
    try {
      const db = await createDb();
      // Cover the identity set (canonical + merged aliases), same as the
      // spam flag — flows may hold runs under a different number than the
      // one the owner quoted.
      let identitySet = [phoneE164];
      const { data: contactRows, error: readErr } = await db
        .from("contacts")
        .select("customer_e164, alias_e164s")
        .eq("business_id", businessId)
        .or(`customer_e164.eq.${phoneE164},alias_e164s.cs.{${phoneE164}}`)
        .limit(1);
      if (readErr) {
        logger.warn("set_contact_reply_mode: contact lookup failed (continuing on the given number)", {
          businessId,
          error: readErr.message
        });
      } else {
        const contact = ((contactRows ?? []) as ContactNumbersRow[])[0] ?? null;
        identitySet = [
          ...new Set(
            [
              phoneE164,
              ...(typeof contact?.customer_e164 === "string" ? [contact.customer_e164] : []),
              ...(Array.isArray(contact?.alias_e164s) ? (contact.alias_e164s as string[]) : [])
            ].filter((n) => /^\+\d{8,15}$/.test(n))
          )
        ];
      }
      // DRAIN the cancel core: it cancels at most 25 runs per call (the
      // goal-jump parity bound), and unlike the spam flag there is no
      // opt-out backstop here — suppress does not block AiFlow outbound
      // steps, so every pending run must actually be canceled. Loop until
      // a pass cancels nothing; hitting the pass cap reports an incomplete
      // sweep instead of a false "all stopped" (Bugbot Medium, PR #898).
      for (let pass = 0; ; pass++) {
        if (pass >= MAX_CANCEL_DRAIN_PASSES) {
          runsSweepComplete = false;
          break;
        }
        const cancelResult = await cancelRuns(
          db,
          businessId,
          identitySet,
          TEXTING_STOPPED_CANCELED_BY
        );
        canceledRuns += cancelResult.canceledRuns;
        if (!cancelResult.sweepComplete) {
          runsSweepComplete = false;
          break;
        }
        if (cancelResult.canceledRuns === 0) break;
      }
    } catch (err) {
      logger.error("set_contact_reply_mode: run cancel failed after mode write", {
        businessId,
        error: err instanceof Error ? err.message : String(err)
      });
      runsSweepComplete = false;
    }
  }

  // The note mirrors what actually happened — the model relays it verbatim.
  const note =
    args.mode === "suppress"
      ? `Tell the owner: the coworker will no longer text this contact (no auto-replies), ` +
        (runsSweepComplete
          ? `${canceledRuns} pending automation run(s) for them were stopped. `
          : "but some of their pending automation runs could not be confirmed as stopped, those may still send their scheduled texts. ") +
        "Their inbound texts are still received, manual texts from the dashboard still work, and this is reversible (ask to resume texting them)."
      : "Tell the owner: the coworker will reply to this contact again (normal automatic replies are back on).";

  return {
    ok: true,
    phoneE164,
    mode: args.mode,
    canceledRuns,
    runsSweepComplete,
    note
  };
}

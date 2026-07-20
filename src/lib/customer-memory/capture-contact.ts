/**
 * Captured-lead → contact promotion, shared by the lead-capture tools
 * (voice `capture_caller_details`, webchat/messenger/whatsapp capture-lead).
 *
 * Historically those tools only wrote `coworker_logs` (plus a counters-only
 * rollup on some surfaces), so a brand-new lead never counted as a contact
 * CREATION as far as AiFlows were concerned — `contact_created` flows fired
 * for dashboard adds, CSV imports, and the `upsert_customer` worker step,
 * but never for the highest-signal source: a real caller/visitor the AI just
 * talked to. This module closes that gap with the worker step's exact shape:
 *
 *   1. alias-aware existence pre-check (was this lead already a contact?),
 *   2. rollup via `record_customer_interaction` (creates or bumps — the same
 *      write the capture surfaces already did),
 *   3. best-effort email link (fills an empty email, never clobbers),
 *   4. `contact_created` fires ONLY when this capture created the row.
 *
 * Everything is best-effort and never throws: the capture's `coworker_logs`
 * row is already durably written by the caller, and a CRM/trigger failure
 * must never break a live call or chat turn.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  linkCustomerEmail,
  recordInteractionAndIncrement
} from "@/lib/customer-memory/db";
import type { CustomerMemoryChannel } from "@/lib/customer-memory/types";
import { fireContactEvent } from "@/lib/ai-flows/contact-event-hooks";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type CapturedContactInput = {
  /** Normalized E.164 — callers coerce/validate before calling. */
  e164: string;
  name?: string | null;
  email?: string | null;
  /** Which surface captured the lead (becomes `contacts.last_channel`). */
  channel: CustomerMemoryChannel;
};

export type CapturedContactResult = {
  /** True when THIS capture created the contact row (and the event fired). */
  created: boolean;
};

const errText = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

/**
 * Ensure the captured lead exists as a contact and fire `contact_created`
 * when this capture created it. Never throws.
 */
export async function ensureCapturedContact(
  businessId: string,
  input: CapturedContactInput,
  client?: SupabaseClient
): Promise<CapturedContactResult> {
  let db: SupabaseClient;
  try {
    db = client ?? (await createSupabaseServiceClient());
  } catch (err) {
    logger.warn("capture-contact: service client unavailable", {
      businessId,
      error: errText(err)
    });
    return { created: false };
  }

  // Existence pre-check, alias-aware (a merged-away number lives in
  // alias_e164s on the surviving row). A read failure means we can't tell —
  // fail safe by treating the contact as pre-existing so a transient error
  // can never fire contact_created for an old contact (mirrors the worker's
  // upsert_customer step). E.164 is strictly `+digits`, safe in the filter.
  let existedBefore = true;
  try {
    const { data, error } = await db
      .from("contacts")
      .select("id")
      .eq("business_id", businessId)
      .or(`customer_e164.eq.${input.e164},alias_e164s.cs.{${input.e164}}`)
      .maybeSingle();
    if (!error) existedBefore = data != null;
  } catch (err) {
    logger.warn("capture-contact: existence pre-check failed", {
      businessId,
      error: errText(err)
    });
  }

  const name = input.name?.trim() || null;
  const email = input.email?.trim() || null;

  // Create-or-bump: the same rollup the capture surfaces already performed.
  // A failure here means the row may not exist, so the event below is
  // skipped rather than fired for a phantom contact.
  let rolledUp = false;
  try {
    await recordInteractionAndIncrement(
      businessId,
      input.e164,
      input.channel,
      { displayName: name },
      db
    );
    rolledUp = true;
  } catch (err) {
    logger.warn("capture-contact: rollup failed", {
      businessId,
      channel: input.channel,
      error: errText(err)
    });
  }

  // Email link: future inbound mail from this address rolls up to the same
  // phone-keyed profile. Independent of the rollup outcome — the link helper
  // creates a minimal profile itself when needed and never clobbers an
  // owner-set address.
  if (email) {
    try {
      await linkCustomerEmail(businessId, input.e164, email, db);
    } catch (err) {
      logger.warn("capture-contact: linkCustomerEmail failed", {
        businessId,
        error: errText(err)
      });
    }
  }

  if (existedBefore || !rolledUp) return { created: false };

  // contact_created triggers: a lead the AI just captured may start flows
  // watching for new contacts (the demo-caller / web-lead follow-ups).
  // Timestamped dedupe like the dashboard add: a deleted-then-recaptured
  // number is a NEW creation that must refire. Best-effort inside
  // fireContactEvent — a trigger failure never fails the capture.
  await fireContactEvent(businessId, {
    kind: "contact_created",
    contact: {
      e164: input.e164,
      ...(name ? { name } : {}),
      ...(email ? { email } : {})
    },
    dedupeKey: `ce:created:${input.e164}:${Date.now()}`
  });
  return { created: true };
}

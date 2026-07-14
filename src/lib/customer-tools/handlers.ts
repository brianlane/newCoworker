/**
 * Channel-agnostic cores for the customer-memory tools
 * (`customer_lookup_by_phone`, `customer_set_display_name`,
 * `customer_append_pinned_note`).
 *
 * Two callers share these:
 *   - the /api/voice/tools/* adapters (Gemini Live voice bridge), and
 *   - /api/rowboat/tool-call (the per-tenant Rowboat project's tool
 *     webhook, used by the texting + dashboard coworkers).
 *
 * Keeping the subtle behaviours (owner-name no-clobber, pinned_md cap +
 * oldest-first truncation, force-create-on-missing-row) in one place so the
 * surfaces can't drift apart. All functions return the raw `{ ok, detail?,
 * data? }` tool-result shape; transport-level concerns (auth, arg schemas,
 * HTTP envelopes) stay with the callers.
 */

import {
  getCustomerMemory,
  recordInteractionAndIncrement,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { summarizeCustomerMemoryAndLog } from "@/lib/customer-memory/summarizer";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { loadContactTimeline } from "../../../supabase/functions/_shared/contact_context";

export type CustomerToolResult = {
  ok: boolean;
  detail?: string;
  data?: unknown;
};

export type CustomerToolChannel = "voice" | "sms" | "dashboard";

export const E164_RE = /^\+[1-9]\d{6,15}$/;

/** Hard cap on persisted pinned_md. MUST match the dashboard editor's
 * own cap (`src/components/dashboard/CustomerProfileEditor.tsx`
 * PINNED_MAX = 2000) AND the PATCH validator
 * (`src/app/api/dashboard/customers/[customerE164]/route.ts`
 * `pinnedMd: z.string().max(2000)`). If a tool wrote past the dashboard
 * cap, the owner would be unable to save edits to the same field through
 * the dashboard (PATCH `.max()` rejects), making the field effectively
 * read-only after a long enough pin sequence. Keep all three numbers in
 * lockstep. */
export const PINNED_MAX_CHARS = 2000;

/**
 * `customer_lookup_by_phone` core. A malformed phone reports `found:false`
 * rather than erroring — Telnyx has been observed to deliver "anonymous" /
 * "" / "unknown" as the caller id in spotty CNAM cases, and the model
 * should just treat those as "nobody on file".
 *
 * `recentInteractions` is the cross-channel raw timeline (SMS both
 * directions + recent call summaries, contact_context.ts): mid-first-
 * conversation the rolling `summary` is still empty — the summarize sweep
 * runs later — so without it a lookup told the agent NOTHING about an
 * exchange that happened minutes ago (the 2026-07-14 Truly incident
 * class). Best-effort: a timeline failure degrades to the pre-existing
 * summary-only shape, never a failed lookup.
 */
export async function lookupCustomerByPhone(
  businessId: string,
  phone: string
): Promise<CustomerToolResult> {
  if (!E164_RE.test(phone)) {
    return { ok: true, data: { found: false } };
  }
  const memory = await getCustomerMemory(businessId, phone);
  if (!memory) {
    return { ok: true, data: { found: false } };
  }
  let recentInteractions: string | null = null;
  try {
    const db = await createSupabaseServiceClient();
    // The surviving profile number may differ from the queried alias —
    // the timeline tables key on the number messages actually flowed over,
    // so query with the caller's phone AND fall back to the primary.
    recentInteractions =
      (await loadContactTimeline(db, businessId, phone)) ??
      (phone === memory.customer_e164
        ? null
        : await loadContactTimeline(db, businessId, memory.customer_e164));
  } catch (e) {
    console.error("lookupCustomerByPhone: timeline load failed", e);
  }
  return {
    ok: true,
    data: {
      found: true,
      customer: {
        displayName: memory.display_name,
        customerE164: memory.customer_e164,
        // Customer-safe summary only — owner notes (pinned_md) stay
        // server-side; the agent uses them for steering but doesn't
        // read them back to the customer.
        summary: memory.summary_md,
        lastChannel: memory.last_channel,
        lastInteractionAt: memory.last_interaction_at,
        totalInteractionCount: memory.total_interaction_count,
        ...(recentInteractions ? { recentInteractions } : {})
      }
    }
  };
}

/**
 * `customer_set_display_name` core. Customer surfaces (voice/SMS) never
 * overwrite a name that is already set — agent-discovered names only land
 * when display_name is currently null/empty. The DASHBOARD surface is the
 * owner speaking, so there a rename IS authoritative: it overwrites,
 * stamps name_source='manual' (same provenance as a contacts-UI edit), and
 * force-regenerates the rolling summary so the old name doesn't linger in
 * summary_md (observed live: the coworker kept calling a renamed lead by
 * the summary's stale full name). Force-creates the customer row via the
 * inbound-path RPC when missing so the write always persists.
 */
export async function setCustomerDisplayName(
  businessId: string,
  phone: string,
  displayName: string,
  channel: CustomerToolChannel
): Promise<CustomerToolResult> {
  let existing = await getCustomerMemory(businessId, phone);
  if (!existing) {
    await recordInteractionAndIncrement(businessId, phone, channel, {
      displayName
    });
    existing = await getCustomerMemory(businessId, phone);
  }
  // Re-check after the create above: the RPC's `p_display_name` will have
  // already populated display_name on a brand-new row, in which case no
  // follow-up UPDATE is needed.
  const current = existing?.display_name?.trim() ?? "";
  if (current) {
    if (current === displayName) {
      return { ok: true, data: { updated: false, reason: "name_already_set_matches" } };
    }
    if (channel !== "dashboard") {
      return { ok: true, data: { updated: false, reason: "name_already_set" } };
    }
    await updateCustomerOwnerFields(businessId, phone, {
      displayName,
      nameSource: "manual"
    });
    // Fire-and-forget: regenerate summary_md so the old name is corrected at
    // its source, not just on the contact row. `force` bypasses the
    // threshold/debounce gates (a rename adds no interaction, so the normal
    // gate would skip). A failure only delays the correction to the next
    // interaction's summarizer run.
    void summarizeCustomerMemoryAndLog(businessId, phone, {}, { force: true });
    return { ok: true, data: { updated: true, previous: current } };
  }
  await updateCustomerOwnerFields(businessId, phone, { displayName });
  return { ok: true, data: { updated: true } };
}

/**
 * `customer_append_pinned_note` core. Appends a date-stamped line to
 * pinned_md, truncating oldest-first when the cap is exceeded. Refuses a
 * single note that alone exceeds the cap (`note_too_long`) — better the
 * agent re-summarize than crowd out everything else.
 *
 * `stampLabel` names the originating surface in the persisted line, e.g.
 * "voice" → "[2026-06-10 via voice]".
 */
export async function appendCustomerPinnedNote(
  businessId: string,
  phone: string,
  note: string,
  channel: CustomerToolChannel,
  stampLabel: string
): Promise<CustomerToolResult> {
  const stamp = `[${new Date().toISOString().slice(0, 10)} via ${stampLabel}]`;
  const newLine = `${stamp} ${note}`;
  if (newLine.length > PINNED_MAX_CHARS) {
    return { ok: false, detail: "note_too_long" };
  }
  let existing = await getCustomerMemory(businessId, phone);
  if (!existing) {
    await recordInteractionAndIncrement(businessId, phone, channel, {});
    existing = await getCustomerMemory(businessId, phone);
  }
  const prior = existing?.pinned_md?.trim() ?? "";
  // `wanted` is what we WOULD write ignoring the cap; `combined` is what we
  // persist. Comparing the two keeps `truncated` honest even on the very
  // first note (no separator case).
  const wanted = prior ? `${prior}\n\n${newLine}` : newLine;
  const combined =
    wanted.length > PINNED_MAX_CHARS ? wanted.slice(wanted.length - PINNED_MAX_CHARS) : wanted;
  await updateCustomerOwnerFields(businessId, phone, { pinnedMd: combined });
  return {
    ok: true,
    data: {
      appended: true,
      pinnedChars: combined.length,
      truncated: combined.length < wanted.length
    }
  };
}

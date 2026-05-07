/**
 * `customer_append_pinned_note` voice tool (Phase 5).
 *
 * The agent calls this when the caller (or owner via the call) shares
 * a fact worth persisting outside the rolling LLM summary —
 * e.g. "my wife is allergic to nuts", "we close at 4 every other
 * Friday", or anything else that should reach the next conversation
 * verbatim.
 *
 * Why pinned_md, not summary_md:
 *   - summary_md is auto-curated by the nightly summarizer and
 *     reflects the LLM's view of the customer at any moment. It
 *     gets regenerated; agent-pinned facts would otherwise drift
 *     away over time.
 *   - pinned_md is owner-controlled and survives every summarizer
 *     run. The dashboard customer page renders it above the
 *     rolling summary specifically because it's the "permanent
 *     record" channel.
 *
 * The owner can edit/delete pinned_md from the dashboard customer
 * detail page, so the agent has freedom to pin generously without
 * permanently polluting the record.
 *
 * Behaviour:
 *   - Appends with a per-call timestamped header so the owner can
 *     see when each note was added.
 *   - Hard caps the entire pinned_md at PINNED_MAX_CHARS (defaults
 *     well below the dashboard editor cap so an over-eager agent
 *     can't fill the field). Older notes get truncated from the
 *     bottom (oldest-first) when capacity is exceeded.
 *   - When the new note alone exceeds the cap, refuses with a
 *     "note_too_long" — better the agent re-summarize than commit
 *     a single note that crowds out everything else.
 */

import { z } from "zod";
import {
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import {
  getCustomerMemory,
  recordInteractionAndIncrement,
  updateCustomerOwnerFields
} from "@/lib/customer-memory/db";
import { logger } from "@/lib/logger";

/** Hard cap on persisted pinned_md. Sized below the dashboard editor's
 * own cap so the agent can't fill the field on its own — owner remains
 * authoritative. */
const PINNED_MAX_CHARS = 4000;

const argsSchema = z.object({
  /** The new note as the agent wants it persisted. ~600 chars typical, hard 1500 cap. */
  note: z.string().min(1).max(1500),
  /** Optional override; defaults to envelope.callerE164. */
  phone: z.string().regex(/^\+[1-9]\d{6,15}$/).optional()
});

export async function POST(request: Request) {
  const guard = gatewayGuard(request);
  if (guard) return guard;

  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }
  const phone = parsed.data.phone ?? envelope.callerE164;
  if (!phone || !/^\+[1-9]\d{6,15}$/.test(phone)) {
    return voiceToolValidationError("missing or invalid phone");
  }
  const note = parsed.data.note.trim();
  if (!note) {
    return voiceToolValidationError("note cannot be empty after trim");
  }
  // Stamp every agent-pinned line with the call control id so the
  // owner can audit/delete it later. ISO date is human-readable;
  // call_control_id makes it traceable to a specific transcript.
  const stamp = `[${new Date().toISOString().slice(0, 10)} via voice]`;
  const newLine = `${stamp} ${note}`;
  if (newLine.length > PINNED_MAX_CHARS) {
    return voiceToolResponse({ ok: false, detail: "note_too_long" });
  }

  try {
    let existing = await getCustomerMemory(envelope.businessId, phone);
    // No row yet for this customer? `updateCustomerOwnerFields` would
    // happily fire an UPDATE matching zero rows and we'd return
    // {appended:true} on a write that never persisted (Cursor Bugbot
    // Low on PR #74). Force-create the row via the same RPC the
    // inbound paths use so the agent's pin always lands.
    if (!existing) {
      await recordInteractionAndIncrement(envelope.businessId, phone, "voice", {});
      existing = await getCustomerMemory(envelope.businessId, phone);
    }
    const prior = existing?.pinned_md?.trim() ?? "";
    // Two distinct combinations to track:
    //  - `combined`     : what we'll persist (post-truncation).
    //  - `wantedLength` : what we WOULD have written had we ignored
    //                     the cap. Used to set `truncated` honestly —
    //                     the prior buggy version compared `prior +
    //                     separator + newLine` against `combined` even
    //                     when `prior` was empty (no separator added),
    //                     so the very first note always reported
    //                     truncated:true. Cursor Bugbot Low on PR #74.
    const wanted = prior ? `${prior}\n\n${newLine}` : newLine;
    const combined =
      wanted.length > PINNED_MAX_CHARS
        ? wanted.slice(wanted.length - PINNED_MAX_CHARS)
        : wanted;
    await updateCustomerOwnerFields(envelope.businessId, phone, {
      pinnedMd: combined
    });
    return voiceToolResponse({
      ok: true,
      data: {
        appended: true,
        pinnedChars: combined.length,
        truncated: combined.length < wanted.length
      }
    });
  } catch (err) {
    logger.warn("voice-tools/customer-append-pinned-note failed", {
      businessId: envelope.businessId,
      phone,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}

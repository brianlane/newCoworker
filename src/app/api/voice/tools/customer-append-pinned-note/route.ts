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
  agentToolDisabledResponse,
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { appendCustomerPinnedNote } from "@/lib/customer-tools/handlers";
import { logger } from "@/lib/logger";

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

  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "voice",
    "customer_append_pinned_note"
  );
  if (disabled) return disabled;

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

  try {
    // Shared core: date-stamps the line, force-creates the row when
    // missing, and truncates oldest-first at the pinned_md cap (see
    // src/lib/customer-tools/handlers.ts).
    return voiceToolResponse(
      await appendCustomerPinnedNote(envelope.businessId, phone, note, "voice", "voice")
    );
  } catch (err) {
    logger.warn("voice-tools/customer-append-pinned-note failed", {
      businessId: envelope.businessId,
      phone,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}

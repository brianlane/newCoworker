/**
 * `owner_append_business_memory` — persist business-wide rules from **owner
 * Dashboard chat** into `business_configs.memory_md` (Rowboat vault
 * `memory.md`), then fire-and-forget VPS vault sync.
 *
 * The dedupe/append/truncate semantics live in the shared helper
 * (src/lib/dashboard-chat/memory-append.ts) — also used directly by the
 * platform-inline chat turn's rule capture; this route remains the
 * gateway-authed adapter the VPS chat-worker calls.
 *
 * Security (primary): this tool is registered **only** on the Rowboat agent
 * `OwnerCoworker`. SMS uses `Coworker`, which does not list this tool, so
 * customers cannot invoke it even if the model hallucinated a call.
 *
 * Defense in depth: **refuse when `callerE164` is present** on the tool
 * envelope (voice/SMS-style tool calls that attribute a customer line).
 */

import { z } from "zod";
import {
  agentToolDisabledResponse,
  gatewayBusinessGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import {
  BULLETS_MAX_CHARS,
  appendOwnerMemoryBullets,
  normalizeBulletLines
} from "@/lib/dashboard-chat/memory-append";
import { logger } from "@/lib/logger";

// The vault re-seed (scheduleVaultSync → after()) runs post-response and SSHes
// into the tenant VPS. after() shares this single invocation budget, and
// syncVaultToVps alone allows a 60s SSH timeout plus Hostinger IP lookup + DB
// reads beforehand — so 60s would race the re-seed on a cold VPS. Budget well
// above the sync's own ceiling.
export const runtime = "nodejs";
export const maxDuration = 120;

const argsSchema = z.object({
  bullets: z.string().min(1).max(BULLETS_MAX_CHARS)
});

export async function POST(request: Request) {
  let envelope;
  try {
    envelope = await parseVoiceToolRequest(request);
  } catch (err) {
    return voiceToolValidationError(
      err instanceof z.ZodError ? err.issues[0]?.message ?? "invalid envelope" : "invalid body"
    );
  }

  const bindGuard = await gatewayBusinessGuard(request, envelope.businessId);
  if (bindGuard) return bindGuard;

  if ((envelope.callerE164 ?? "").trim() !== "") {
    return voiceToolResponse({ ok: false, detail: "owner_dashboard_only" });
  }

  // Settings → Coworker tools: owners can turn off automatic business-memory
  // capture for dashboard chat. Enforced here (the platform chokepoint every
  // capture write goes through) so a worker that predates the toggle can't
  // persist rules the owner opted out of.
  const disabled = await agentToolDisabledResponse(
    envelope.businessId,
    "dashboard",
    "memory_capture"
  );
  if (disabled) return disabled;

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }

  if (normalizeBulletLines(parsed.data.bullets).length === 0) {
    return voiceToolValidationError("bullets must contain at least one non-empty line");
  }

  try {
    const result = await appendOwnerMemoryBullets(envelope.businessId, parsed.data.bullets);

    logger.info(
      result.appended
        ? "voice-tools/owner-append-business-memory: appended"
        : "voice-tools/owner-append-business-memory: all duplicates, skipped",
      {
        businessId: envelope.businessId,
        bulletCount: result.savedBullets.length,
        skippedDuplicates: result.skippedDuplicates,
        memoryChars: result.memoryChars,
        truncated: result.truncated
      }
    );

    return voiceToolResponse({
      ok: true,
      data: {
        appended: result.appended,
        bulletCount: result.savedBullets.length,
        savedBullets: result.savedBullets,
        skippedDuplicates: result.skippedDuplicates,
        memoryChars: result.memoryChars,
        truncated: result.truncated
      }
    });
  } catch (err) {
    logger.warn("voice-tools/owner-append-business-memory failed", {
      businessId: envelope.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return voiceToolResponse({ ok: false, detail: "internal_error" }, 500);
  }
}

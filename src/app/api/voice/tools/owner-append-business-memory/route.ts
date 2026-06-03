/**
 * `owner_append_business_memory` — persist business-wide rules from **owner
 * Dashboard chat** into `business_configs.memory_md` (Rowboat vault
 * `memory.md`), then fire-and-forget VPS vault sync.
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
  gatewayGuard,
  parseVoiceToolRequest,
  voiceToolResponse,
  voiceToolValidationError
} from "@/lib/voice-tools/common";
import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";
import { logger } from "@/lib/logger";

// The vault re-seed (scheduleVaultSync → after()) runs post-response and SSHes
// into the tenant VPS (~5–15s, longer on a cold box). Give the invocation room
// so Vercel doesn't tear it down before the agent prompt is refreshed.
export const runtime = "nodejs";
export const maxDuration = 60;

/** Align with rough vault sizing; very large memory slows Rowboat prefill. */
const MEMORY_MD_MAX_CHARS = 14_000;

/** Single tool call: one or more newline-separated rules. */
const BULLETS_MAX_CHARS = 2_000;

const argsSchema = z.object({
  bullets: z.string().min(1).max(BULLETS_MAX_CHARS)
});

function normalizeBulletLines(raw: string): string[] {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^[-*]\s+/, ""))
    .filter(Boolean);
  return lines.slice(0, 25);
}

/**
 * Dedup key for a bullet/memory line: lowercased, list-marker- and
 * trailing-punctuation-stripped, whitespace-collapsed. Deliberately
 * conservative (exact-after-normalization) so we only ever drop genuine
 * re-sends of the same line, never a distinct fact that happens to look
 * similar.
 */
function dedupKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[-*•]\s+/, "")
    .replace(/[.;,\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dedup keys for the bullet lines already saved in memory_md. */
function existingMemoryKeys(memoryMd: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of memoryMd.split(/\r?\n/)) {
    if (/^\s*[-*•]\s+/.test(raw)) {
      const key = dedupKey(raw);
      if (key) keys.add(key);
    }
  }
  return keys;
}

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

  if ((envelope.callerE164 ?? "").trim() !== "") {
    return voiceToolResponse({ ok: false, detail: "owner_dashboard_only" });
  }

  const parsed = argsSchema.safeParse(envelope.args);
  if (!parsed.success) {
    return voiceToolValidationError(parsed.error.issues[0]?.message ?? "invalid args");
  }

  const bulletLines = normalizeBulletLines(parsed.data.bullets);
  if (bulletLines.length === 0) {
    return voiceToolValidationError("bullets must contain at least one non-empty line");
  }

  /** Append bullet lines under a dated heading; tail-truncate to the cap. */
  function buildNext(prior: string, lines: string[]): { next: string; wanted: string } {
    if (lines.length === 0) return { next: prior, wanted: prior };
    const dateStamp = new Date().toISOString().slice(0, 10);
    const block = ["", "---", "", `### Owner chat (${dateStamp})`, "", ...lines.map((b) => `- ${b}`)].join(
      "\n"
    );
    const wanted = prior ? `${prior}\n${block}` : block.trimStart();
    const next =
      wanted.length > MEMORY_MD_MAX_CHARS ? wanted.slice(wanted.length - MEMORY_MD_MAX_CHARS) : wanted;
    return { next, wanted };
  }

  try {
    const existing = await getBusinessConfig(envelope.businessId);
    const prior = existing?.memory_md?.trim() ?? "";

    // Collapse duplicates within this batch first.
    const batchKeys = new Set<string>();
    const distinct: { line: string; key: string }[] = [];
    for (const line of bulletLines) {
      const key = dedupKey(line);
      if (!key || batchKeys.has(key)) continue;
      batchKeys.add(key);
      distinct.push({ line, key });
    }

    // Brand-new lines (absent from prior) always get appended. "Restated" lines
    // already exist in prior, so normally we skip them to avoid double-saving.
    // BUT appending a block can tail-truncate memory and evict old lines from
    // the *head*; if a restated line's only copy would be truncated away, we
    // re-append it so the owner doesn't lose a rule they just confirmed.
    //
    // Estimate the truncation using the worst case (all distinct lines
    // appended): `overflow` chars are dropped from the front, so only the
    // retained tail of `prior` counts as "still present". A restated line whose
    // key isn't in that retained tail must be rescued. Over-estimating overflow
    // only ever rescues an extra line (a rare duplicate), never loses a rule.
    const priorKeys = existingMemoryKeys(prior);
    const brandNew = distinct.filter((d) => !priorKeys.has(d.key));
    const restated = distinct.filter((d) => priorKeys.has(d.key));

    const { wanted: maxWanted } = buildNext(prior, distinct.map((d) => d.line));
    const overflow = Math.min(prior.length, Math.max(0, maxWanted.length - MEMORY_MD_MAX_CHARS));
    const survivingPriorKeys = existingMemoryKeys(prior.slice(overflow));
    const rescued = restated.filter((d) => !survivingPriorKeys.has(d.key));

    const savedBullets = [...brandNew, ...rescued].map((d) => d.line);

    // Everything was already retained in memory — nothing to write. Report
    // success with appended:false + empty savedBullets so the caller renders no
    // (false) "saved" confirmation and we skip a redundant vault sync.
    if (savedBullets.length === 0) {
      logger.info("voice-tools/owner-append-business-memory: all duplicates, skipped", {
        businessId: envelope.businessId,
        incoming: bulletLines.length
      });
      return voiceToolResponse({
        ok: true,
        data: {
          appended: false,
          bulletCount: 0,
          savedBullets: [],
          skippedDuplicates: bulletLines.length,
          memoryChars: prior.length,
          truncated: false
        }
      });
    }

    const { next, wanted } = buildNext(prior, savedBullets);

    await patchBusinessConfig(envelope.businessId, { memory_md: next });
    scheduleVaultSync(envelope.businessId);

    logger.info("voice-tools/owner-append-business-memory: appended", {
      businessId: envelope.businessId,
      bulletCount: savedBullets.length,
      skippedDuplicates: bulletLines.length - savedBullets.length,
      memoryChars: next.length,
      truncated: next.length < wanted.length
    });

    return voiceToolResponse({
      ok: true,
      data: {
        appended: true,
        bulletCount: savedBullets.length,
        savedBullets,
        skippedDuplicates: bulletLines.length - savedBullets.length,
        memoryChars: next.length,
        truncated: next.length < wanted.length
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

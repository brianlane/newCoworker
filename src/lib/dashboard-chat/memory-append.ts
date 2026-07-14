/**
 * Owner business-memory append — the single write path for dashboard-chat
 * rule capture.
 *
 * Factored out of /api/voice/tools/owner-append-business-memory (which the
 * VPS chat-worker calls) so the platform-inline chat path can persist
 * captured rules through the exact same dedupe/append/truncate semantics
 * without an HTTP hop. Appends bullet lines under a dated "Owner chat"
 * heading in business_configs.memory_md, dedupes against what's already
 * saved (rescuing restated lines that truncation would otherwise evict),
 * tail-truncates to the memory cap, and schedules a VPS vault sync.
 */

import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";

/** Align with rough vault sizing; very large memory slows Rowboat prefill. */
export const MEMORY_MD_MAX_CHARS = 14_000;

/** Single capture: one or more newline-separated rules. */
export const BULLETS_MAX_CHARS = 2_000;

export function normalizeBulletLines(raw: string): string[] {
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
 * re-sends of the same line, never a distinct fact that looks similar.
 */
export function dedupKey(line: string): string {
  return line
    .toLowerCase()
    .replace(/^[-*•]\s+/, "")
    .replace(/[.;,\s]+$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dedup keys for the bullet lines already saved in memory_md. */
export function existingMemoryKeys(memoryMd: string): Set<string> {
  const keys = new Set<string>();
  for (const raw of memoryMd.split(/\r?\n/)) {
    if (/^\s*[-*•]\s+/.test(raw)) {
      const key = dedupKey(raw);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/** Append bullet lines under a dated heading; tail-truncate to the cap. */
export function buildNextMemory(
  prior: string,
  lines: string[],
  now: Date = new Date()
): { next: string; wanted: string } {
  if (lines.length === 0) return { next: prior, wanted: prior };
  const dateStamp = now.toISOString().slice(0, 10);
  const block = ["", "---", "", `### Owner chat (${dateStamp})`, "", ...lines.map((b) => `- ${b}`)].join(
    "\n"
  );
  const wanted = prior ? `${prior}\n${block}` : block.trimStart();
  const next =
    wanted.length > MEMORY_MD_MAX_CHARS ? wanted.slice(wanted.length - MEMORY_MD_MAX_CHARS) : wanted;
  return { next, wanted };
}

export type AppendMemoryDeps = {
  /** Injectable config IO (tests). */
  fetchConfig?: typeof getBusinessConfig;
  saveConfig?: typeof patchBusinessConfig;
  scheduleSync?: typeof scheduleVaultSync;
  now?: () => Date;
};

export type AppendMemoryResult = {
  appended: boolean;
  /** Lines actually written (post-dedupe) — what an honest confirmation may cite. */
  savedBullets: string[];
  skippedDuplicates: number;
  memoryChars: number;
  truncated: boolean;
};

/**
 * Persist bullet lines into the business memory. Same semantics as the
 * owner-append adapter route: within-batch dedupe, skip lines already
 * retained in memory, rescue restated lines whose only copy would be
 * tail-truncated away, then write + schedule the vault sync. Callers gate
 * authorization and the memory_capture tool toggle BEFORE calling.
 */
export async function appendOwnerMemoryBullets(
  businessId: string,
  bulletsRaw: string,
  deps: AppendMemoryDeps = {}
): Promise<AppendMemoryResult> {
  /* c8 ignore next 4 -- production defaults; tests inject */
  const fetchConfig = deps.fetchConfig ?? getBusinessConfig;
  const saveConfig = deps.saveConfig ?? patchBusinessConfig;
  const scheduleSync = deps.scheduleSync ?? scheduleVaultSync;
  const now = (deps.now ?? (() => new Date()))();

  const bulletLines = normalizeBulletLines(bulletsRaw.slice(0, BULLETS_MAX_CHARS));
  if (bulletLines.length === 0) {
    return {
      appended: false,
      savedBullets: [],
      skippedDuplicates: 0,
      memoryChars: 0,
      truncated: false
    };
  }

  const existing = await fetchConfig(businessId);
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

  // Brand-new lines (absent from prior) always get appended. "Restated"
  // lines already exist in prior, so normally we skip them — BUT appending
  // a block can tail-truncate memory and evict old lines from the head; if
  // a restated line's only copy would be truncated away, we re-append it so
  // the owner doesn't lose a rule they just confirmed.
  const priorKeys = existingMemoryKeys(prior);
  const brandNew = distinct.filter((d) => !priorKeys.has(d.key));
  const restated = distinct.filter((d) => priorKeys.has(d.key));

  const { wanted: maxWanted } = buildNextMemory(prior, distinct.map((d) => d.line), now);
  const overflow = Math.min(prior.length, Math.max(0, maxWanted.length - MEMORY_MD_MAX_CHARS));
  const survivingPriorKeys = existingMemoryKeys(prior.slice(overflow));
  const rescued = restated.filter((d) => !survivingPriorKeys.has(d.key));

  const savedBullets = [...brandNew, ...rescued].map((d) => d.line);

  if (savedBullets.length === 0) {
    return {
      appended: false,
      savedBullets: [],
      skippedDuplicates: bulletLines.length,
      memoryChars: prior.length,
      truncated: false
    };
  }

  const { next, wanted } = buildNextMemory(prior, savedBullets, now);
  await saveConfig(businessId, { memory_md: next });
  scheduleSync(businessId);

  return {
    appended: true,
    savedBullets,
    skippedDuplicates: bulletLines.length - savedBullets.length,
    memoryChars: next.length,
    truncated: next.length < wanted.length
  };
}

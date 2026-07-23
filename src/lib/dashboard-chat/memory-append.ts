/**
 * Owner business-memory append — the single write path for dashboard-chat
 * rule capture.
 *
 * Factored out of /api/voice/tools/owner-append-business-memory (which the
 * VPS chat-worker calls) so the platform-inline chat path can persist
 * captured rules through the exact same dedupe/append/archive semantics
 * without an HTTP hop. Appends bullet lines under a dated "Owner chat"
 * heading in business_configs.memory_md and dedupes against what's already
 * saved.
 *
 * Overflow is ARCHIVED, never destroyed: when active memory would exceed
 * the 14KB cap, the oldest whole sections move to
 * business_configs.memory_archive_md (where ranked retrieval can still
 * answer from them) instead of being sliced off and lost — the pre-Jul-2026
 * behavior silently destroyed a long-running tenant's earliest rules.
 * Finally schedules a VPS vault sync.
 */

import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";

/** Align with rough vault sizing; very large memory slows Rowboat prefill. */
export const MEMORY_MD_MAX_CHARS = 14_000;

/**
 * Cap on the archive document (~14x the active window). The archive is never
 * injected into a static prompt — only ranked retrieval reads it — so it can
 * be generous. On overflow the OLDEST archive content is dropped; at this
 * size that is years of capture history for a typical tenant.
 */
export const MEMORY_ARCHIVE_MD_MAX_CHARS = 200_000;

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

/**
 * Split a memory document into whole sections for archiving decisions.
 *
 * A section starts at a markdown heading (`#`–`####`) or at a `---`
 * horizontal-rule separator line (the capture path writes
 * `\n---\n\n### Owner chat (date)\n…` blocks). Content before the first
 * boundary is its own leading section, so hand-written preamble is moved as
 * one unit. Splitting only ever happens on line boundaries — a bullet is
 * never cut in half.
 */
export function splitMemorySections(md: string): string[] {
  const lines = md.split("\n");
  const sections: string[] = [];
  let current: string[] = [];
  let sawContent = false;
  for (const line of lines) {
    const isBoundary = /^\s*(#{1,4}\s+\S|---\s*$)/.test(line);
    if (isBoundary && sawContent) {
      sections.push(current.join("\n"));
      current = [line];
      // A `---` separator directly followed by a heading belongs to the SAME
      // section as that heading; treat the separator as not-yet-content so
      // the next heading doesn't open another split.
      sawContent = !/^---\s*$/.test(line.trim());
    } else {
      current.push(line);
      // A bare `---` is a separator, not content — without this exception a
      // document-LEADING separator would count as content and split away
      // from its own following heading.
      if (line.trim().length > 0 && !/^---\s*$/.test(line.trim())) sawContent = true;
    }
  }
  if (current.length > 0 && current.join("\n").trim().length > 0) {
    sections.push(current.join("\n"));
  }
  return sections;
}

/**
 * Eviction granularity inside an oversized section. Sections normally stay
 * whole; a section larger than this (e.g. an owner-pasted wall of bullets
 * with no headings) is split at LINE boundaries into ~2KB chunks so an
 * overflow evicts only the oldest sliver of it instead of the whole thing.
 */
export const SECTION_CHUNK_MAX_CHARS = 2_000;

/**
 * Split one section into line-boundary chunks of at most ~2KB each. A single
 * line longer than the chunk cap stays whole (a bullet is never cut in
 * half). Exported for tests.
 */
export function chunkMemorySection(section: string): string[] {
  if (section.length <= SECTION_CHUNK_MAX_CHARS) return [section];
  const chunks: string[] = [];
  let current = "";
  for (const line of section.split("\n")) {
    const candidate = current ? `${current}\n${line}` : line;
    if (current && candidate.length > SECTION_CHUNK_MAX_CHARS) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export type NextMemoryBuild = {
  /** New active memory_md (always <= MEMORY_MD_MAX_CHARS). */
  next: string;
  /** What active memory would have been with no cap (for overflow checks). */
  wanted: string;
  /** New memory_archive_md (prior archive + newly evicted sections). */
  nextArchive: string;
  /** The prior-active portion that SURVIVED in `next` (for dedupe rescue). */
  keptPrior: string;
  /** True when sections were moved to the archive on this build. */
  archived: boolean;
};

/**
 * Append bullet lines under a dated heading. On overflow, move the OLDEST
 * whole sections of the prior memory into the archive until the active
 * document fits the cap — nothing is ever destroyed. If the archive itself
 * overflows its (much larger) cap, its oldest content is dropped.
 */
export function buildNextMemory(
  prior: string,
  lines: string[],
  now: Date = new Date(),
  priorArchive: string = ""
): NextMemoryBuild {
  if (lines.length === 0) {
    return { next: prior, wanted: prior, nextArchive: priorArchive, keptPrior: prior, archived: false };
  }
  const dateStamp = now.toISOString().slice(0, 10);
  const block = ["", "---", "", `### Owner chat (${dateStamp})`, "", ...lines.map((b) => `- ${b}`)].join(
    "\n"
  );
  const wanted = prior ? `${prior}\n${block}` : block.trimStart();

  if (wanted.length <= MEMORY_MD_MAX_CHARS) {
    return { next: wanted, wanted, nextArchive: priorArchive, keptPrior: prior, archived: false };
  }

  // Overflow: peel whole sections (chunked at line boundaries when a single
  // section is oversized) off the HEAD of prior into the archive until what
  // remains + the new block fits. The new block itself is bounded
  // (<= BULLETS_MAX_CHARS + heading) so it always fits an emptied document.
  const chunks = splitMemorySections(prior)
    .flatMap(chunkMemorySection)
    .filter((c) => c.trim().length > 0);
  const evicted: string[] = [];
  let keptFrom = 0;
  let keptPrior = "";
  while (keptFrom < chunks.length) {
    const kept = chunks.slice(keptFrom).join("\n").trim();
    if (`${kept}\n${block}`.length <= MEMORY_MD_MAX_CHARS) {
      keptPrior = kept;
      break;
    }
    evicted.push(chunks[keptFrom]);
    keptFrom += 1;
  }

  const next = keptPrior ? `${keptPrior}\n${block}` : block.trimStart();

  const evictedText = evicted.join("\n").trim();
  let nextArchive = priorArchive;
  if (evictedText) {
    nextArchive = priorArchive.trim() ? `${priorArchive.trimEnd()}\n\n${evictedText}` : evictedText;
    if (nextArchive.length > MEMORY_ARCHIVE_MD_MAX_CHARS) {
      // The archive drops from its HEAD (oldest first) — but only at ~200KB,
      // which is ~14x the active window.
      nextArchive = nextArchive.slice(nextArchive.length - MEMORY_ARCHIVE_MD_MAX_CHARS);
    }
  }

  return { next, wanted, nextArchive, keptPrior, archived: evicted.length > 0 };
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
  /** True when this append moved older sections into the archive. */
  truncated: boolean;
  /** Characters currently held in memory_archive_md after this append. */
  archivedChars: number;
};

/**
 * Persist bullet lines into the business memory. Same semantics as the
 * owner-append adapter route: within-batch dedupe, skip lines already
 * retained in ACTIVE memory, rescue restated lines whose only active copy
 * would be archived away, then write + schedule the vault sync. Callers gate
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
      truncated: false,
      archivedChars: 0
    };
  }

  const existing = await fetchConfig(businessId);
  const prior = existing?.memory_md?.trim() ?? "";
  const priorArchive = existing?.memory_archive_md ?? "";

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
  // a block can push memory over the cap and archive old sections; if a
  // restated line's only ACTIVE copy would be archived away, we re-append it
  // so the rule the owner just confirmed stays in the active prompt window.
  const priorKeys = existingMemoryKeys(prior);
  const brandNew = distinct.filter((d) => !priorKeys.has(d.key));
  const restated = distinct.filter((d) => priorKeys.has(d.key));

  const probe = buildNextMemory(prior, distinct.map((d) => d.line), now, priorArchive);
  const survivingPriorKeys = existingMemoryKeys(probe.keptPrior);
  const rescued = restated.filter((d) => !survivingPriorKeys.has(d.key));

  const savedBullets = [...brandNew, ...rescued].map((d) => d.line);

  if (savedBullets.length === 0) {
    return {
      appended: false,
      savedBullets: [],
      skippedDuplicates: bulletLines.length,
      memoryChars: prior.length,
      truncated: false,
      archivedChars: priorArchive.length
    };
  }

  const build = buildNextMemory(prior, savedBullets, now, priorArchive);
  const patch: { memory_md: string; memory_archive_md?: string } = { memory_md: build.next };
  if (build.archived) patch.memory_archive_md = build.nextArchive;
  await saveConfig(businessId, patch);
  scheduleSync(businessId);

  return {
    appended: true,
    savedBullets,
    skippedDuplicates: bulletLines.length - savedBullets.length,
    memoryChars: build.next.length,
    truncated: build.archived,
    archivedChars: build.archived ? build.nextArchive.length : priorArchive.length
  };
}

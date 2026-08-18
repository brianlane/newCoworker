/**
 * Section-splice editing of `business_configs.identity_md`, the shared
 * core behind the get/update_business_knowledge coworker tools.
 *
 * Why splice-only: the one-shot history's hardest lesson on knowledge edits
 * is that whole-document rewrites destroy owner edits made in between
 * (patch-scar-fairy-knowledge overwrote a dashboard edit). This core makes
 * that structurally impossible: there is no argument that accepts a full
 * document. A caller replaces exactly one section's body, or appends one
 * new heading-led section, and every other byte is preserved verbatim.
 *
 * The write path is EXACTLY the identity editor's (/api/business/config):
 * patchBusinessConfig, then the knowledge-graph long-form extract (source
 * "identity", trust 3, no attribution), then the vault sync, so an edit
 * made from chat can never diverge from one made in the dashboard editor.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { patchBusinessConfig } from "@/lib/db/configs";
import { BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS } from "@/lib/vault/business-config-markdown-limits";
import { scheduleLongFormGraphExtract } from "@/lib/memory/schedule-longform-extract";
import { scheduleVaultSync } from "@/lib/vps/schedule-vault-sync";

/** Per-splice ceiling, well under the document cap so one call can't blow it. */
export const KNOWLEDGE_SPLICE_MAX_CHARS = 8_000;

export type IdentitySection = {
  /** Stable position, 0-based, in document order. */
  index: number;
  /** Heading text without the # marks; null for a pre-heading intro block. */
  heading: string | null;
  /** The section's full text, heading line included. Reassembly-faithful. */
  content: string;
};

const HEADING_RE = /^#{1,6}\s+(\S.*)$/;

/**
 * Split a markdown document into heading-led sections. Joining every
 * section's `content` with "\n" reproduces the input byte-for-byte, which
 * is what lets the splice preserve untouched sections verbatim. Leading
 * lines before the first heading form an intro section (heading null) when
 * they carry any text; whitespace-only leaders stay glued to the first
 * heading section rather than surfacing as an empty phantom section.
 */
export function splitIdentitySections(identityMd: string): IdentitySection[] {
  if (identityMd.length === 0) return [];
  const lines = identityMd.split("\n");
  const groups: Array<{ heading: string | null; lines: string[] }> = [];
  for (const line of lines) {
    const match = HEADING_RE.exec(line);
    if (match) {
      const prev = groups[groups.length - 1];
      if (prev && prev.heading === null && prev.lines.every((l) => l.trim() === "")) {
        // Whitespace-only leader: fold into this heading's section.
        prev.heading = match[1].trim();
        prev.lines.push(line);
        continue;
      }
      groups.push({ heading: match[1].trim(), lines: [line] });
    } else if (groups.length === 0) {
      groups.push({ heading: null, lines: [line] });
    } else {
      groups[groups.length - 1].lines.push(line);
    }
  }
  return groups.map((g, index) => ({
    index,
    heading: g.heading,
    content: g.lines.join("\n")
  }));
}

export type SpliceTarget = { index?: number; heading?: string };

export type SpliceResult = { ok: true; next: string } | { ok: false; message: string };

function describeSections(sections: IdentitySection[]): string {
  if (sections.length === 0) return "the document is empty";
  return sections
    .map((s) => `${s.index}: ${s.heading ?? "(intro before the first heading)"}`)
    .join("; ");
}

/**
 * The prefix of a section up to and including its heading line. A
 * whitespace-only document leader gets folded INTO the first heading
 * section by the splitter, so the heading line is not necessarily the
 * section's first line, taking lines[0] blindly discarded the "## X" line
 * whenever a leader was folded (Bugbot Medium on PR #1379).
 */
function sectionHeadingPrefix(section: IdentitySection): string[] {
  const lines = section.content.split("\n");
  const headingIdx = lines.findIndex((line) => HEADING_RE.test(line));
  return lines.slice(0, headingIdx + 1);
}

/** A section's text WITHOUT its heading line (the whole text for an intro). */
export function sectionBody(section: IdentitySection): string {
  if (section.heading === null) return section.content;
  const lines = section.content.split("\n");
  const headingIdx = lines.findIndex((line) => HEADING_RE.test(line));
  return lines.slice(headingIdx + 1).join("\n");
}

/**
 * Replace one section's body (its heading line is preserved), addressed by
 * heading text (case-insensitive) or by index. Ambiguity and misses refuse
 * with the available sections listed, so the model can self-correct.
 */
export function replaceIdentitySection(
  identityMd: string,
  target: SpliceTarget,
  content: string
): SpliceResult {
  const capped = checkSpliceCaps(content);
  if (capped) return capped;
  const sections = splitIdentitySections(identityMd);
  let section: IdentitySection | undefined;
  if (target.index !== undefined) {
    section = sections.find((s) => s.index === target.index);
    if (!section) {
      return {
        ok: false,
        message: `No section at index ${target.index}. Sections: ${describeSections(sections)}.`
      };
    }
  } else if (target.heading !== undefined && target.heading.trim() !== "") {
    const wanted = target.heading.trim().toLowerCase();
    const matches = sections.filter((s) => s.heading?.trim().toLowerCase() === wanted);
    if (matches.length === 0) {
      return {
        ok: false,
        message: `No section named "${target.heading}". Sections: ${describeSections(sections)}.`
      };
    }
    if (matches.length > 1) {
      return {
        ok: false,
        message: `Multiple sections are named "${target.heading}"; pass section_index instead. Sections: ${describeSections(sections)}.`
      };
    }
    section = matches[0];
  } else {
    return { ok: false, message: "Pass section_heading or section_index to say which section to replace." };
  }

  // The documented flow reads sections (whose bodies the get tool returns)
  // and writes a body back, but a model that re-includes the section's own
  // heading line must not produce "## X" twice (Bugbot Medium on PR #1379).
  // Strip exactly one leading duplicate of THIS section's heading.
  let body = content;
  if (section.heading !== null) {
    const firstLine = body.split("\n", 1)[0];
    const dup = HEADING_RE.exec(firstLine);
    if (dup && dup[1].trim().toLowerCase() === section.heading.trim().toLowerCase()) {
      body = body.slice(firstLine.length).replace(/^\n/, "");
      if (body.trim() === "") {
        return {
          ok: false,
          message: "The new content is empty once its duplicate heading line is removed; a splice can't blank a section."
        };
      }
    }
  }

  const replacement =
    section.heading === null ? body : [...sectionHeadingPrefix(section), body].join("\n");
  const next = sections
    .map((s) => (s.index === section.index ? replacement : s.content))
    .join("\n");
  return checkDocumentCaps(next);
}

/**
 * Append a new heading-led section to the end of the document. The content
 * must begin with its own markdown heading line so the document stays
 * navigable (and re-addressable by later edits).
 */
export function appendIdentitySection(identityMd: string, content: string): SpliceResult {
  const capped = checkSpliceCaps(content);
  if (capped) return capped;
  if (!HEADING_RE.test(content.split("\n", 1)[0])) {
    return {
      ok: false,
      message: 'Start the new section with a markdown heading line (e.g. "## Pricing").'
    };
  }
  const trimmedDoc = identityMd.replace(/\s+$/, "");
  const next = trimmedDoc.length === 0 ? content : `${trimmedDoc}\n\n${content}`;
  return checkDocumentCaps(next);
}

function checkSpliceCaps(content: string): { ok: false; message: string } | null {
  if (content.trim() === "") {
    return { ok: false, message: "The new content is empty; a splice can't blank a section." };
  }
  if (content.length > KNOWLEDGE_SPLICE_MAX_CHARS) {
    return {
      ok: false,
      message: `The new content is ${content.length} characters; the per-edit limit is ${KNOWLEDGE_SPLICE_MAX_CHARS}. Split it into smaller sections.`
    };
  }
  return null;
}

function checkDocumentCaps(next: string): SpliceResult {
  // Emptying the document is impossible by construction: checkSpliceCaps
  // already refused blank content, and a splice preserves every other
  // section verbatim. Only the size cap can fail at document level.
  if (next.length > BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS) {
    return {
      ok: false,
      message: `The document would be ${next.length} characters; the limit is ${BUSINESS_CONFIG_IDENTITY_MD_MAX_CHARS}. Replace or shorten an existing section instead.`
    };
  }
  return { ok: true, next };
}

export type BusinessKnowledgeRead = {
  sections: IdentitySection[];
  total_chars: number;
};

export type IdentityReadResult = { exists: boolean; identityMd: string };

/**
 * Strict identity read: THROWS on a failed query; `exists: false` only on a
 * confirmed missing row. Deliberately not getBusinessConfig, which collapses
 * read errors and no-row into one null, this module must never mistake a
 * transient failure for an empty document, because an append against that
 * misread would overwrite the whole identity with a single section (Bugbot
 * High on PR #1379).
 */
async function readIdentityStrict(businessId: string): Promise<IdentityReadResult> {
  const db = await createSupabaseServiceClient();
  const { data, error } = await db
    .from("business_configs")
    .select("identity_md")
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`readIdentityStrict: ${error.message}`);
  if (!data) return { exists: false, identityMd: "" };
  const identityMd = (data as { identity_md?: unknown }).identity_md;
  return { exists: true, identityMd: typeof identityMd === "string" ? identityMd : "" };
}

export type KnowledgeCoreDeps = {
  readIdentity?: (businessId: string) => Promise<IdentityReadResult>;
  patchConfig?: typeof patchBusinessConfig;
  scheduleGraphExtract?: typeof scheduleLongFormGraphExtract;
  scheduleVault?: typeof scheduleVaultSync;
};

function resolveDeps(deps: KnowledgeCoreDeps) {
  return {
    readIdentity: deps.readIdentity ?? readIdentityStrict,
    patchConfig: deps.patchConfig ?? patchBusinessConfig,
    scheduleGraphExtract: deps.scheduleGraphExtract ?? scheduleLongFormGraphExtract,
    scheduleVault: deps.scheduleVault ?? scheduleVaultSync
  };
}

/**
 * Sections for the model to read: heading in its own field, `content` is
 * the BODY only. The get tool's payload is what a model pastes back into a
 * replace, so returning the heading inside `content` invited duplicate
 * headings on the round trip (Bugbot Medium on PR #1379).
 */
export async function readBusinessKnowledge(
  businessId: string,
  deps: KnowledgeCoreDeps = {}
): Promise<BusinessKnowledgeRead> {
  const { readIdentity } = resolveDeps(deps);
  const { identityMd } = await readIdentity(businessId);
  return {
    sections: splitIdentitySections(identityMd).map((s) => ({ ...s, content: sectionBody(s) })),
    total_chars: identityMd.length
  };
}

export type KnowledgeUpdateArgs = {
  mode: "replace" | "append_section";
  sectionIndex?: number;
  sectionHeading?: string;
  content: string;
};

export type KnowledgeUpdateResult =
  | { ok: true; sections: IdentitySection[]; total_chars: number }
  | { ok: false; message: string };

/**
 * Apply one splice and push it through the identity editor's exact write
 * path: patchBusinessConfig, the KG long-form extract, the vault sync.
 */
export async function updateBusinessKnowledgeCore(
  businessId: string,
  args: KnowledgeUpdateArgs,
  deps: KnowledgeCoreDeps = {}
): Promise<KnowledgeUpdateResult> {
  const { readIdentity, patchConfig, scheduleGraphExtract, scheduleVault } = resolveDeps(deps);
  // Throws on a failed read (surfaced as a generic tool error). exists:false
  // is a CONFIRMED empty state: replace refuses naturally ("the document is
  // empty"), append legitimately starts a brand-new document.
  const { identityMd } = await readIdentity(businessId);

  const spliced =
    args.mode === "append_section"
      ? appendIdentitySection(identityMd, args.content)
      : replaceIdentitySection(
          identityMd,
          { index: args.sectionIndex, heading: args.sectionHeading },
          args.content
        );
  if (!spliced.ok) return spliced;

  await patchConfig(businessId, { identity_md: spliced.next });
  // Same deferred follow-ups as the dashboard identity editor: the KG
  // extract is owner-authored trust-3 with no attribution, and the vault
  // sync pushes the fresh knowledge to the live per-tenant agent.
  scheduleGraphExtract(businessId, {
    text: spliced.next,
    source: "identity",
    attributedTo: null
  });
  scheduleVault(businessId);

  return {
    ok: true,
    sections: splitIdentitySections(spliced.next).map((s) => ({
      ...s,
      content: sectionBody(s)
    })),
    total_chars: spliced.next.length
  };
}

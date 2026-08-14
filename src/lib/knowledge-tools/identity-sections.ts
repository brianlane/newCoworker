/**
 * Section-splice editing of `business_configs.identity_md` — the shared
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
 * "identity", trust 3, no attribution), then the vault sync — so an edit
 * made from chat can never diverge from one made in the dashboard editor.
 */

import { getBusinessConfig, patchBusinessConfig } from "@/lib/db/configs";
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

  const replacement =
    section.heading === null
      ? content
      : `${section.content.split("\n", 1)[0]}\n${content}`;
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

export type KnowledgeCoreDeps = {
  getConfig?: typeof getBusinessConfig;
  patchConfig?: typeof patchBusinessConfig;
  scheduleGraphExtract?: typeof scheduleLongFormGraphExtract;
  scheduleVault?: typeof scheduleVaultSync;
};

function resolveDeps(deps: KnowledgeCoreDeps) {
  return {
    getConfig: deps.getConfig ?? getBusinessConfig,
    patchConfig: deps.patchConfig ?? patchBusinessConfig,
    scheduleGraphExtract: deps.scheduleGraphExtract ?? scheduleLongFormGraphExtract,
    scheduleVault: deps.scheduleVault ?? scheduleVaultSync
  };
}

export async function readBusinessKnowledge(
  businessId: string,
  deps: KnowledgeCoreDeps = {}
): Promise<BusinessKnowledgeRead> {
  const { getConfig } = resolveDeps(deps);
  const config = await getConfig(businessId);
  const identityMd = config?.identity_md ?? "";
  return { sections: splitIdentitySections(identityMd), total_chars: identityMd.length };
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
  const { getConfig, patchConfig, scheduleGraphExtract, scheduleVault } = resolveDeps(deps);
  const config = await getConfig(businessId);
  const identityMd = config?.identity_md ?? "";

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
    sections: splitIdentitySections(spliced.next),
    total_chars: spliced.next.length
  };
}

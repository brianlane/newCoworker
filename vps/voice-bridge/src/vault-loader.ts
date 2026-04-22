/**
 * Load the Rowboat vault files and expose them as a compact snapshot the
 * Gemini Live system instruction can embed.
 *
 * The vault directory (default `/vault`, mounted read-only from the host's
 * `/opt/rowboat/vault`) is populated by `vps/scripts/deploy-client.sh`:
 *
 *   soul.md      — tone + operating rules
 *   identity.md  — business facts (name, owner, hours, services)
 *   memory.md    — lossless long-form memory
 *   website.md   — optional summarized public-website briefing
 *
 * We cap each section aggressively. Gemini Live currently accepts fairly
 * long system prompts, but oversized prompts eat into the context window
 * available for the live conversation and its tool calls. Keeping the full
 * briefing under ~12 KB leaves plenty of headroom for a long call.
 */
import { promises as fs } from "node:fs";
import { join } from "node:path";

export type VaultSnapshot = {
  soul: string;
  identity: string;
  memory: string;
  website: string;
  /** Sum of characters after truncation — useful for logs. */
  totalChars: number;
  /** Files that actually had non-empty content after trimming. */
  presentFiles: Array<"soul" | "identity" | "memory" | "website">;
};

export type VaultLoaderOptions = {
  vaultPath?: string;
  maxPerFileChars?: number;
  maxTotalChars?: number;
};

const DEFAULT_MAX_PER_FILE_CHARS = 4_000;
const DEFAULT_MAX_TOTAL_CHARS = 12_000;

const FILES = [
  { key: "soul", name: "soul.md" },
  { key: "identity", name: "identity.md" },
  { key: "memory", name: "memory.md" },
  { key: "website", name: "website.md" }
] as const;

function truncate(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n\n[... truncated for prompt size ...]`;
}

export async function loadVaultForPrompt(
  options: VaultLoaderOptions = {}
): Promise<VaultSnapshot> {
  const vaultPath = options.vaultPath ?? process.env.VAULT_PATH ?? "/vault";
  const maxPerFile = Math.max(500, options.maxPerFileChars ?? DEFAULT_MAX_PER_FILE_CHARS);
  const maxTotal = Math.max(maxPerFile, options.maxTotalChars ?? DEFAULT_MAX_TOTAL_CHARS);

  const snapshot: VaultSnapshot = {
    soul: "",
    identity: "",
    memory: "",
    website: "",
    totalChars: 0,
    presentFiles: []
  };

  for (const file of FILES) {
    try {
      const raw = await fs.readFile(join(vaultPath, file.name), "utf8");
      const truncated = truncate(raw, maxPerFile);
      if (truncated.length > 0) {
        snapshot[file.key] = truncated;
        snapshot.totalChars += truncated.length;
        snapshot.presentFiles.push(file.key);
      }
    } catch {
      // Missing files are expected (website.md is optional; identity.md may
      // not exist on brand-new accounts). Keep the section empty.
    }
  }

  // Global cap across all sections — trim longest first if we overshoot.
  if (snapshot.totalChars > maxTotal) {
    const entries = FILES.map((f) => ({ key: f.key, length: snapshot[f.key].length }));
    entries.sort((a, b) => b.length - a.length);
    let remaining = snapshot.totalChars - maxTotal;
    for (const entry of entries) {
      if (remaining <= 0) break;
      const current = snapshot[entry.key];
      if (!current) continue;
      const shrinkTo = Math.max(500, current.length - remaining);
      const next = truncate(current, shrinkTo);
      snapshot[entry.key] = next;
      remaining -= current.length - next.length;
    }
    snapshot.totalChars = FILES.reduce((sum, f) => sum + snapshot[f.key].length, 0);
  }

  return snapshot;
}

export function composeVaultPromptSection(snapshot: VaultSnapshot): string {
  if (snapshot.presentFiles.length === 0) return "";
  const sections: string[] = [
    "Below is your business-specific knowledge. Treat it as the source of truth for anything specific to this business. Do not invent facts outside of it."
  ];
  if (snapshot.identity) {
    sections.push("=== identity.md (who the business is) ===", snapshot.identity);
  }
  if (snapshot.soul) {
    sections.push("=== soul.md (tone and operating rules) ===", snapshot.soul);
  }
  if (snapshot.website) {
    sections.push(
      "=== website.md (summarized public website — may be outdated; prefer live tool lookups when available) ===",
      snapshot.website
    );
  }
  if (snapshot.memory) {
    sections.push("=== memory.md (relevant long-form memory) ===", snapshot.memory);
  }
  return sections.join("\n\n");
}

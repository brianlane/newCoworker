/**
 * KG SOURCE-COVERAGE CONTRACT (the "we missed one" guard).
 *
 * Pins src/lib/memory/kg-sources.ts three ways:
 *   1. Every LIVE source (extracted/deterministic) must have a real ingest
 *      call site in the repo, marked `kg-source: <name>` next to the
 *      applyGraphExtraction/provenance wiring — a registry that claims a
 *      hook that doesn't exist fails here.
 *   2. Every entry must be well-formed (trust for live/planned, reason for
 *      exempt, plannedIn for planned).
 *   3. The platform's content-surface INVENTORY below must be fully mapped
 *      by the registry. Adding a new content surface (a new channel, a new
 *      content table) requires adding it BOTH here and in the registry with
 *      a decision — the same reviewer-visible pinning the agent-tool parity
 *      contract uses. Do not weaken this list to make a PR pass; add the
 *      registry decision instead.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { KG_SOURCES, kgSourceTrust, liveKgSources, type KgSourceEntry } from "@/lib/memory/kg-sources";

const REPO_ROOT = resolve(__dirname, "..");

/**
 * The content surfaces of the platform, by hand — this list IS the
 * completeness claim. Each maps to the registry key(s) covering it.
 */
const CONTENT_SURFACE_INVENTORY: Record<string, (keyof typeof KG_SOURCES)[]> = {
  "owner dashboard chat + owner SMS capture": ["owner_chat"],
  "historical memory backfill": ["backfill"],
  "team roster (employees)": ["team_roster"],
  "contacts directory + owner pinned notes": ["contacts", "customer_pinned_notes"],
  "business profile (hours/address/contact)": ["business_profile"],
  "aiflow lead submissions + webhook leads": ["aiflow_lead"],
  "bookings / calendar events": ["booking"],
  "doc_extract structured record fields": ["doc_extract_fields"],
  "voice call transcripts": ["voice_call"],
  "customer SMS threads": ["customer_sms"],
  "messenger / instagram DM conversations": ["messenger"],
  "whatsapp conversations": ["whatsapp"],
  "webchat conversations": ["webchat"],
  "inbound email": ["email_replied", "email_unanswered"],
  "uploaded documents (incl. meeting minutes + agent artifacts)": ["document"],
  "website knowledge (crawl)": ["website"],
  "identity markdown (onboarding)": ["identity"],
  "assistant replies (all channels)": ["assistant_replies"],
  "marketing social posts": ["social_posts"],
  "platform blog": ["platform_blog"]
};

function grepRepo(pattern: string): string {
  try {
    return execFileSync(
      "grep",
      ["-r", "-l", pattern, "src", "debug", "--include=*.ts", "--include=*.tsx"],
      { cwd: REPO_ROOT, encoding: "utf8" }
    );
  } catch {
    return "";
  }
}

describe("kg-sources registry", () => {
  it("every entry is well-formed for its status", () => {
    for (const [name, entry] of Object.entries(KG_SOURCES) as Array<[string, KgSourceEntry]>) {
      if (entry.status === "exempt") {
        expect(entry.reason, `${name}: exempt entries must state a reason`).toBeTruthy();
      } else {
        expect(entry.trust, `${name}: non-exempt entries must carry a trust tier`).toBeDefined();
      }
      if (entry.status === "planned") {
        expect(entry.plannedIn, `${name}: planned entries must name their PR`).toBeTruthy();
      }
    }
  });

  it("every LIVE source has a marked ingest call site in the repo", () => {
    for (const source of liveKgSources()) {
      const hits = grepRepo(`kg-source: ${source}`);
      expect(
        hits.trim().length,
        `live source '${source}' has no 'kg-source: ${source}' marked call site — ` +
          "wire the hook or change the registry status"
      ).toBeGreaterThan(0);
    }
  });

  it("the content-surface inventory is fully mapped by the registry", () => {
    const registryKeys = new Set(Object.keys(KG_SOURCES));
    const mappedKeys = new Set<string>();
    for (const [surface, keys] of Object.entries(CONTENT_SURFACE_INVENTORY)) {
      expect(keys.length, `${surface}: maps to no registry key`).toBeGreaterThan(0);
      for (const key of keys) {
        expect(registryKeys.has(key), `${surface}: '${key}' missing from KG_SOURCES`).toBe(true);
        mappedKeys.add(key);
      }
    }
    // And the reverse: no registry key floats unattached to a surface.
    for (const key of registryKeys) {
      expect(mappedKeys.has(key), `registry key '${key}' maps to no inventory surface`).toBe(true);
    }
  });

  it("kgSourceTrust returns tiers for non-exempt sources and refuses exempt ones", () => {
    expect(kgSourceTrust("owner_chat")).toBe(3);
    expect(kgSourceTrust("webchat")).toBe(0);
    expect(() => kgSourceTrust("assistant_replies")).toThrow(/exempt/);
  });
});

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Keeps the tenant dossiers in `docs/tenants/` honest.
 *
 * The dossiers exist so that "review everything about Amy / KYP / Truly" is
 * one file read instead of a re-derivation from the chat archive and the PR
 * list. That only holds while they are current, and a stale dossier is worse
 * than none because it gets trusted. So this pins the same contract the KG
 * source registry and the coworker-tool parity list already carry: a change
 * that adds tenant-specific tooling cannot land without the dossier edit.
 *
 * The rule enforced here: **every one-shot script named after a tenant is
 * mentioned in that tenant's dossier, and every script a dossier names still
 * exists.** Adding a tenant one-shot therefore costs one line of docs, and
 * renaming or deleting one cannot leave a dangling reference behind.
 *
 * Scripts with no tenant token in their filename (`simplify-claim-options.ts`,
 * `create-term-prices.ts`) are out of scope: this guard identifies ownership
 * from the name alone, and guessing beyond that would produce false failures.
 */

const ROOT = join(__dirname, "..");
const DOSSIER_DIR = join(ROOT, "docs", "tenants");
const ONESHOT_DIR = join(ROOT, "scripts", "oneshot");

/**
 * Filename tokens that identify a tenant, mapped to the dossier(s) allowed to
 * account for them. HomeLight is a lead source inside Amy's account and has
 * its own file, so either dossier satisfies an Amy-side token.
 */
const TENANT_TOKENS: ReadonlyArray<{ token: string; dossiers: string[] }> = [
  { token: "homelight", dossiers: ["homelight-flow.md", "amy-laidlaw-real-estate.md"] },
  { token: "clever", dossiers: ["amy-laidlaw-real-estate.md"] },
  { token: "realtor", dossiers: ["amy-laidlaw-real-estate.md"] },
  { token: "referralexchange", dossiers: ["amy-laidlaw-real-estate.md"] },
  { token: "amy", dossiers: ["amy-laidlaw-real-estate.md"] },
  { token: "dave", dossiers: ["amy-laidlaw-real-estate.md"] },
  { token: "kyp", dossiers: ["kyp-ads.md"] },
  { token: "truly", dossiers: ["truly-insurance.md"] },
  { token: "privyr", dossiers: ["truly-insurance.md"] },
  { token: "kin", dossiers: ["kin-integrated-child-health.md"] },
  { token: "scar", dossiers: ["scar-fairy.md"] },
  { token: "fairy", dossiers: ["scar-fairy.md"] },
  { token: "hq", dossiers: ["new-coworker-hq.md"] }
];

/** Split a filename into its hyphen/dot separated words, so "hq" cannot match "chqx". */
function nameSegments(fileName: string): Set<string> {
  return new Set(fileName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
}

function dossierText(fileName: string): string {
  return readFileSync(join(DOSSIER_DIR, fileName), "utf8");
}

const oneshotFiles = readdirSync(ONESHOT_DIR).filter((f) => f.endsWith(".ts") && !f.startsWith("_"));

describe("tenant dossiers", () => {
  it("has a dossier file for every tenant token, plus an index", () => {
    expect(existsSync(join(DOSSIER_DIR, "README.md"))).toBe(true);
    for (const { dossiers } of TENANT_TOKENS) {
      for (const dossier of dossiers) {
        expect(existsSync(join(DOSSIER_DIR, dossier)), `missing docs/tenants/${dossier}`).toBe(true);
      }
    }
  });

  it("names every tenant-specific one-shot in the matching dossier", () => {
    const missing: string[] = [];
    let checked = 0;
    for (const file of oneshotFiles) {
      const segments = nameSegments(file);
      for (const { token, dossiers } of TENANT_TOKENS) {
        if (!segments.has(token)) continue;
        checked += 1;
        const mentioned = dossiers.some((d) => dossierText(d).includes(file));
        if (!mentioned) missing.push(`${file} -> expected a mention in ${dossiers.join(" or ")}`);
      }
    }
    // A token-matching bug would make the loop above check nothing and pass
    // silently, which is the one failure mode a guard cannot have.
    expect(checked, "tenant-token matching found no scripts; the guard is not actually checking anything").toBeGreaterThan(
      30
    );
    expect(
      missing,
      `Tenant one-shots missing from their dossier. Add a line naming each script under the ` +
        `dossier's "One-shots" section (docs/tenants/README.md explains why).\n${missing.join("\n")}`
    ).toEqual([]);
  });

  it("does not reference one-shot scripts that no longer exist", () => {
    const known = new Set(oneshotFiles);
    const dangling: string[] = [];
    for (const dossier of readdirSync(DOSSIER_DIR).filter((f) => f.endsWith(".md"))) {
      const text = dossierText(dossier);
      for (const match of text.matchAll(/`([a-z0-9-]+\.ts)`/g)) {
        const referenced = match[1];
        // debug/ tools are referenced by path, one-shots by bare filename.
        if (text.includes(`debug/${referenced}`)) continue;
        if (!known.has(referenced) && existsSync(join(ROOT, "debug", referenced))) continue;
        if (!known.has(referenced)) dangling.push(`${dossier} references missing ${referenced}`);
      }
    }
    expect(dangling, `Dossiers reference scripts that no longer exist:\n${dangling.join("\n")}`).toEqual([]);
  });

  it("keeps end-user phone numbers out of the dossiers", () => {
    // Business DIDs are fine and useful here; a lead's number is PII and must
    // not spread into committed docs (see debug/README.md).
    const businessDids = new Set([
      "+16028053377", // Amy
      "+15198006401", // Truly
      "+14388035806", // KYP Ads
      "+16023131823", // New Coworker HQ (also the homepage demo line)
      "+13054885455", // Scar Fairy
      "+14159851909", // HomeLight live-transfer source
      "+18609926975", // Clever Concierge
      "+19289402447", // Clever Veronica
      "+18332253837", // Clever live transfer
      "+13056133412" // Clever Jake
    ]);
    const leaked: string[] = [];
    for (const dossier of readdirSync(DOSSIER_DIR).filter((f) => f.endsWith(".md"))) {
      for (const match of dossierText(dossier).matchAll(/\+\d{10,15}/g)) {
        if (!businessDids.has(match[0])) leaked.push(`${dossier}: ${match[0]}`);
      }
    }
    expect(
      leaked,
      `Unexpected phone numbers in tenant dossiers. If this is a new business DID, add it to the ` +
        `allow-list; if it belongs to a lead or customer, remove it.\n${leaked.join("\n")}`
    ).toEqual([]);
  });
});

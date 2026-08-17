import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The term refund deduction is gone (Aug 2026). Refunds on 12/24-month plans
 * return the full term payment minus only what a monthly refund also loses:
 * the one-time carrier registration fee, usage already run at cost, and
 * non-refundable usage packs.
 *
 * This guard exists because of how the removal was nearly shipped wrong.
 * The sweep that removed the copy searched `messages/en.json`,
 * `messages/es.json`, the Terms page and the FAQ, and it MISSED
 * `src/components/billing/CancelSheet.tsx`, which hardcodes its copy inline
 * instead of reading the i18n catalog. That is the sheet a customer reads at
 * the moment they click cancel, so it was the single worst place to leave a
 * promise we no longer honor: it told them we would withhold a month we no
 * longer withhold.
 *
 * A catalog-only sweep cannot catch hardcoded copy, so this scans the
 * rendered source too. It is deliberately about the POLICY claim, not about
 * one file.
 */

const ROOT = join(__dirname, "..");

/**
 * Phrasings that assert the removed deduction. Kept close to natural
 * sentence shapes rather than a single loose word, so the test names a real
 * broken promise instead of firing on any sentence containing "month".
 */
const REMOVED_DEDUCTION_CLAIMS = [
  /\bdeducts? one month/i,
  /\bminus one month/i,
  // Word-anchored: without \b this matches inside "unless one month", so
  // ordinary copy like "unless one month has passed" would fail a guard that
  // is supposed to catch a specific broken promise.
  /\bless one month/i,
  /\bone month of service at the monthly rate/i,
  /\bwithhold(?:s|ing)? one month/i
];

/** Surfaces whose text a customer can actually read. */
const COPY_ROOTS = [
  "messages",
  "src/app",
  "src/components",
  "src/lib/email",
  "supabase/functions/_shared"
];

const COPY_EXTENSIONS = [".ts", ".tsx", ".json"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry.startsWith(".")) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, out);
    } else if (COPY_EXTENSIONS.some((ext) => entry.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

describe("refund policy copy matches the shipped refund policy", () => {
  it("no customer-facing surface still promises the removed one-month term deduction", () => {
    const offenders: string[] = [];
    for (const root of COPY_ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        const text = readFileSync(file, "utf8");
        for (const claim of REMOVED_DEDUCTION_CLAIMS) {
          if (claim.test(text)) {
            offenders.push(`${relative(ROOT, file)} matches ${claim}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  // A guard that fires on innocent copy gets deleted by the next person who
  // trips it, so the patterns have to be anchored to the claim itself.
  it("does not fire on ordinary copy that merely contains the same letters", () => {
    const innocent = [
      "You can reactivate unless one month has already passed.",
      "Your plan renews unless one month of notice is given.",
      "We bill monthly; one month of service is included.",
      "Cancel any time in the first month of service."
    ];
    for (const line of innocent) {
      for (const claim of REMOVED_DEDUCTION_CLAIMS) {
        expect(claim.test(line), `${claim} wrongly matched: ${line}`).toBe(false);
      }
    }
  });

  // ...and still catches the real thing, in the shapes it was actually
  // written in across the catalogs, the Terms page and the cancel sheet.
  it("still catches every phrasing the deduction was written in", () => {
    const offending = [
      "On 12/24-month plans the refund also deducts one month of service at the monthly rate.",
      "we refund your term payment minus one month of service at the monthly rate",
      "the refund is less one month of service",
      "12/24-month plans deduct one month of service at the monthly rate",
      "we withhold one month at the monthly rate"
    ];
    for (const line of offending) {
      expect(
        REMOVED_DEDUCTION_CLAIMS.some((claim) => claim.test(line)),
        `no pattern caught: ${line}`
      ).toBe(true);
    }
  });

  // The specific file the original sweep missed, pinned by name: it is the
  // last thing a customer reads before cancelling, and it does not go
  // through the i18n catalog, so nothing else covers it.
  it("the cancel sheet lists exactly the carve-outs that still apply", () => {
    const sheet = readFileSync(
      join(ROOT, "src/components/billing/CancelSheet.tsx"),
      "utf8"
    );
    expect(sheet).toMatch(/carrier registration fee/i);
    expect(sheet).toMatch(/usage charges billed at cost/i);
    expect(sheet).toMatch(/pack add-ons are\s+non-refundable/i);
    for (const claim of REMOVED_DEDUCTION_CLAIMS) {
      expect(sheet).not.toMatch(claim);
    }
  });
});

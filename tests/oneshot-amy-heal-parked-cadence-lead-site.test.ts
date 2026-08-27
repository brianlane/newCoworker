/**
 * Healing the parked cadence runs' site vars
 * (scripts/oneshot/amy-heal-parked-cadence-lead-site.ts).
 *
 * The companion to the two-var site scheme in the cadence builder: the
 * re-seed fixes future runs, this one seeds `lead_site_ref` on runs already
 * parked in a three-day wait (whose next call would otherwise render a hole
 * where the phrase belongs) and fills a fallen-back `lead_site` from the
 * contact row's `lead_source`.
 */
import { describe, expect, it } from "vitest";
import {
  OLD_SITE_FALLBACK,
  UNKNOWN_SITE,
  UNKNOWN_SITE_REF,
  decideSiteHeal,
  siteRefFor
} from "../scripts/oneshot/amy-heal-parked-cadence-lead-site";

describe("decideSiteHeal", () => {
  it("fills the old fallback site from the contact row and derives the phrase", () => {
    // Sandy Baldwin's run, verbatim: the pre-fix extraction fell back, and
    // her contact row has known the source all along.
    expect(
      decideSiteHeal({ lead_site: OLD_SITE_FALLBACK }, "ReferralExchange")
    ).toEqual({
      outcome: "set",
      site: "ReferralExchange",
      ref: "your enquiry through ReferralExchange",
      changed: ["lead_site", "lead_site_ref"]
    });
  });

  it("keeps a real extracted site and only seeds the missing phrase", () => {
    // Eight of the twelve parked runs on 2026-08-27: extraction knew the
    // site, so the contact row must not overrule it, only the phrase is new.
    expect(decideSiteHeal({ lead_site: "Clever" }, "ReferralExchange")).toEqual({
      outcome: "set",
      site: "Clever",
      ref: "your enquiry through Clever",
      changed: ["lead_site_ref"]
    });
  });

  it("falls back composably when the contact row knows nothing either", () => {
    for (const source of [null, undefined, "", "   "]) {
      expect(decideSiteHeal({ lead_site: OLD_SITE_FALLBACK }, source)).toEqual({
        outcome: "set",
        site: UNKNOWN_SITE,
        ref: UNKNOWN_SITE_REF,
        changed: ["lead_site", "lead_site_ref"]
      });
    }
  });

  it("treats a missing or non-string lead_site like a fallen-back one", () => {
    expect(decideSiteHeal({}, "Clever")).toMatchObject({ outcome: "set", site: "Clever" });
    expect(decideSiteHeal({ lead_site: 42 }, "Clever")).toMatchObject({
      outcome: "set",
      site: "Clever"
    });
    expect(decideSiteHeal({ lead_site: "  " }, null)).toMatchObject({
      outcome: "set",
      site: UNKNOWN_SITE,
      ref: UNKNOWN_SITE_REF
    });
  });

  it("upgrades a fallback phrase when a real site arrives, and never the reverse", () => {
    // A post-fix run that extracted "unknown" (source line empty at tag time)
    // while the contact row has since learned the source: both vars move.
    expect(
      decideSiteHeal({ lead_site: UNKNOWN_SITE, lead_site_ref: UNKNOWN_SITE_REF }, "Clever")
    ).toEqual({
      outcome: "set",
      site: "Clever",
      ref: "your enquiry through Clever",
      changed: ["lead_site", "lead_site_ref"]
    });
    // A phrase that already names a site is kept verbatim.
    expect(
      decideSiteHeal(
        { lead_site: "Clever", lead_site_ref: "your enquiry through Clever" },
        "ReferralExchange"
      )
    ).toEqual({ outcome: "already_right" });
  });

  it("is idempotent: its own output decides already_right on the next pass", () => {
    for (const [vars, source] of [
      [{ lead_site: OLD_SITE_FALLBACK }, "ReferralExchange"],
      [{ lead_site: "Clever" }, null],
      [{ lead_site: OLD_SITE_FALLBACK }, null]
    ] as const) {
      const first = decideSiteHeal(vars, source);
      expect(first.outcome).toBe("set");
      if (first.outcome !== "set") continue;
      expect(
        decideSiteHeal({ ...vars, lead_site: first.site, lead_site_ref: first.ref }, source)
      ).toEqual({ outcome: "already_right" });
    }
  });

  it("trims what it reads and writes trimmed values", () => {
    expect(decideSiteHeal({ lead_site: " Clever " }, "  ")).toEqual({
      outcome: "set",
      site: "Clever",
      ref: "your enquiry through Clever",
      changed: ["lead_site", "lead_site_ref"]
    });
  });
});

describe("the constants the templates lean on", () => {
  it("keeps the spoken fallback identical to the pre-fix value, on purpose", () => {
    // "your recent enquiry" was always the right thing to SAY; it was only
    // wrong as the object of "through". Parked runs healed to this value and
    // new runs extracting it must read the same.
    expect(UNKNOWN_SITE_REF).toBe(OLD_SITE_FALLBACK);
  });

  it("derives the phrase the way the extraction field describes it", () => {
    expect(siteRefFor("Clever")).toBe("your enquiry through Clever");
  });
});

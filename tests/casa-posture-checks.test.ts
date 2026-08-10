/**
 * CASA posture check logic (src/lib/casa/posture-checks.ts).
 *
 * These judgements decide whether the annual reassessment can reuse an SAQ
 * answer, so the failure cases matter more than the passing ones: a check that
 * quietly returns "ok" for a wildcard CORS header or an expired security.txt
 * would hand an assessor a claim we can no longer support.
 */
import { describe, expect, it } from "vitest";
import {
  BASELINE_HEADERS,
  DISCLOSURE_PATHS,
  checkBaselineHeaders,
  checkCorsHeader,
  checkDisclosurePath,
  checkHsts,
  checkLegacyTlsRefused,
  checkPasswordMinimum,
  checkSecurityTxt,
  formatReport,
  parseConfiguredPasswordMinimum,
  summarize
} from "@/lib/casa/posture-checks";

describe("checkCorsHeader", () => {
  it("passes when no header is present at all", () => {
    const r = checkCorsHeader("/dashboard", []);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("no Access-Control-Allow-Origin");
  });

  it("passes on a specific origin", () => {
    expect(checkCorsHeader("/", ["https://www.newcoworker.com"]).ok).toBe(true);
  });

  it("FAILS on a wildcard, the 2026 finding", () => {
    const r = checkCorsHeader("/robots.txt", ["*"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("WILDCARD");
  });

  it("FAILS on a duplicated header, which is its own misconfiguration", () => {
    const r = checkCorsHeader("/", ["https://www.newcoworker.com", "https://other.example"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("duplicated");
  });

  it("reports the wildcard when a header is both duplicated and wildcarded", () => {
    // Precedence matters in the report: the wildcard is the more serious
    // finding and the one an assessor will quote back at us.
    const r = checkCorsHeader("/", ["https://www.newcoworker.com", "*"]);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("WILDCARD");
  });
});

describe("checkHsts", () => {
  it("passes with a long max-age", () => {
    expect(checkHsts("max-age=63072000; includeSubDomains; preload").ok).toBe(true);
  });

  it("fails when absent", () => {
    const r = checkHsts(null);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("header absent");
  });

  it("fails when max-age is too short to be meaningful", () => {
    const r = checkHsts("max-age=600");
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("below the required");
  });

  it("fails when the header carries no parseable max-age", () => {
    expect(checkHsts("includeSubDomains").ok).toBe(false);
  });
});

describe("checkBaselineHeaders", () => {
  it("reports one result per baseline header", () => {
    const results = checkBaselineHeaders(() => "set");
    expect(results).toHaveLength(BASELINE_HEADERS.length);
    expect(results.every((r) => r.ok)).toBe(true);
  });

  it("flags exactly the missing ones", () => {
    const results = checkBaselineHeaders((n) => (n === "x-frame-options" ? null : "set"));
    const failed = results.filter((r) => !r.ok);
    expect(failed).toHaveLength(1);
    expect(failed[0].label).toBe("x-frame-options");
    expect(failed[0].detail).toBe("absent");
  });
});

describe("checkDisclosurePath", () => {
  it.each([404, 403, 301])("treats %s as not-served", (status) => {
    expect(checkDisclosurePath("/.env", status).ok).toBe(true);
  });

  it("FAILS when the request never completed, rather than claiming a pass", () => {
    // A timeout proves nothing. Reporting it as "not served" would put a false
    // assurance into an assessor's evidence pack on the strength of a network
    // blip, which is the whole failure mode this probe exists to avoid.
    const r = checkDisclosurePath("/.env", null);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not verified");
  });

  it.each([200, 206])("FAILS on %s, the file is being handed out", (status) => {
    const r = checkDisclosurePath("/.git/config", status);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe(`HTTP ${status}`);
  });

  it("covers the paths a scanner actually probes", () => {
    expect(DISCLOSURE_PATHS).toContain("/.git/config");
    expect(DISCLOSURE_PATHS).toContain("/.env");
  });
});

describe("checkSecurityTxt", () => {
  const now = new Date("2026-08-05T00:00:00Z");
  const valid = [
    "Contact: mailto:team@newcoworker.com",
    "Policy: https://www.newcoworker.com/security/vulnerability-disclosure",
    "Expires: 2027-08-05T00:00:00.000Z"
  ].join("\n");

  it("passes a complete, unexpired file", () => {
    const r = checkSecurityTxt(valid, now);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("2027-08-05");
  });

  it("FAILS when expired, which reads as an abandoned policy", () => {
    const r = checkSecurityTxt(valid.replace("2027-", "2025-"), now);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("EXPIRED");
  });

  it("names the missing required fields", () => {
    const r = checkSecurityTxt("Contact: mailto:team@newcoworker.com", now);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Expires:");
    expect(r.detail).toContain("Policy:");
  });

  it("fails on an unparseable Expires rather than assuming it is fine", () => {
    const r = checkSecurityTxt(valid.replace("2027-08-05T00:00:00.000Z", "next year"), now);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("unparseable");
  });

  it("fails when the Expires label carries no value at all", () => {
    // The field-presence check passes on the bare label, so the value parse is
    // the only thing standing between this and a silently accepted file.
    const bare = [
      "Contact: mailto:team@newcoworker.com",
      "Policy: https://www.newcoworker.com/security/vulnerability-disclosure",
      "Expires:"
    ].join("\n");

    const r = checkSecurityTxt(bare, now);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("(none)");
  });
});

describe("parseConfiguredPasswordMinimum", () => {
  it("reads the minimum out of the provider's rejection", () => {
    expect(parseConfiguredPasswordMinimum("Password should be at least 12 characters.")).toBe(12);
  });

  it.each([null, undefined, "", "Some unrelated error"])("returns null for %s", (msg) => {
    expect(parseConfiguredPasswordMinimum(msg)).toBeNull();
  });
});

describe("checkPasswordMinimum", () => {
  it("passes when the live setting meets the requirement", () => {
    const r = checkPasswordMinimum("Password should be at least 12 characters.", 12);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("12");
  });

  it("FAILS when the setting has drifted below the requirement", () => {
    // Exactly what the first probe returned mid-save during the 2026 cycle.
    const r = checkPasswordMinimum("Password should be at least 6 characters.", 12);
    expect(r.ok).toBe(false);
  });

  it("fails loudly when the minimum cannot be read at all", () => {
    const r = checkPasswordMinimum("unexpected", 12);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("could not read");
  });

  it("says so plainly when the provider returned no message", () => {
    const r = checkPasswordMinimum(null, 12);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("(no message)");
  });
});

describe("checkLegacyTlsRefused", () => {
  it("passes when the handshake is refused", () => {
    expect(checkLegacyTlsRefused("TLS 1.0", false).ok).toBe(true);
  });

  it("fails when a legacy version still negotiates", () => {
    const r = checkLegacyTlsRefused("TLS 1.1", true);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("NEGOTIATED");
  });
});

describe("summarize and formatReport", () => {
  const results = [
    checkCorsHeader("/", ["https://www.newcoworker.com"]),
    checkCorsHeader("/robots.txt", ["*"])
  ];

  it("counts passes and failures", () => {
    expect(summarize(results)).toEqual({ total: 2, passed: 1, failed: 1, ok: false });
  });

  it("is ok only when nothing failed", () => {
    expect(summarize([results[0]]).ok).toBe(true);
    expect(summarize([]).ok).toBe(true);
  });

  it("renders each result with its verdict and SAQ reference", () => {
    const out = formatReport(results);
    expect(out).toContain("PASS");
    expect(out).toContain("FAIL");
    expect(out).toContain("[SAQ 4, 18]");
  });
});

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  auditRetryPlan,
  collectHighAdvisories,
  evaluateAllowlist,
  isSuccessfulAuditReport
} from "../scripts/audit-with-allowlist.mjs";

const IMAGE_SIZE_ALLOWLIST = [
  {
    advisory: "GHSA-w3rx-r6r6-pgpr",
    package: "image-size",
    dir: ".",
    reason: "archived upstream",
    expires: "2026-11-07"
  },
  {
    advisory: "GHSA-5p2g-fcmc-qvqq",
    package: "image-size",
    dir: ".",
    reason: "archived upstream",
    expires: "2026-11-07"
  }
];

function imageSizeReport() {
  return {
    vulnerabilities: {
      "image-size": {
        severity: "high",
        via: [
          {
            source: 1111111,
            name: "image-size",
            title: "image-size has a denial of service",
            severity: "high",
            url: "https://github.com/advisories/GHSA-w3rx-r6r6-pgpr"
          },
          {
            source: 2222222,
            name: "image-size",
            title: "image-size has another denial of service",
            severity: "high",
            url: "https://github.com/advisories/GHSA-5p2g-fcmc-qvqq"
          },
          "pptxgenjs"
        ]
      }
    }
  };
}

describe("isSuccessfulAuditReport", () => {
  it("accepts a real npm audit report even with zero vulnerabilities", () => {
    expect(isSuccessfulAuditReport({ vulnerabilities: {} })).toBe(true);
    expect(isSuccessfulAuditReport(imageSizeReport())).toBe(true);
  });

  it("rejects the 503 maintenance body npm prints as --json", () => {
    // PR #1876: registry maintenance returned this shape. The wrapper used
    // to treat missing `vulnerabilities` as an empty tree and trip STALE
    // on the image-size allowlist entries.
    expect(
      isSuccessfulAuditReport({
        message:
          "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
        statusCode: 503,
        body: { error: "We are currently performing maintenance." },
        error: { summary: "", detail: "" }
      })
    ).toBe(false);
  });

  it("rejects non-objects and array-shaped vulnerabilities", () => {
    expect(isSuccessfulAuditReport(null)).toBe(false);
    expect(isSuccessfulAuditReport("nope")).toBe(false);
    expect(isSuccessfulAuditReport({ vulnerabilities: [] })).toBe(false);
    expect(isSuccessfulAuditReport({ vulnerabilities: null })).toBe(false);
  });
});

describe("collectHighAdvisories", () => {
  it("collects GHSA ids and ignores transitive string via entries", () => {
    const found = collectHighAdvisories(imageSizeReport());
    expect([...found.keys()].sort()).toEqual([
      "GHSA-5p2g-fcmc-qvqq",
      "GHSA-w3rx-r6r6-pgpr"
    ]);
    expect(found.get("GHSA-w3rx-r6r6-pgpr")?.package).toBe("image-size");
  });

  it("skips moderate findings and falls back when there is no GHSA url", () => {
    const found = collectHighAdvisories({
      vulnerabilities: {
        moderatepkg: {
          severity: "moderate",
          via: [{ severity: "moderate", name: "moderatepkg", url: "https://github.com/advisories/GHSA-xxxx-xxxx-xxxx" }]
        },
        numeric: {
          severity: "high",
          via: [{ severity: "critical", name: "numeric", source: 99, url: "https://example.invalid/99" }]
        }
      }
    });
    expect([...found.keys()]).toEqual(["https://example.invalid/99"]);
  });
});

describe("evaluateAllowlist", () => {
  it("is clean when the root tree's image-size advisories are listed and unexpired", () => {
    const { failures, allowlisted } = evaluateAllowlist({
      found: collectHighAdvisories(imageSizeReport()),
      allowlist: IMAGE_SIZE_ALLOWLIST,
      relCwd: ".",
      today: "2026-09-19"
    });
    expect(failures).toEqual([]);
    expect(allowlisted).toHaveLength(2);
  });

  it("does not treat a successful empty tree as a reason to keep scoring 503s as stale", () => {
    const { failures } = evaluateAllowlist({
      found: collectHighAdvisories({ vulnerabilities: {} }),
      allowlist: IMAGE_SIZE_ALLOWLIST,
      relCwd: ".",
      today: "2026-09-19"
    });
    expect(failures.some((f) => f.startsWith("STALE allowlist entry:"))).toBe(true);
  });

  it("does not apply root allowlist entries to another tree", () => {
    const { failures } = evaluateAllowlist({
      found: collectHighAdvisories(imageSizeReport()),
      allowlist: IMAGE_SIZE_ALLOWLIST,
      relCwd: "zapier",
      today: "2026-09-19"
    });
    expect(failures.some((f) => f.startsWith("UNLISTED high+ advisory:"))).toBe(true);
    expect(failures.some((f) => f.startsWith("STALE allowlist entry:"))).toBe(false);
  });

  it("fails expired and unlisted high+ advisories", () => {
    const { failures } = evaluateAllowlist({
      found: collectHighAdvisories(imageSizeReport()),
      allowlist: [
        { ...IMAGE_SIZE_ALLOWLIST[0], expires: "2026-01-01" },
        { ...IMAGE_SIZE_ALLOWLIST[1], advisory: "GHSA-other-other-other" }
      ],
      relCwd: ".",
      today: "2026-09-19"
    });
    expect(failures.some((f) => f.startsWith("EXPIRED allowlist entry: GHSA-w3rx-r6r6-pgpr"))).toBe(
      true
    );
    expect(failures.some((f) => f.startsWith("UNLISTED high+ advisory: GHSA-5p2g-fcmc-qvqq"))).toBe(
      true
    );
  });
});

describe("auditRetryPlan", () => {
  it("defaults to 20 attempts, 20s apart", () => {
    const prevAttempts = process.env.AUDIT_RETRY_ATTEMPTS;
    const prevDelay = process.env.AUDIT_RETRY_DELAY_MS;
    delete process.env.AUDIT_RETRY_ATTEMPTS;
    delete process.env.AUDIT_RETRY_DELAY_MS;
    expect(auditRetryPlan()).toEqual({ attempts: 20, delayMs: 20000 });
    if (prevAttempts === undefined) delete process.env.AUDIT_RETRY_ATTEMPTS;
    else process.env.AUDIT_RETRY_ATTEMPTS = prevAttempts;
    if (prevDelay === undefined) delete process.env.AUDIT_RETRY_DELAY_MS;
    else process.env.AUDIT_RETRY_DELAY_MS = prevDelay;
  });
});

describe("audit-with-allowlist CLI", () => {
  it("exits 2 when npm audit --json is a 503 body, without STALE allowlist noise", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-503-"));
    const stub = join(dir, "npm");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  message: "503 Service Unavailable - POST https://registry.npmjs.org/-/npm/v1/security/advisories/bulk",
  statusCode: 503,
  body: { error: "We are currently performing maintenance." }
}));
process.exit(1);
`
    );
    chmodSync(stub, 0o755);
    try {
      execFileSync("node", ["scripts/audit-with-allowlist.mjs", "--omit=dev"], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          AUDIT_RETRY_ATTEMPTS: "1",
          AUDIT_RETRY_DELAY_MS: "0"
        }
      });
      throw new Error("expected exit 2");
    } catch (err: unknown) {
      expect(err).toMatchObject({ status: 2 });
      const stderr = String((err as { stderr?: string }).stderr ?? "");
      expect(stderr).toContain("npm audit did not return a vulnerability report");
      expect(stderr).toContain("503 Service Unavailable");
      expect(stderr).not.toContain("STALE allowlist entry");
    }
  });

  it("retries a 503 and exits 0 once npm returns a real report", () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-retry-"));
    const countFile = join(dir, "count");
    writeFileSync(countFile, "0");
    const stub = join(dir, "npm");
    writeFileSync(
      stub,
      `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require("node:fs");
const countFile = ${JSON.stringify(countFile)};
const n = Number(readFileSync(countFile, "utf8")) + 1;
writeFileSync(countFile, String(n));
if (n < 3) {
  process.stdout.write(JSON.stringify({
    message: "503 Service Unavailable",
    statusCode: 503
  }));
  process.exit(1);
}
process.stdout.write(JSON.stringify({ vulnerabilities: {} }));
process.exit(0);
`
    );
    chmodSync(stub, 0o755);
    // Empty report on purpose. This case is the retry, not allowlist scoring
    // (evaluateAllowlist covers that). A high finding here would depend on
    // whatever rows .github/audit-allowlist.json happens to hold.
    const out = execFileSync("node", ["scripts/audit-with-allowlist.mjs", "--omit=dev"], {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        AUDIT_RETRY_ATTEMPTS: "4",
        AUDIT_RETRY_DELAY_MS: "0"
      }
    });
    expect(out).toContain("audit clean: 0 allowlisted, 0 unlisted high+ advisories");
    expect(readFileSync(countFile, "utf8")).toBe("3");
  });
});

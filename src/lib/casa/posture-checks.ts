/**
 * Pure evaluation logic for the CASA posture probe
 * (`debug/casa-posture-probe.ts`).
 *
 * Split out from the probe so the judgements are unit tested rather than only
 * exercised by a live network run. The probe does the fetching; everything
 * that decides pass or fail lives here.
 *
 * Every check names the SAQ point it evidences, because the point of the probe
 * is to re-prove the questionnaire mechanically at reassessment time instead
 * of re-deriving it by hand. The 2026 cycle answered several controls from
 * memory and got two of them wrong, which is the failure this module exists to
 * prevent.
 */

export type CheckResult = {
  /** Stable id, so a report can be diffed between years. */
  id: string;
  label: string;
  ok: boolean;
  /** What was actually observed. Always populated, pass or fail. */
  detail: string;
  /** SAQ point(s) this evidences, for the reassessment packet. */
  saq: string;
};

/**
 * The 2026 assessment's most expensive lesson.
 *
 * Vercel's static serving replaces our `Access-Control-Allow-Origin` with `*`
 * ONLY when the request carries an `Origin` header. A plain curl shows the
 * correct value and looks fixed, so the wildcard survived one deploy and was
 * caught only because a scanner sends `Origin`. Any CORS check that does not
 * send one is worthless.
 */
export function checkCorsHeader(path: string, values: string[]): CheckResult {
  const wildcard = values.includes("*");
  const duplicated = values.length > 1;

  return {
    id: `cors:${path}`,
    label: `CORS on ${path}`,
    ok: !wildcard && !duplicated,
    detail: values.length === 0
      ? "no Access-Control-Allow-Origin (fine)"
      : wildcard
        ? `WILDCARD: ${values.join(", ")}`
        : duplicated
          ? `duplicated header: ${values.join(" | ")}`
          : values[0],
    saq: "4, 18"
  };
}

/** HSTS must be present on the secure response with a meaningful max-age. */
export function checkHsts(value: string | null, minMaxAgeSeconds = 31_536_000): CheckResult {
  if (!value) {
    return { id: "hsts", label: "HSTS", ok: false, detail: "header absent", saq: "53" };
  }
  const match = /max-age=(\d+)/i.exec(value);
  const maxAge = match ? Number(match[1]) : 0;

  return {
    id: "hsts",
    label: "HSTS",
    ok: maxAge >= minMaxAgeSeconds,
    detail: maxAge >= minMaxAgeSeconds
      ? value
      : `max-age=${maxAge} is below the required ${minMaxAgeSeconds}`,
    saq: "53"
  };
}

/** The baseline response headers the SAQ claims are set. */
export const BASELINE_HEADERS = [
  "x-content-type-options",
  "x-frame-options",
  "referrer-policy",
  "permissions-policy",
  "content-security-policy"
] as const;

export function checkBaselineHeaders(get: (name: string) => string | null): CheckResult[] {
  return BASELINE_HEADERS.map((name) => {
    const value = get(name);
    return {
      id: `header:${name}`,
      label: name,
      ok: Boolean(value),
      detail: value ?? "absent",
      saq: "17, 18"
    };
  });
}

/**
 * Paths that must not be readable. A 200 here is the real version of the
 * "Source Code Disclosure" finding the 2026 scan raised as a false positive;
 * this is how we keep proving it stays false.
 */
export const DISCLOSURE_PATHS = [
  "/.git/config",
  "/.env",
  "/package.json",
  "/next.config.ts"
] as const;

export function checkDisclosurePath(path: string, status: number | null): CheckResult {
  // A request that never completed proves nothing. Reporting it as a pass
  // would put "not served" in an assessor's evidence pack on the strength of a
  // timeout, which is the exact false assurance this probe exists to avoid.
  if (status === null) {
    return {
      id: `disclosure:${path}`,
      label: `${path} not served`,
      ok: false,
      detail: "request failed, not verified",
      saq: "2"
    };
  }

  return {
    id: `disclosure:${path}`,
    label: `${path} not served`,
    // Anything that is not a 2xx is acceptable: 404, 403 and edge challenges
    // all mean the file is not being handed out.
    ok: status < 200 || status >= 300,
    detail: `HTTP ${status}`,
    saq: "2"
  };
}

/**
 * RFC 9116 security.txt. `Expires` in the past is worse than no file at all,
 * because scanners read it as an abandoned disclosure policy.
 */
export function checkSecurityTxt(body: string, now: Date): CheckResult {
  const required = ["Contact:", "Expires:", "Policy:"];
  const missing = required.filter((field) => !body.includes(field));
  if (missing.length > 0) {
    return {
      id: "security-txt",
      label: "security.txt",
      ok: false,
      detail: `missing field(s): ${missing.join(", ")}`,
      saq: "policy"
    };
  }

  const expires = /^Expires:\s*(.+)$/m.exec(body)?.[1]?.trim();
  const parsed = expires ? Date.parse(expires) : NaN;
  if (Number.isNaN(parsed)) {
    return {
      id: "security-txt",
      label: "security.txt",
      ok: false,
      detail: `unparseable Expires: ${expires ?? "(none)"}`,
      saq: "policy"
    };
  }

  const future = parsed > now.getTime();
  return {
    id: "security-txt",
    label: "security.txt",
    ok: future,
    detail: future
      ? `valid, expires ${new Date(parsed).toISOString().slice(0, 10)}`
      : `EXPIRED on ${new Date(parsed).toISOString().slice(0, 10)}`,
    saq: "policy"
  };
}

/**
 * GoTrue reports the configured minimum in its rejection message, so a
 * deliberately too-short password reads the live setting back without creating
 * anything. Supabase's own floor is 6 characters, so a 5-character probe
 * cannot succeed under any configuration.
 */
export function parseConfiguredPasswordMinimum(message: string | null | undefined): number | null {
  if (!message) return null;
  const match = /at least (\d+) characters/i.exec(message);
  return match ? Number(match[1]) : null;
}

export function checkPasswordMinimum(
  message: string | null | undefined,
  required: number
): CheckResult {
  const configured = parseConfiguredPasswordMinimum(message);
  return {
    id: "password-minimum",
    label: "password minimum",
    ok: configured !== null && configured >= required,
    detail: configured === null
      ? `could not read the minimum from: ${message ?? "(no message)"}`
      : `configured minimum is ${configured}`,
    saq: "19"
  };
}

/** TLS versions that must be refused. */
export function checkLegacyTlsRefused(version: string, connected: boolean): CheckResult {
  return {
    id: `tls:${version}`,
    label: `${version} refused`,
    ok: !connected,
    detail: connected ? `NEGOTIATED ${version}` : `refused, as required`,
    saq: "53"
  };
}

export type Summary = { total: number; passed: number; failed: number; ok: boolean };

export function summarize(results: CheckResult[]): Summary {
  const failed = results.filter((r) => !r.ok).length;
  return {
    total: results.length,
    passed: results.length - failed,
    failed,
    ok: failed === 0
  };
}

/** Fixed-width report body, so year-on-year runs diff cleanly. */
export function formatReport(results: CheckResult[]): string {
  const width = Math.max(...results.map((r) => r.label.length), 10);
  return results
    .map((r) => `${r.ok ? "PASS" : "FAIL"}  ${r.label.padEnd(width)}  ${r.detail}  [SAQ ${r.saq}]`)
    .join("\n");
}

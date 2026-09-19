export function isSuccessfulAuditReport(
  report: unknown
): report is { vulnerabilities: Record<string, unknown> };

export function auditRetryPlan(): { attempts: number; delayMs: number };

export type HighAdvisory = {
  id: string;
  package: string;
  title: string;
};

export function collectHighAdvisories(report: {
  vulnerabilities: Record<string, { severity?: string; via?: unknown }>;
}): Map<string, HighAdvisory>;

export type AllowlistEntry = {
  advisory: string;
  package: string;
  dir?: string;
  reason: string;
  expires: string;
};

export function evaluateAllowlist(args: {
  found: Map<string, HighAdvisory>;
  allowlist: AllowlistEntry[];
  relCwd: string;
  today: string;
}): { failures: string[]; allowlisted: string[] };

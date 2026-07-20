/**
 * Minimal Google BigQuery REST client (service-account auth, zero deps).
 *
 * Purpose-built for the Gemini billed-actuals sync: Google exposes no direct
 * spend API for the Gemini API, so billed cost comes from the Cloud Billing
 * export table in BigQuery, queried with one aggregate SQL statement a day.
 * That needs exactly two calls — a service-account JWT exchanged for an
 * access token, and `jobs.query` — so a hand-rolled client beats pulling in
 * google-auth-library + @google-cloud/bigquery for it.
 *
 * Auth: RS256 self-signed JWT (node:crypto) → https://oauth2.googleapis.com/token
 * (RFC 7523 assertion flow), scope `bigquery.readonly`.
 */

import { createSign } from "node:crypto";

export type GcpServiceAccountKey = {
  client_email: string;
  private_key: string;
  project_id: string;
};

/**
 * Parse the service-account key JSON out of an env var. Returns null when
 * missing or unusable (the sync then records "not configured" and skips).
 */
export function parseGcpServiceAccountKey(raw: string | null | undefined): GcpServiceAccountKey | null {
  if (!raw || raw.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const clientEmail = parsed.client_email;
    const privateKey = parsed.private_key;
    const projectId = parsed.project_id;
    if (
      typeof clientEmail !== "string" ||
      clientEmail.length === 0 ||
      typeof privateKey !== "string" ||
      privateKey.length === 0 ||
      typeof projectId !== "string" ||
      projectId.length === 0
    ) {
      return null;
    }
    return { client_email: clientEmail, private_key: privateKey, project_id: projectId };
  } catch {
    return null;
  }
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

/** RS256 service-account JWT for the OAuth2 assertion flow. */
export function buildServiceAccountJwt(
  key: GcpServiceAccountKey,
  scope: string,
  nowMs: number
): string {
  const iat = Math.floor(nowMs / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64Url(
    JSON.stringify({
      iss: key.client_email,
      scope,
      aud: "https://oauth2.googleapis.com/token",
      iat,
      exp: iat + 3600
    })
  );
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(key.private_key).toString("base64url");
  return `${header}.${claims}.${signature}`;
}

export const BIGQUERY_READONLY_SCOPE = "https://www.googleapis.com/auth/bigquery.readonly";

/** Exchange a service-account JWT for a bearer token. Throws on any failure. */
export async function fetchGoogleAccessToken(params: {
  key: GcpServiceAccountKey;
  scope: string;
  fetchImpl?: typeof fetch;
  nowMs?: number;
}): Promise<string> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const assertion = buildServiceAccountJwt(params.key, params.scope, params.nowMs ?? Date.now());
  const res = await fetchImpl("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    }).toString()
  });
  if (!res.ok) {
    const body = (await res.text()).slice(0, 300);
    throw new Error(`google token exchange: HTTP ${res.status} ${body}`);
  }
  const parsed = (await res.json()) as { access_token?: unknown };
  if (typeof parsed.access_token !== "string" || parsed.access_token.length === 0) {
    throw new Error("google token exchange: no access_token in response");
  }
  return parsed.access_token;
}

type BigQueryRawRow = { f?: Array<{ v?: unknown }> };

type BigQueryQueryResponse = {
  jobComplete?: boolean;
  schema?: { fields?: Array<{ name?: string }> };
  rows?: BigQueryRawRow[];
  pageToken?: string;
  jobReference?: { projectId?: string; jobId?: string; location?: string };
  totalRows?: string;
};

function mapRows(
  fields: Array<{ name?: string }>,
  rows: BigQueryRawRow[] | undefined
): Array<Record<string, string | null>> {
  const out: Array<Record<string, string | null>> = [];
  for (const row of rows ?? []) {
    const mapped: Record<string, string | null> = {};
    fields.forEach((field, i) => {
      const value = row.f?.[i]?.v;
      mapped[field.name ?? `f${i}`] = typeof value === "string" ? value : null;
    });
    out.push(mapped);
  }
  return out;
}

/**
 * Run one standard-SQL query via `jobs.query`, following `pageToken` pages
 * through `getQueryResults` until drained. Returns rows as name → string
 * maps (BigQuery's JSON wire format stringifies every scalar). Throws on
 * HTTP errors and on a job that misses the completion timeout — the daily
 * sync records the error and retries tomorrow rather than persisting a
 * partial window.
 */
export async function bigQueryQuery(params: {
  key: GcpServiceAccountKey;
  query: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<Array<Record<string, string | null>>> {
  const fetchImpl = params.fetchImpl ?? fetch;
  const token = await fetchGoogleAccessToken({
    key: params.key,
    scope: BIGQUERY_READONLY_SCOPE,
    fetchImpl
  });
  const project = encodeURIComponent(params.key.project_id);

  const first = await fetchImpl(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({
      query: params.query,
      useLegacySql: false,
      timeoutMs: params.timeoutMs ?? 60_000
    })
  });
  if (!first.ok) {
    const body = (await first.text()).slice(0, 300);
    throw new Error(`bigquery jobs.query: HTTP ${first.status} ${body}`);
  }
  let page = (await first.json()) as BigQueryQueryResponse;
  if (page.jobComplete !== true) {
    throw new Error("bigquery jobs.query: job did not complete within the timeout");
  }

  const fields = page.schema?.fields ?? [];
  const rows = mapRows(fields, page.rows);

  while (typeof page.pageToken === "string" && page.pageToken.length > 0) {
    const jobId = page.jobReference?.jobId;
    if (!jobId) throw new Error("bigquery jobs.query: paginated response missing jobReference");
    const qs = new URLSearchParams({ pageToken: page.pageToken });
    const location = page.jobReference?.location;
    if (location) qs.set("location", location);
    const next = await fetchImpl(
      `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/queries/${encodeURIComponent(jobId)}?${qs.toString()}`,
      { headers: { Authorization: `Bearer ${token}` } }
    );
    if (!next.ok) {
      const body = (await next.text()).slice(0, 300);
      throw new Error(`bigquery getQueryResults: HTTP ${next.status} ${body}`);
    }
    const parsed = (await next.json()) as BigQueryQueryResponse;
    rows.push(...mapRows(fields, parsed.rows));
    page = { ...parsed, jobReference: page.jobReference };
  }

  return rows;
}

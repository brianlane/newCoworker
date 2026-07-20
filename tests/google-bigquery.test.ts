import { describe, it, expect, vi, afterEach } from "vitest";
import { createVerify, generateKeyPairSync } from "node:crypto";
import {
  BIGQUERY_READONLY_SCOPE,
  bigQueryQuery,
  buildServiceAccountJwt,
  fetchGoogleAccessToken,
  parseGcpServiceAccountKey,
  type GcpServiceAccountKey
} from "@/lib/google/bigquery";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const KEY: GcpServiceAccountKey = {
  client_email: "sync@newcoworker-billing.iam.gserviceaccount.com",
  private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  project_id: "newcoworker-billing"
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseGcpServiceAccountKey", () => {
  it("parses a full service-account key JSON", () => {
    expect(parseGcpServiceAccountKey(JSON.stringify(KEY))).toEqual(KEY);
  });

  it("returns null for missing/empty/unparseable/incomplete values", () => {
    expect(parseGcpServiceAccountKey(undefined)).toBeNull();
    expect(parseGcpServiceAccountKey(null)).toBeNull();
    expect(parseGcpServiceAccountKey("  ")).toBeNull();
    expect(parseGcpServiceAccountKey("not-json")).toBeNull();
    expect(parseGcpServiceAccountKey(JSON.stringify({ client_email: "a@b" }))).toBeNull();
    expect(
      parseGcpServiceAccountKey(JSON.stringify({ ...KEY, project_id: "" }))
    ).toBeNull();
    expect(parseGcpServiceAccountKey(JSON.stringify({ ...KEY, private_key: 7 }))).toBeNull();
  });
});

describe("buildServiceAccountJwt", () => {
  it("emits an RS256 JWT with the assertion-flow claims, verifiable with the public key", () => {
    const nowMs = Date.parse("2026-07-19T00:00:00Z");
    const jwt = buildServiceAccountJwt(KEY, BIGQUERY_READONLY_SCOPE, nowMs);
    const [header, claims, signature] = jwt.split(".");
    expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
      alg: "RS256",
      typ: "JWT"
    });
    expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({
      iss: KEY.client_email,
      scope: BIGQUERY_READONLY_SCOPE,
      aud: "https://oauth2.googleapis.com/token",
      iat: nowMs / 1000,
      exp: nowMs / 1000 + 3600
    });
    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    expect(verifier.verify(publicKey, Buffer.from(signature, "base64url"))).toBe(true);
  });
});

describe("fetchGoogleAccessToken", () => {
  it("exchanges the JWT for a bearer token", async () => {
    const fetchImpl = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
      expect(body).toContain("assertion=");
      return jsonResponse({ access_token: "tok-1" });
    });
    const token = await fetchGoogleAccessToken({
      key: KEY,
      scope: BIGQUERY_READONLY_SCOPE,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      nowMs: Date.now()
    });
    expect(token).toBe("tok-1");
    expect(String(vi.mocked(fetchImpl).mock.calls[0][0])).toBe(
      "https://oauth2.googleapis.com/token"
    );
  });

  it("throws on a non-OK exchange and on a missing access_token", async () => {
    await expect(
      fetchGoogleAccessToken({
        key: KEY,
        scope: BIGQUERY_READONLY_SCOPE,
        fetchImpl: (async () => new Response("denied", { status: 403 })) as typeof fetch
      })
    ).rejects.toThrow(/HTTP 403/);
    await expect(
      fetchGoogleAccessToken({
        key: KEY,
        scope: BIGQUERY_READONLY_SCOPE,
        fetchImpl: (async () => jsonResponse({ nope: true })) as typeof fetch
      })
    ).rejects.toThrow(/no access_token/);
  });

  it("uses global fetch when no fetchImpl is provided", async () => {
    const stub = vi.fn(async () => jsonResponse({ access_token: "tok-global" }));
    vi.stubGlobal("fetch", stub);
    const token = await fetchGoogleAccessToken({ key: KEY, scope: BIGQUERY_READONLY_SCOPE });
    expect(token).toBe("tok-global");
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("bigQueryQuery", () => {
  const schema = { fields: [{ name: "day" }, { name: "project_id" }, { name: "cost" }] };

  function tokenThen(pages: Response[]): typeof fetch {
    let call = 0;
    return (async () => {
      if (call === 0) {
        call += 1;
        return jsonResponse({ access_token: "tok" });
      }
      const page = pages[Math.min(call - 1, pages.length - 1)];
      call += 1;
      return page.clone();
    }) as unknown as typeof fetch;
  }

  it("maps schema fields onto stringly-typed rows", async () => {
    const rows = await bigQueryQuery({
      key: KEY,
      query: "SELECT 1",
      fetchImpl: tokenThen([
        jsonResponse({
          jobComplete: true,
          schema,
          rows: [
            { f: [{ v: "2026-07-18" }, { v: "gen-lang-client-1" }, { v: "1.23" }] },
            // Non-string value (BigQuery nulls) → null; missing cell → null.
            { f: [{ v: "2026-07-19" }, { v: null }] }
          ]
        })
      ])
    });
    expect(rows).toEqual([
      { day: "2026-07-18", project_id: "gen-lang-client-1", cost: "1.23" },
      { day: "2026-07-19", project_id: null, cost: null }
    ]);
  });

  it("handles a rows-less completion and a schema with unnamed fields", async () => {
    const rows = await bigQueryQuery({
      key: KEY,
      query: "SELECT 1",
      fetchImpl: tokenThen([jsonResponse({ jobComplete: true })])
    });
    expect(rows).toEqual([]);
    const unnamed = await bigQueryQuery({
      key: KEY,
      query: "SELECT 1",
      fetchImpl: tokenThen([
        jsonResponse({ jobComplete: true, schema: { fields: [{}] }, rows: [{ f: [{ v: "x" }] }] })
      ])
    });
    expect(unnamed).toEqual([{ f0: "x" }]);
  });

  it("follows pageToken pages through getQueryResults (with and without location)", async () => {
    const fetchImpl = vi.fn(tokenThen([
      jsonResponse({
        jobComplete: true,
        schema,
        rows: [{ f: [{ v: "2026-07-17" }, { v: "p" }, { v: "1" }] }],
        pageToken: "next-1",
        jobReference: { projectId: KEY.project_id, jobId: "job-1", location: "US" }
      }),
      jsonResponse({
        rows: [{ f: [{ v: "2026-07-18" }, { v: "p" }, { v: "2" }] }],
        pageToken: "next-2"
      }),
      jsonResponse({ rows: [{ f: [{ v: "2026-07-19" }, { v: "p" }, { v: "3" }] }] })
    ]));
    const rows = await bigQueryQuery({
      key: KEY,
      query: "SELECT 1",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(rows.map((r) => r.day)).toEqual(["2026-07-17", "2026-07-18", "2026-07-19"]);
    // Page 2 keeps the job reference from page 1 (location included).
    const pageUrl = String(vi.mocked(fetchImpl).mock.calls[2][0]);
    expect(pageUrl).toContain("/queries/job-1?");
    expect(pageUrl).toContain("pageToken=next-1");
    expect(pageUrl).toContain("location=US");
    const pageUrl2 = String(vi.mocked(fetchImpl).mock.calls[3][0]);
    expect(pageUrl2).toContain("pageToken=next-2");
  });

  it("omits the location param when the job reference has none", async () => {
    const fetchImpl = vi.fn(tokenThen([
      jsonResponse({
        jobComplete: true,
        schema,
        rows: [],
        pageToken: "next-1",
        jobReference: { projectId: KEY.project_id, jobId: "job-9" }
      }),
      jsonResponse({ rows: [] })
    ]));
    await bigQueryQuery({ key: KEY, query: "SELECT 1", fetchImpl: fetchImpl as unknown as typeof fetch });
    const pageUrl = String(vi.mocked(fetchImpl).mock.calls[2][0]);
    expect(pageUrl).not.toContain("location=");
  });

  it("throws on HTTP errors, incomplete jobs, paging errors, and a missing jobReference", async () => {
    await expect(
      bigQueryQuery({
        key: KEY,
        query: "SELECT 1",
        fetchImpl: tokenThen([new Response("bad query", { status: 400 })])
      })
    ).rejects.toThrow(/jobs.query: HTTP 400/);
    await expect(
      bigQueryQuery({
        key: KEY,
        query: "SELECT 1",
        fetchImpl: tokenThen([jsonResponse({ jobComplete: false })])
      })
    ).rejects.toThrow(/did not complete/);
    await expect(
      bigQueryQuery({
        key: KEY,
        query: "SELECT 1",
        fetchImpl: tokenThen([
          jsonResponse({ jobComplete: true, schema, rows: [], pageToken: "t" })
        ])
      })
    ).rejects.toThrow(/missing jobReference/);
    await expect(
      bigQueryQuery({
        key: KEY,
        query: "SELECT 1",
        fetchImpl: tokenThen([
          jsonResponse({
            jobComplete: true,
            schema,
            rows: [],
            pageToken: "t",
            jobReference: { jobId: "job-1" }
          }),
          new Response("page down", { status: 500 })
        ])
      })
    ).rejects.toThrow(/getQueryResults: HTTP 500/);
  });

  it("uses global fetch and the default timeout when no fetchImpl is provided", async () => {
    const stub = vi.fn(tokenThen([jsonResponse({ jobComplete: true, schema, rows: [] })]));
    vi.stubGlobal("fetch", stub);
    expect(await bigQueryQuery({ key: KEY, query: "SELECT 1" })).toEqual([]);
    const body = JSON.parse(String(vi.mocked(stub).mock.calls[1][1]?.body));
    expect(body).toMatchObject({ query: "SELECT 1", useLegacySql: false, timeoutMs: 60_000 });
  });

  it("passes a custom timeout through", async () => {
    const fetchImpl = vi.fn(tokenThen([jsonResponse({ jobComplete: true, schema, rows: [] })]));
    await bigQueryQuery({
      key: KEY,
      query: "SELECT 1",
      timeoutMs: 5_000,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const body = JSON.parse(String(vi.mocked(fetchImpl).mock.calls[1][1]?.body));
    expect(body.timeoutMs).toBe(5_000);
  });
});

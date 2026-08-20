import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  actBrowseDemo,
  startBrowseDemo,
  stopBrowseDemo
} from "@/lib/ai-flows/demo-session";

const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DEMO_ID = "7e5a3f1c-9a3b-4a44-8a1e-2f6d5c4b3a21";
const URL_OK = "https://portal.example.com/lead/7";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

function fetchReturning(body: unknown, status = 200) {
  return vi.fn(async () => jsonResponse(body, status)) as unknown as typeof fetch & {
    mock: { calls: unknown[][] };
  };
}

const PAGE_HTML = '<button>Provide Update</button><a href="/leads/9">Aurora Anthony</a>';

beforeEach(() => {
  process.env.AIFLOW_RENDER_URL_TEMPLATE = "https://render-{businessId}.example.com/render";
  process.env.AIFLOW_RENDER_TOKEN = "tok-123";
});

afterEach(() => {
  delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
  delete process.env.AIFLOW_RENDER_TOKEN;
  vi.restoreAllMocks();
});

/**
 * Every browse route that waits on the render sidecar must give the PLATFORM
 * a longer budget than the lib gives itself, or the request is cut before the
 * lib's own abort can answer.
 *
 * Bugbot found this on the demonstration routes (PR #1554) and it was true of
 * the two older ones as well. It matters most on /demo/act: the sidecar
 * performs the interaction FOR REAL, so a platform cut leaves a click that
 * happened on the vendor's page, was never recorded, and was reported to the
 * owner as a failure to reach the service. The lib's abort must always be
 * what fires first.
 */
describe("the browse routes' duration budgets", () => {
  const ROUTES: { path: string; libTimeoutMs: number }[] = [
    { path: "src/app/api/aiflows/demo/start/route.ts", libTimeoutMs: 120_000 },
    { path: "src/app/api/aiflows/demo/act/route.ts", libTimeoutMs: 120_000 },
    { path: "src/app/api/aiflows/demo/stop/route.ts", libTimeoutMs: 120_000 },
    { path: "src/app/api/aiflows/check-actions/route.ts", libTimeoutMs: 120_000 },
    { path: "src/app/api/aiflows/probe-page/route.ts", libTimeoutMs: 90_000 }
  ];

  it.each(ROUTES)("$path outlasts its lib abort", ({ path, libTimeoutMs }) => {
    const source = readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
    const declared = /export const maxDuration = (\d+)/.exec(source)?.[1];
    expect(declared, `${path} declares no maxDuration`).toBeTruthy();
    expect(Number(declared) * 1000).toBeGreaterThan(libTimeoutMs);
  });
});

describe("startBrowseDemo", () => {
  it("opens the session on the tenant's own /demo/start path, label riding as auth", async () => {
    const fetchImpl = fetchReturning({
      demoId: DEMO_ID,
      loggedIn: true,
      finalUrl: URL_OK,
      html: PAGE_HTML,
      text: "Provide Update Aurora Anthony",
      screenshotBase64: "abc123",
      diagnostics: { consoleErrors: ["boom"] }
    });

    const result = await startBrowseDemo(BIZ, URL_OK, {
      integrationLabel: "Clever",
      fetchImpl
    });

    expect(result).toMatchObject({
      ok: true,
      demoId: DEMO_ID,
      loggedIn: true,
      finalUrl: URL_OK,
      pageText: "Provide Update Aurora Anthony",
      screenshotBase64: "abc123",
      diagnostics: { consoleErrors: ["boom"] }
    });
    if (!result.ok) return;
    // The html is digested into pickable controls, same as the page picker.
    expect(result.digest.controls.some((c) => c.target === "Provide Update")).toBe(true);
    const [endpoint, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(`https://render-${BIZ}.example.com/demo/start`);
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({ businessId: BIZ, url: URL_OK, auth: { integrationLabel: "Clever" } });
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("omits auth entirely for a public page, and the bearer when unset", async () => {
    delete process.env.AIFLOW_RENDER_TOKEN;
    const fetchImpl = fetchReturning({ demoId: DEMO_ID, html: "", text: "" });

    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl });

    expect(result).toMatchObject({ ok: true, loggedIn: false });
    if (!result.ok) return;
    // A body with no finalUrl falls back to the requested address, and no
    // screenshot/diagnostics keys appear when the sidecar sent none.
    expect(result.finalUrl).toBe(URL_OK);
    expect(result).not.toHaveProperty("screenshotBase64");
    expect(result).not.toHaveProperty("diagnostics");
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).not.toHaveProperty("auth");
    expect(init.headers as Record<string, string>).not.toHaveProperty("Authorization");
  });

  it("refuses a non-public address before anything reaches the sidecar", async () => {
    const fetchImpl = fetchReturning({});
    for (const bad of ["notaurl", "ftp://x/", "http://localhost/x", "http://10.0.0.8/x"]) {
      const result = await startBrowseDemo(BIZ, bad, { fetchImpl });
      expect(result).toMatchObject({ ok: false, error: "unsafe_url" });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("says not_configured when the platform has no render template", async () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl: fetchReturning({}) });
    expect(result).toEqual({ ok: false, error: "not_configured" });
  });

  it("maps a 404 to not_updated: the stale-box answer, not a bad address", async () => {
    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl: fetchReturning({}, 404) });
    expect(result).toEqual({ ok: false, error: "not_updated" });
  });

  it("maps a non-2xx to render_failed with the status named", async () => {
    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl: fetchReturning({}, 502) });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "sidecar http 502" });
  });

  it("classifies the sidecar's 200-with-error bodies", async () => {
    const login = await startBrowseDemo(BIZ, URL_OK, {
      fetchImpl: fetchReturning({ error: "login_failed", detail: "submit=none enabled=false" })
    });
    expect(login).toMatchObject({ ok: false, error: "login_failed", detail: "submit=none enabled=false" });

    const loginNoDetail = await startBrowseDemo(BIZ, URL_OK, {
      fetchImpl: fetchReturning({ error: "login_failed" })
    });
    expect(loginNoDetail).toEqual({ ok: false, error: "login_failed" });

    const limit = await startBrowseDemo(BIZ, URL_OK, {
      fetchImpl: fetchReturning({ error: "demo_limit" })
    });
    expect(limit).toEqual({ ok: false, error: "demo_limit" });

    const limitWithDetail = await startBrowseDemo(BIZ, URL_OK, {
      fetchImpl: fetchReturning({ error: "demo_limit", detail: "2 sessions live" })
    });
    expect(limitWithDetail).toEqual({ ok: false, error: "demo_limit", detail: "2 sessions live" });

    // auth_config_error folds into render_failed, the detail says which.
    const config = await startBrowseDemo(BIZ, URL_OK, {
      fetchImpl: fetchReturning({ error: "auth_config_error", detail: "credentials_lookup_failed" })
    });
    expect(config).toMatchObject({ ok: false, error: "render_failed", detail: "credentials_lookup_failed" });

    const bare = await startBrowseDemo(BIZ, URL_OK, {
      fetchImpl: fetchReturning({ error: "render_failed" })
    });
    expect(bare).toMatchObject({ ok: false, error: "render_failed", detail: "render_failed" });
  });

  it("treats a body without a demoId as malformed", async () => {
    const noId = await startBrowseDemo(BIZ, URL_OK, { fetchImpl: fetchReturning({ html: "" }) });
    expect(noId).toMatchObject({ ok: false, error: "render_failed", detail: "malformed sidecar response" });
    const nullBody = await startBrowseDemo(BIZ, URL_OK, { fetchImpl: fetchReturning(null) });
    expect(nullBody).toMatchObject({ ok: false, error: "render_failed" });
  });

  it("treats a non-JSON 200 as malformed (a tunnel interstitial, not the sidecar)", async () => {
    const fetchImpl = vi.fn(async () =>
      ({
        ok: true,
        status: 200,
        json: async () => {
          throw new Error("Unexpected token < in JSON");
        }
      }) as unknown as Response
    ) as unknown as typeof fetch;
    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "malformed sidecar response" });
  });

  it("reports a network failure as render_failed with the reason", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("socket hang up");
    }) as unknown as typeof fetch;
    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "socket hang up" });
  });

  it("stringifies a non-Error throw", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "wat";
    }) as unknown as typeof fetch;
    const result = await startBrowseDemo(BIZ, URL_OK, { fetchImpl });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "wat" });
  });
});

describe("actBrowseDemo", () => {
  it("sends the action to /demo/act and digests the recorded turn", async () => {
    const fetchImpl = fetchReturning({
      recorded: { kind: "click_text", target: "Offers", value: "" },
      actionsCount: 3,
      finalUrl: `${URL_OK}/offers`,
      html: PAGE_HTML,
      text: "after",
      screenshotBase64: "shot",
      diagnostics: { failedRequests: ["HTTP 500 GET x"] }
    });

    const result = await actBrowseDemo(
      BIZ,
      DEMO_ID,
      { kind: "click_text", target: "Offers" },
      { fetchImpl }
    );

    expect(result).toMatchObject({
      ok: true,
      outcome: "recorded",
      recorded: { kind: "click_text", target: "Offers", value: "" },
      actionsCount: 3,
      finalUrl: `${URL_OK}/offers`,
      pageText: "after",
      screenshotBase64: "shot",
      diagnostics: { failedRequests: ["HTTP 500 GET x"] }
    });
    const [endpoint, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(`https://render-${BIZ}.example.com/demo/act`);
    const sent = JSON.parse(String(init.body));
    expect(sent).toEqual({
      businessId: BIZ,
      demoId: DEMO_ID,
      action: { kind: "click_text", target: "Offers" }
    });
    // No confirm key unless the caller confirmed: the sidecar's gate must see
    // the true state, not a default.
    expect(sent).not.toHaveProperty("confirm");
  });

  it("carries confirm: true through when the owner confirmed", async () => {
    const fetchImpl = fetchReturning({
      recorded: { kind: "click_text", target: "Submit Update", value: "" },
      actionsCount: 4,
      html: "",
      text: ""
    });
    const result = await actBrowseDemo(
      BIZ,
      DEMO_ID,
      { kind: "click_text", target: "Submit Update" },
      { fetchImpl, confirm: true }
    );
    expect(result).toMatchObject({ ok: true, outcome: "recorded" });
    if (!result.ok || result.outcome !== "recorded") return;
    // finalUrl falls back to empty when the sidecar omitted it (the panel
    // keeps rendering from the previous turn's address).
    expect(result.finalUrl).toBe("");
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body));
    expect(sent.confirm).toBe(true);
  });

  it("says not_configured / not_updated / render_failed for transport failures", async () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, { fetchImpl: fetchReturning({}) })
    ).toEqual({ ok: false, error: "not_configured" });
    process.env.AIFLOW_RENDER_URL_TEMPLATE = "https://render-{businessId}.example.com/render";

    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, { fetchImpl: fetchReturning({}, 404) })
    ).toEqual({ ok: false, error: "not_updated" });

    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, { fetchImpl: fetchReturning({}, 500) })
    ).toMatchObject({ ok: false, error: "render_failed" });
  });

  it("turns unknown_demo and demo_gone into the demo_gone outcome (a turn, not an error)", async () => {
    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning({ error: "unknown_demo" })
      })
    ).toEqual({ ok: true, outcome: "demo_gone" });

    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning({ error: "demo_gone", detail: "Target closed" })
      })
    ).toEqual({ ok: true, outcome: "demo_gone", detail: "Target closed" });

    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning({ error: "demo_gone" })
      })
    ).toEqual({ ok: true, outcome: "demo_gone" });
  });

  it("passes the action cap through as its own outcome", async () => {
    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning({ error: "action_cap" })
      })
    ).toEqual({ ok: true, outcome: "action_cap" });
  });

  it("hands needs_confirm back with the resolved action and its label", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_point", x: 10, y: 20 }, {
      fetchImpl: fetchReturning({
        error: "needs_confirm",
        resolved: { kind: "click_selector", target: '[data-test="claim"]', value: "" },
        label: "Claim this lead"
      })
    });
    expect(result).toEqual({
      ok: true,
      outcome: "needs_confirm",
      resolved: { kind: "click_selector", target: '[data-test="claim"]', value: "" },
      label: "Claim this lead"
    });
  });

  it("falls back to the resolved target when needs_confirm carries no label", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "Accept" }, {
      fetchImpl: fetchReturning({
        error: "needs_confirm",
        resolved: { kind: "click_text", target: "Accept" }
      })
    });
    expect(result).toMatchObject({ ok: true, outcome: "needs_confirm", label: "Accept" });
  });

  it("treats a needs_confirm without a usable resolved action as malformed", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_point", x: 1, y: 2 }, {
      fetchImpl: fetchReturning({ error: "needs_confirm", resolved: { kind: 7 } })
    });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "malformed sidecar response" });
  });

  it("passes resolve_failed reasons through, filtering options to strings", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_point", x: 1, y: 2 }, {
      fetchImpl: fetchReturning({
        error: "resolve_failed",
        reason: "select_needs_option",
        options: ["9", 7, "10"]
      })
    });
    expect(result).toEqual({
      ok: true,
      outcome: "resolve_failed",
      reason: "select_needs_option",
      options: ["9", "10"]
    });

    const bare = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_point", x: 1, y: 2 }, {
      fetchImpl: fetchReturning({ error: "resolve_failed", reason: "ambiguous", detail: "two matches" })
    });
    expect(bare).toEqual({ ok: true, outcome: "resolve_failed", reason: "ambiguous", detail: "two matches" });
  });

  it("treats an unknown resolve reason as malformed rather than inventing one", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_point", x: 1, y: 2 }, {
      fetchImpl: fetchReturning({ error: "resolve_failed", reason: "novel_reason" })
    });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "malformed sidecar response" });
  });

  it("carries an action failure's after-state so the owner can see where it stuck", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "Next" }, {
      fetchImpl: fetchReturning({
        error: "action_failed",
        detail: 'click_text "Next": no matching control on the page',
        finalUrl: URL_OK,
        html: PAGE_HTML,
        text: "stuck here",
        screenshotBase64: "stuckshot"
      })
    });
    expect(result).toMatchObject({
      ok: true,
      outcome: "action_failed",
      detail: 'click_text "Next": no matching control on the page',
      finalUrl: URL_OK,
      pageText: "stuck here",
      screenshotBase64: "stuckshot"
    });

    const bare = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "Next" }, {
      fetchImpl: fetchReturning({ error: "action_failed" })
    });
    expect(bare).toMatchObject({
      ok: true,
      outcome: "action_failed",
      detail: "the action could not be performed"
    });
  });

  it("reports any other sidecar error as render_failed", async () => {
    const result = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
      fetchImpl: fetchReturning({ error: "render_failed", detail: "browser died" })
    });
    expect(result).toMatchObject({ ok: false, error: "render_failed", detail: "browser died" });

    const noDetail = await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
      fetchImpl: fetchReturning({ error: "weird_new_error" })
    });
    expect(noDetail).toMatchObject({ ok: false, error: "render_failed", detail: "weird_new_error" });
  });

  it("treats a success body without a recorded action or count as malformed", async () => {
    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning({ actionsCount: 1, html: "", text: "" })
      })
    ).toMatchObject({ ok: false, error: "render_failed", detail: "malformed sidecar response" });

    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning({
          recorded: { kind: "click_text", target: "x" },
          html: "",
          text: ""
        })
      })
    ).toMatchObject({ ok: false, error: "render_failed" });

    expect(
      await actBrowseDemo(BIZ, DEMO_ID, { kind: "click_text", target: "x" }, {
        fetchImpl: fetchReturning(null)
      })
    ).toMatchObject({ ok: false, error: "render_failed" });
  });
});

describe("stopBrowseDemo", () => {
  it("stops the session and reports how many actions were recorded", async () => {
    const fetchImpl = fetchReturning({ ok: true, actionsCount: 5 });
    const result = await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl });
    expect(result).toEqual({ ok: true, actionsCount: 5 });
    const [endpoint, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(endpoint).toBe(`https://render-${BIZ}.example.com/demo/stop`);
    expect(JSON.parse(String(init.body))).toEqual({ businessId: BIZ, demoId: DEMO_ID });
  });

  it("is fine with a stop that found nothing to stop", async () => {
    const result = await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning({ ok: true }) });
    expect(result).toEqual({ ok: true });
  });

  it("names the transport failures like its siblings", async () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    expect(await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning({}) })).toEqual({
      ok: false,
      error: "not_configured"
    });
    process.env.AIFLOW_RENDER_URL_TEMPLATE = "https://render-{businessId}.example.com/render";

    expect(await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning({}, 404) })).toEqual({
      ok: false,
      error: "not_updated"
    });

    expect(await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning({}, 503) })).toEqual({
      ok: false,
      error: "render_failed",
      detail: "sidecar http 503"
    });
  });

  it("reports a sidecar error body and a malformed body as render_failed", async () => {
    expect(
      await stopBrowseDemo(BIZ, DEMO_ID, {
        fetchImpl: fetchReturning({ error: "render_failed", detail: "boom" })
      })
    ).toMatchObject({ ok: false, error: "render_failed", detail: "boom" });

    expect(
      await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning({ error: "render_failed" }) })
    ).toMatchObject({ ok: false, error: "render_failed", detail: "render_failed" });

    expect(
      await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning({ nope: 1 }) })
    ).toMatchObject({ ok: false, error: "render_failed", detail: "malformed sidecar response" });

    expect(await stopBrowseDemo(BIZ, DEMO_ID, { fetchImpl: fetchReturning(null) })).toMatchObject({
      ok: false,
      error: "render_failed"
    });
  });
});

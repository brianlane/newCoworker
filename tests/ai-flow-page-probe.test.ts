import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isProbeableUrl,
  probePageControls,
  resolveRenderProbeUrl
} from "@/lib/ai-flows/page-probe";

const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  } as unknown as Response;
}

beforeEach(() => {
  process.env.AIFLOW_RENDER_URL_TEMPLATE = "https://render-{businessId}.example.com/render";
  process.env.AIFLOW_RENDER_TOKEN = "tok-123";
});

afterEach(() => {
  delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
  delete process.env.AIFLOW_RENDER_TOKEN;
  vi.restoreAllMocks();
});

describe("resolveRenderProbeUrl", () => {
  it("templates the business into the tenant's own sidecar host", () => {
    expect(resolveRenderProbeUrl(BIZ)).toBe(`https://render-${BIZ}.example.com/render`);
  });

  it("is null when the platform has no render template configured", () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    expect(resolveRenderProbeUrl(BIZ)).toBeNull();
    process.env.AIFLOW_RENDER_URL_TEMPLATE = "   ";
    expect(resolveRenderProbeUrl(BIZ)).toBeNull();
  });
});

describe("isProbeableUrl", () => {
  it("accepts a public http(s) page", () => {
    expect(isProbeableUrl("https://agents.listwithclever.com/c2c/lead/7")).toBe(true);
    expect(isProbeableUrl("http://example.com")).toBe(true);
  });

  it("refuses anything that is not a URL, or not http(s)", () => {
    expect(isProbeableUrl("not a url")).toBe(false);
    expect(isProbeableUrl("file:///etc/passwd")).toBe(false);
    expect(isProbeableUrl("javascript:alert(1)")).toBe(false);
  });

  it("refuses private, loopback and metadata hosts", () => {
    // The near half of the fence: the owner supplies this address, and the
    // fetch happens on the tenant's own box.
    expect(isProbeableUrl("http://localhost:8080/render")).toBe(false);
    expect(isProbeableUrl("http://127.0.0.1/")).toBe(false);
    expect(isProbeableUrl("http://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(isProbeableUrl("http://metadata.google.internal/")).toBe(false);
    expect(isProbeableUrl("http://box.internal/")).toBe(false);
  });

  it("refuses a bare IP literal even when it is public", () => {
    expect(isProbeableUrl("http://93.184.216.34/")).toBe(false);
  });
});

describe("probePageControls", () => {
  it("digests the rendered page into pickable controls", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        finalUrl: "https://portal.example.com/lead/7",
        html: `<h1>Referral detail</h1><button>Claim this lead</button>
               <textarea name="message"></textarea>`
      })
    );

    const result = await probePageControls(BIZ, "https://portal.example.com/lead/7", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, finalUrl: "https://portal.example.com/lead/7" });
    if (!result.ok) throw new Error("expected ok");
    expect(result.digest.headings).toEqual(["Referral detail"]);
    expect(result.digest.controls.map((c) => c.target)).toEqual([
      "Claim this lead",
      'textarea[name="message"]'
    ]);
  });

  it("NEVER sends an actions array, so the sidecar cannot click anything", async () => {
    // The read-only guarantee is structural, not a flag: the request shape is
    // what makes clicking impossible (vps/aiflow-render/server.mjs only acts
    // when `actions` is present).
    const fetchImpl = vi.fn(async () => jsonResponse({ finalUrl: "u", html: "<p>hi</p>" }));
    await probePageControls(BIZ, "https://portal.example.com/lead/7", {
      integrationLabel: "Referral Exchange",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });

    const [endpoint, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(String(init.body));
    expect(sent).not.toHaveProperty("actions");
    expect(sent).toEqual({
      url: "https://portal.example.com/lead/7",
      businessId: BIZ,
      auth: { integrationLabel: "Referral Exchange" }
    });
    expect(endpoint).toBe(`https://render-${BIZ}.example.com/render`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok-123");
  });

  it("omits auth entirely for a public page", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ html: "<p>hi</p>" }));
    await probePageControls(BIZ, "https://example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const sent = JSON.parse(String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(sent).not.toHaveProperty("auth");
  });

  it("sends no Authorization header when the platform has no sidecar token", async () => {
    delete process.env.AIFLOW_RENDER_TOKEN;
    const fetchImpl = vi.fn(async () => jsonResponse({ html: "<p>hi</p>" }));
    await probePageControls(BIZ, "https://example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.headers).not.toHaveProperty("Authorization");
  });

  it("falls back to the requested URL when the sidecar reports no final one", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ html: "<p>hi</p>" }));
    const result = await probePageControls(BIZ, "https://example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: true, finalUrl: "https://example.com/" });
  });

  it("refuses an unsafe address without calling the sidecar at all", async () => {
    const fetchImpl = vi.fn();
    const result = await probePageControls(BIZ, "http://169.254.169.254/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: false, error: "unsafe_url" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports not_configured when no render template is set", async () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    const fetchImpl = vi.fn();
    const result = await probePageControls(BIZ, "https://example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("names a bad login separately, because the fix is on the credentials", async () => {
    const fetchImpl = vi.fn(async () =>
      // Application failures arrive as HTTP 200 with an { error } body: the
      // Cloudflare Tunnel replaces any origin 5xx body with its own page.
      jsonResponse({ error: "login_failed", detail: "submit selector never appeared" })
    );
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      integrationLabel: "HomeLight",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({
      ok: false,
      error: "login_failed",
      detail: "submit selector never appeared"
    });
  });

  it("falls back to the error code when the sidecar gives no detail", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "render_failed" }));
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "render_failed", detail: "render_failed" });
  });

  it("treats a non-2xx response as a render failure", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 502));
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "render_failed", detail: "sidecar http 502" });
  });

  it("treats a body with no html as a render failure", async () => {
    for (const body of [null, {}, { html: "" }, { html: 42 }]) {
      const fetchImpl = vi.fn(async () => jsonResponse(body));
      const result = await probePageControls(BIZ, "https://portal.example.com/", {
        fetchImpl: fetchImpl as unknown as typeof fetch
      });
      expect(result).toEqual({
        ok: false,
        error: "render_failed",
        detail: "malformed sidecar response"
      });
    }
  });

  it("treats unparseable JSON as a render failure", async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      }
    }));
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({ ok: false, error: "render_failed" });
  });

  it("reports a transport failure instead of throwing", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("box unreachable");
    });
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "render_failed", detail: "box unreachable" });
  });

  it("reports a non-Error throw too", async () => {
    const fetchImpl = vi.fn(async () => {
      throw "timed out";
    });
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ ok: false, error: "render_failed", detail: "timed out" });
  });
});


describe("probePageControls diagnostics", () => {
  it("carries what the page reported about itself, on success", async () => {
    // An empty picker and a broken portal look identical without this.
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        html: "<p>shell only</p>",
        diagnostics: { pageErrors: ["Unexpected token '<'"] }
      })
    );
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toMatchObject({
      ok: true,
      diagnostics: { pageErrors: ["Unexpected token '<'"] }
    });
  });

  it("omits the field when the page reported nothing", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ html: "<p>hi</p>" }));
    const result = await probePageControls(BIZ, "https://portal.example.com/", {
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result.ok && result.diagnostics).toBeUndefined();
  });
});

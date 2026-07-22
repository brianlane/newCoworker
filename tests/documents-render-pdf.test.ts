import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() }
}));

import { renderHtmlToPdf, resolveRenderPdfUrl } from "@/lib/documents/render-pdf";

const BIZ = "11111111-1111-4111-8111-111111111111";
const ENV_KEYS = ["AIFLOW_RENDER_URL_TEMPLATE", "AIFLOW_RENDER_TOKEN"] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  process.env.AIFLOW_RENDER_URL_TEMPLATE = "https://render-{businessId}.example.com/render";
  process.env.AIFLOW_RENDER_TOKEN = "render-secret";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

function fetchOk(body: unknown, status = 200) {
  return vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  })) as unknown as typeof fetch;
}

describe("resolveRenderPdfUrl", () => {
  it("substitutes the business id and swaps /render for /pdf", () => {
    expect(resolveRenderPdfUrl(BIZ)).toBe(`https://render-${BIZ}.example.com/pdf`);
  });

  it("handles static templates, trailing slashes, and no /render suffix", () => {
    process.env.AIFLOW_RENDER_URL_TEMPLATE = "http://127.0.0.1:8080/render/";
    expect(resolveRenderPdfUrl(BIZ)).toBe("http://127.0.0.1:8080/pdf");
    process.env.AIFLOW_RENDER_URL_TEMPLATE = "http://127.0.0.1:8080/";
    expect(resolveRenderPdfUrl(BIZ)).toBe("http://127.0.0.1:8080/pdf");
  });

  it("returns null when the template is unset", () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    expect(resolveRenderPdfUrl(BIZ)).toBeNull();
    process.env.AIFLOW_RENDER_URL_TEMPLATE = "   ";
    expect(resolveRenderPdfUrl(BIZ)).toBeNull();
  });
});

describe("renderHtmlToPdf", () => {
  it("returns not_configured when no template is set", async () => {
    delete process.env.AIFLOW_RENDER_URL_TEMPLATE;
    const fetchImpl = fetchOk({});
    const result = await renderHtmlToPdf(BIZ, "<html></html>", { fetchImpl });
    expect(result).toEqual({ ok: false, error: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("posts the html with the bearer and decodes the pdf", async () => {
    const pdfBytes = Buffer.from("%PDF-1.7 fake");
    const fetchImpl = fetchOk({ pdfBase64: pdfBytes.toString("base64") });
    const result = await renderHtmlToPdf(BIZ, "<html>doc</html>", { fetchImpl });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.pdf.equals(pdfBytes)).toBe(true);
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe(`https://render-${BIZ}.example.com/pdf`);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer render-secret");
    expect(JSON.parse(String(init.body))).toEqual({ html: "<html>doc</html>" });
  });

  it("omits the Authorization header when no token is configured", async () => {
    delete process.env.AIFLOW_RENDER_TOKEN;
    const fetchImpl = fetchOk({ pdfBase64: Buffer.from("x").toString("base64") });
    await renderHtmlToPdf(BIZ, "<html></html>", { fetchImpl });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("maps non-2xx responses to render_failed", async () => {
    const result = await renderHtmlToPdf(BIZ, "<html></html>", { fetchImpl: fetchOk({}, 502) });
    expect(result).toEqual({ ok: false, error: "render_failed", detail: "sidecar http 502" });
  });

  it("maps structured sidecar errors (with and without detail)", async () => {
    const withDetail = await renderHtmlToPdf(BIZ, "<html></html>", {
      fetchImpl: fetchOk({ error: "render_failed", detail: "boom" })
    });
    expect(withDetail).toEqual({
      ok: false,
      error: "render_failed",
      detail: "render_failed: boom"
    });

    const noDetail = await renderHtmlToPdf(BIZ, "<html></html>", {
      fetchImpl: fetchOk({ error: "html_too_large" })
    });
    expect(noDetail).toEqual({ ok: false, error: "render_failed", detail: "html_too_large" });
  });

  it("maps malformed bodies (empty pdfBase64, non-JSON) to render_failed", async () => {
    const empty = await renderHtmlToPdf(BIZ, "<html></html>", {
      fetchImpl: fetchOk({ pdfBase64: "" })
    });
    expect(empty).toEqual({
      ok: false,
      error: "render_failed",
      detail: "malformed sidecar response"
    });

    const badJson = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("not json");
      }
    })) as unknown as typeof fetch;
    const unparseable = await renderHtmlToPdf(BIZ, "<html></html>", { fetchImpl: badJson });
    expect(unparseable).toEqual({
      ok: false,
      error: "render_failed",
      detail: "malformed sidecar response"
    });
  });

  it("maps thrown fetch failures (Error and non-Error) to render_failed", async () => {
    const throwing = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const errored = await renderHtmlToPdf(BIZ, "<html></html>", { fetchImpl: throwing });
    expect(errored).toEqual({ ok: false, error: "render_failed", detail: "ECONNREFUSED" });

    const throwingString = vi.fn(async () => {
      throw "socket hang up";
    }) as unknown as typeof fetch;
    const stringy = await renderHtmlToPdf(BIZ, "<html></html>", { fetchImpl: throwingString });
    expect(stringy).toEqual({ ok: false, error: "render_failed", detail: "socket hang up" });
  });
});

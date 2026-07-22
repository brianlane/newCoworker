/**
 * Render-sidecar PDF client — print self-contained HTML to PDF on the
 * tenant's own VPS render service (vps/aiflow-render, POST /pdf).
 *
 * The sidecar is deployed per tenant on Standard/Enterprise boxes and
 * published at `render-<businessId>.<zone>`; the app resolves it through the
 * same URL template the ai-flow-worker uses for browse:
 *
 *   AIFLOW_RENDER_URL_TEMPLATE=https://render-{businessId}.<zone>/render
 *   AIFLOW_RENDER_TOKEN=<shared bearer>
 *
 * The template points at the browse endpoint; the PDF printer lives beside
 * it, so the path is swapped here. There is deliberately NO fallback
 * renderer: a Starter tenant (no sidecar) or an unreachable box is a clear,
 * typed failure — never a silently different-looking document.
 */

import { logger } from "@/lib/logger";

export type RenderPdfResult =
  | { ok: true; pdf: Buffer }
  | { ok: false; error: "not_configured" | "render_failed"; detail?: string };

export type RenderPdfDeps = {
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** Request budget; Chromium printing a page is fast, but the box may be cold. */
  timeoutMs?: number;
};

/** The tenant's /pdf endpoint URL, or null when the template env is unset. */
export function resolveRenderPdfUrl(businessId: string): string | null {
  const template = (process.env.AIFLOW_RENDER_URL_TEMPLATE ?? "").trim();
  if (!template) return null;
  const base = template.replaceAll("{businessId}", businessId);
  return `${base.replace(/\/render\/?$/, "").replace(/\/+$/, "")}/pdf`;
}

/**
 * Print HTML to PDF on the tenant's render sidecar. `not_configured` when
 * the platform has no render URL template; `render_failed` for transport
 * errors, non-2xx responses, and the sidecar's structured `{ error }` body.
 */
export async function renderHtmlToPdf(
  businessId: string,
  html: string,
  deps: RenderPdfDeps = {}
): Promise<RenderPdfResult> {
  /* c8 ignore next -- production default; tests inject fetchImpl */
  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = resolveRenderPdfUrl(businessId);
  if (!url) return { ok: false, error: "not_configured" };
  const token = (process.env.AIFLOW_RENDER_TOKEN ?? "").trim();

  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real sidecar hang */
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? 60_000);
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({ html }),
      signal: controller.signal
    });
    if (!res.ok) {
      return { ok: false, error: "render_failed", detail: `sidecar http ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as {
      pdfBase64?: unknown;
      error?: unknown;
      detail?: unknown;
    } | null;
    if (body && typeof body.pdfBase64 === "string" && body.pdfBase64.length > 0) {
      return { ok: true, pdf: Buffer.from(body.pdfBase64, "base64") };
    }
    const detail =
      body && typeof body.error === "string"
        ? `${body.error}${typeof body.detail === "string" ? `: ${body.detail}` : ""}`
        : "malformed sidecar response";
    return { ok: false, error: "render_failed", detail: detail.slice(0, 300) };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("render-pdf: sidecar call failed", { businessId, error: detail });
    return { ok: false, error: "render_failed", detail: detail.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

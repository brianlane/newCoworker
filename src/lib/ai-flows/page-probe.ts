/**
 * "Open this page": render a page on the tenant's own aiflow-render sidecar
 * and report the controls a `browse_action` step could aim at.
 *
 * This is what turns authoring a browse step from guessing a CSS selector
 * into picking one off a list. It renders through the SAME sidecar, browser
 * and stored login a flow uses, so what the owner picks from is what the
 * flow will see.
 *
 * READ-ONLY, structurally. The sidecar only performs UI actions when the
 * request carries an `actions` array (see vps/aiflow-render/server.mjs), and
 * this module never sends one: there is no parameter for it and no branch
 * that adds it. So the strongest thing a probe can do is the same login the
 * tenant's flows already perform many times a day. `debug/portal-dom-probe.ts`
 * can click; this owner-facing path deliberately cannot.
 *
 * Credentials are never handled here either. The request carries an
 * integration LABEL and the sidecar resolves it to a secret itself through
 * the platform gateway, exactly as it does for a live flow.
 */
import { logger } from "@/lib/logger";
import { isBareIpHost, isPrivateOrLoopbackHost } from "@/lib/db/custom-integrations";
import { digestPageControls, type PageDigest } from "@/lib/ai-flows/page-controls";

export type ProbePageResult =
  | { ok: true; finalUrl: string; digest: PageDigest }
  | {
      ok: false;
      error: "not_configured" | "unsafe_url" | "render_failed" | "login_failed";
      detail?: string;
    };

export type ProbePageDeps = {
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  /** A cold box plus a portal login is slower than a plain page fetch. */
  timeoutMs?: number;
};

/**
 * The tenant's `/render` endpoint, or null when the platform has no render
 * URL template configured. Same env the ai-flow-worker and the PDF printer
 * resolve through, so a tenant whose flows can browse can also probe.
 */
export function resolveRenderProbeUrl(businessId: string): string | null {
  const template = (process.env.AIFLOW_RENDER_URL_TEMPLATE ?? "").trim();
  if (!template) return null;
  return template.replaceAll("{businessId}", businessId);
}

/**
 * Refuse anything that is not a public http(s) page BEFORE it reaches the
 * sidecar. The sidecar has its own `invalid_or_unsafe_url` guard; this is the
 * near half of the same fence, so an owner-supplied URL cannot be used to
 * make the tenant's box fetch its own metadata service or a neighbour on the
 * private network.
 */
export function isProbeableUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  if (isPrivateOrLoopbackHost(url.hostname)) return false;
  if (isBareIpHost(url.hostname)) return false;
  return true;
}

/**
 * Render `url` on the tenant's sidecar and digest its controls.
 * `integrationLabel` names a saved login (`custom_integrations.label`) when
 * the page is behind the owner's account; omit it for a public page.
 */
export async function probePageControls(
  businessId: string,
  url: string,
  opts: { integrationLabel?: string } & ProbePageDeps = {}
): Promise<ProbePageResult> {
  /* c8 ignore next -- production default; tests inject fetchImpl */
  const fetchImpl = opts.fetchImpl ?? fetch;
  if (!isProbeableUrl(url)) {
    return { ok: false, error: "unsafe_url", detail: "The address must be a public http(s) page." };
  }
  const endpoint = resolveRenderProbeUrl(businessId);
  if (!endpoint) return { ok: false, error: "not_configured" };
  const token = (process.env.AIFLOW_RENDER_TOKEN ?? "").trim();

  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real sidecar hang */
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      // No `actions` key: see the module header. A probe reads, never clicks.
      body: JSON.stringify({
        url,
        businessId,
        ...(opts.integrationLabel ? { auth: { integrationLabel: opts.integrationLabel } } : {})
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      return { ok: false, error: "render_failed", detail: `sidecar http ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as {
      finalUrl?: unknown;
      html?: unknown;
      error?: unknown;
      detail?: unknown;
    } | null;

    // Application-level failures come back as HTTP 200 with an { error } body
    // (the Cloudflare Tunnel replaces any origin 5xx body with its own error
    // page), so the body is what classifies, not the status.
    if (body && typeof body.error === "string") {
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      // A bad login is worth naming separately: the fix is on the
      // integration's credentials, not on the address the owner typed.
      const error = body.error === "login_failed" ? "login_failed" : "render_failed";
      return {
        ok: false,
        error,
        ...(detail ? { detail: detail.slice(0, 300) } : { detail: body.error })
      };
    }
    if (!body || typeof body.html !== "string" || body.html.length === 0) {
      return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
    }

    return {
      ok: true,
      finalUrl: typeof body.finalUrl === "string" ? body.finalUrl : url,
      digest: digestPageControls(body.html)
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("page-probe: sidecar call failed", { businessId, error: detail });
    return { ok: false, error: "render_failed", detail: detail.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

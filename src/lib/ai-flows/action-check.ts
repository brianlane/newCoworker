/**
 * "Try these actions": ask the tenant's render sidecar whether each action in
 * a `browse_action` step would find something to act on, without performing
 * any of them.
 *
 * Closes the last gap in authoring a browse step. The dashboard's "Test with
 * a contact" SIMULATES browse steps (see test_mode.ts: it echoes the action
 * list and never opens a browser), so until now a selector's first real test
 * was a live lead, days later, silently. The page picker
 * (src/lib/ai-flows/page-probe.ts) lets an owner choose a control that exists;
 * this tells them whether the sequence they ended up with still resolves.
 *
 * Read-only: the sidecar's dry run has its own responder that calls
 * `checkActions`, never `performActions`, so nothing is clicked, typed or
 * chosen. Same login the tenant's flows already perform many times a day, and
 * credentials are resolved by the sidecar from an integration LABEL, never
 * handled here.
 */
import { logger } from "@/lib/logger";
import { isProbeableUrl, resolveRenderProbeUrl } from "@/lib/ai-flows/page-probe";
import {
  MAX_CHECKABLE_ACTIONS,
  type ActionCheck,
  type CheckableAction,
  type PageDiagnostics
} from "@/lib/ai-flows/action-check-view";

// Re-exported so server callers have one import site, while the "use client"
// panel imports the view module directly (this file reaches next/headers).
export {
  MAX_CHECKABLE_ACTIONS,
  describeActionCheck,
  describePageDiagnostics,
  noActionResolved,
  type ActionCheck,
  type ActionCheckState,
  type CheckableAction,
  type PageDiagnostics
} from "@/lib/ai-flows/action-check-view";

export type CheckActionsFailure =
  | "not_configured"
  | "unsafe_url"
  | "no_actions"
  | "not_updated"
  | "render_failed"
  | "login_failed";

export type CheckActionsResult =
  | {
      ok: true;
      finalUrl: string;
      checks: ActionCheck[];
      screenshotBase64?: string;
      /** What the page reported about itself, when it reported anything. */
      diagnostics?: PageDiagnostics;
    }
  | { ok: false; error: CheckActionsFailure; detail?: string };

export type CheckActionsDeps = {
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

/**
 * Ask the sidecar to locate every action on `url`. `integrationLabel` names a
 * saved login when the page is behind the owner's account.
 */
export async function checkBrowseActions(
  businessId: string,
  url: string,
  actions: CheckableAction[],
  opts: { integrationLabel?: string } & CheckActionsDeps = {}
): Promise<CheckActionsResult> {
  /* c8 ignore next -- production default; tests inject fetchImpl */
  const fetchImpl = opts.fetchImpl ?? fetch;
  // The editor's "+ action" adds an empty row, so an owner mid-edit always has
  // one. The sidecar's parseActions rejects the WHOLE array on a blank target,
  // which would fail the check for a reason that has nothing to do with the
  // page. Emptiness is judged on the trimmed value; the target itself is sent
  // as typed, since leading or trailing space can be part of a real label.
  const usable = actions.filter((a) => a.kind.trim().length > 0 && a.target.trim().length > 0);
  if (usable.length === 0) return { ok: false, error: "no_actions" };
  if (!isProbeableUrl(url)) {
    return { ok: false, error: "unsafe_url", detail: "The address must be a public http(s) page." };
  }
  const base = resolveRenderProbeUrl(businessId);
  if (!base) return { ok: false, error: "not_configured" };
  // Its OWN path, not /render with a flag. The app deploys on merge while this
  // sidecar only updates on a manual per-tenant redeploy, so there is always a
  // window where the dashboard is new and a box is old. An old box ignores an
  // unknown `checkOnly` and its `if (actions)` branch PERFORMS them, so a flag
  // alone would let this button click a live claim button. An old box has
  // never heard of this path and answers 404, which is safe.
  const endpoint = `${base.replace(/\/render\/?$/, "").replace(/\/+$/, "")}/check-actions`;
  const token = (process.env.AIFLOW_RENDER_TOKEN ?? "").trim();

  const controller = new AbortController();
  /* c8 ignore next -- timer fires only on a real sidecar hang */
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 120_000);
  try {
    const res = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      body: JSON.stringify({
        url,
        businessId,
        // Belt and braces: the path already forces this mode, and the flag
        // makes the request self-describing if one is ever routed by hand. No
        // forEachLink and no expectText: a dry run is one page, one pass.
        checkOnly: true,
        screenshot: true,
        actions: usable.slice(0, MAX_CHECKABLE_ACTIONS).map((a) => ({
          kind: a.kind,
          target: a.target,
          value: a.value ?? ""
        })),
        ...(opts.integrationLabel ? { auth: { integrationLabel: opts.integrationLabel } } : {})
      }),
      signal: controller.signal
    });
    if (res.status === 404) {
      // Exactly the stale-box case above. Name it, because "the page could not
      // be opened" would send the owner checking an address that is fine.
      return { ok: false, error: "not_updated" };
    }
    if (!res.ok) {
      return { ok: false, error: "render_failed", detail: `sidecar http ${res.status}` };
    }
    const body = (await res.json().catch(() => null)) as {
      finalUrl?: unknown;
      checks?: unknown;
      screenshotBase64?: unknown;
      diagnostics?: unknown;
      error?: unknown;
      detail?: unknown;
    } | null;

    // Application-level failures arrive as HTTP 200 with an { error } body,
    // because the Cloudflare Tunnel replaces any origin 5xx body with its own.
    if (body && typeof body.error === "string") {
      const detail = typeof body.detail === "string" ? body.detail : undefined;
      const error = body.error === "login_failed" ? "login_failed" : "render_failed";
      return { ok: false, error, ...(detail ? { detail: detail.slice(0, 300) } : { detail: body.error }) };
    }
    if (!body || !Array.isArray(body.checks)) {
      return { ok: false, error: "render_failed", detail: "malformed sidecar response" };
    }

    return {
      ok: true,
      finalUrl: typeof body.finalUrl === "string" ? body.finalUrl : url,
      checks: body.checks as ActionCheck[],
      ...(typeof body.screenshotBase64 === "string" && body.screenshotBase64.length > 0
        ? { screenshotBase64: body.screenshotBase64 }
        : {}),
      // The sidecar sends this on SUCCESS too, which is the case that matters:
      // a page whose data requests failed still returns 200 with real markup
      // and missing controls.
      ...(body.diagnostics && typeof body.diagnostics === "object"
        ? { diagnostics: body.diagnostics as PageDiagnostics }
        : {})
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.warn("action-check: sidecar call failed", { businessId, error: detail });
    return { ok: false, error: "render_failed", detail: detail.slice(0, 300) };
  } finally {
    clearTimeout(timer);
  }
}

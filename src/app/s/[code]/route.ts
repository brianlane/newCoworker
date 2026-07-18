/**
 * GET /s/<code> — tracked SMS short-link redirect.
 *
 * Public by design: the code is the capability, exactly like a bit.ly link.
 * The `sms_link_click` RPC atomically logs the click, increments the aggregate
 * count, and decides the owner alert in one statement (service-role only;
 * the table itself is RLS-deny-all).
 *
 * Machine traffic never counts: HEAD requests and known link-preview /
 * scanner user agents (messaging-app preview cards, carrier security probes
 * — production showed every link fetched within seconds of DELIVERY) are
 * resolved with a plain lookup and redirected without touching the click
 * stats. Human-looking clicks inside the RPC's prefetch window are logged
 * but flagged and never alert.
 *
 * The stored destination is not an open-redirect surface: rows are written
 * ONLY by the platform's own send paths (AiFlow send_sms, voice follow-up
 * SMS) from message bodies the tenant owner authored — the recipient
 * already received that exact URL in the text; this route just makes the
 * hop measurable. Unknown/expired codes fall back to the app homepage.
 */
import { NextResponse, after } from "next/server";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  notifyLinkClick,
  type LinkClickRpcResult
} from "@/lib/notifications/link-click-notify";
import { isLinkPreviewBot } from "@/lib/sms/link-preview-bots";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const CODE_RE = /^[a-z0-9]{8}$/;

function homepage(): string {
  return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
}

function isLinkClickResult(value: unknown): value is LinkClickRpcResult {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return row.ok === true && typeof row.url === "string";
}

/** Resolve the destination WITHOUT counting a click (bot/preview traffic). */
async function resolveOnly(code: string): Promise<Response> {
  try {
    const db = await createSupabaseServiceClient();
    const { data, error } = await db
      .from("sms_links")
      .select("original_url")
      .eq("short_code", code)
      .maybeSingle();
    const url = (data as { original_url?: string } | null)?.original_url;
    if (error || !url) return NextResponse.redirect(homepage(), 303);
    return NextResponse.redirect(url, 302);
  } catch {
    return NextResponse.redirect(homepage(), 303);
  }
}

/** Preview fetchers commonly probe with HEAD first — never a human tap. */
export async function HEAD(
  _request: Request,
  context: { params: Promise<{ code: string }> }
) {
  const { code } = await context.params;
  if (!CODE_RE.test(code)) {
    return NextResponse.redirect(homepage(), 303);
  }
  return resolveOnly(code);
}

export async function GET(
  request: Request,
  context: { params: Promise<{ code: string }> }
) {
  const { code } = await context.params;
  if (!CODE_RE.test(code)) {
    return NextResponse.redirect(homepage(), 303);
  }
  if (isLinkPreviewBot(request.headers.get("user-agent"))) {
    return resolveOnly(code);
  }
  try {
    const db = await createSupabaseServiceClient();
    const { data, error } = await db.rpc("sms_link_click", { p_short_code: code });
    const result = data as LinkClickRpcResult | { ok?: false } | null;
    if (error || !isLinkClickResult(result)) {
      return NextResponse.redirect(homepage(), 303);
    }
    // after(): a bare fire-and-forget promise gets frozen on serverless the
    // moment the redirect returns; this keeps the notify alive post-response.
    after(async () => {
      await notifyLinkClick(result).catch((err) => {
        logger.warn("s/[code]: link click notify failed", {
          code,
          error: err instanceof Error ? err.message : String(err)
        });
      });
    });
    return NextResponse.redirect(result.url, 302);
  } catch {
    return NextResponse.redirect(homepage(), 303);
  }
}

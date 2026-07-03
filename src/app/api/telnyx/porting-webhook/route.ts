/**
 * Telnyx porting status webhook (per-order `webhook_url` set by
 * `createByonPortRequest`).
 *
 * POST /api/telnyx/porting-webhook
 *   - Verifies the Ed25519 signature (TELNYX_PUBLIC_KEY, same scheme as the
 *     SMS/voice edge functions).
 *   - Handles `porting_order.status_changed`: mirrors the new status onto
 *     the matching `number_port_requests` row and alerts the owner on
 *     milestones (exception / FOC confirmed / ported / cancelled).
 *   - Everything else is acknowledged and ignored — returning non-2xx makes
 *     Telnyx retry, which is only correct for genuine processing failures.
 */

import { NextResponse } from "next/server";
import { verifyTelnyxWebhookSignature } from "@/lib/telnyx/webhook-verify";
import {
  handlePortingStatusChange,
  type PortingWebhookOrderPayload
} from "@/lib/byon/port-requests";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type TelnyxEvent = {
  data?: {
    event_type?: string;
    occurred_at?: string;
    payload?: PortingWebhookOrderPayload;
  };
};

export async function POST(request: Request) {
  const rawBody = await request.text();

  const publicKey = process.env.TELNYX_PUBLIC_KEY ?? "";
  if (!publicKey) {
    logger.error("porting-webhook: TELNYX_PUBLIC_KEY is not configured");
    return NextResponse.json({ ok: false }, { status: 500 });
  }

  const verdict = verifyTelnyxWebhookSignature(
    rawBody,
    request.headers.get("telnyx-signature-ed25519"),
    request.headers.get("telnyx-timestamp"),
    publicKey
  );
  if (!verdict.ok) {
    logger.warn("porting-webhook: signature rejected", { reason: verdict.reason });
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let event: TelnyxEvent;
  try {
    event = JSON.parse(rawBody) as TelnyxEvent;
  } catch {
    return NextResponse.json({ ok: false }, { status: 400 });
  }

  const data = event.data ?? {};
  if ((data.event_type ?? "") !== "porting_order.status_changed") {
    return NextResponse.json({ ok: true, ignored: true });
  }

  try {
    const result = await handlePortingStatusChange(data.payload ?? {}, {}, data.occurred_at ?? null);
    return NextResponse.json({ ok: true, handled: result.handled, ported: result.ported });
  } catch (err) {
    logger.error("porting-webhook: failed to process status change", {
      errorMessage: err instanceof Error ? err.message : String(err)
    });
    // 500 → Telnyx retries with backoff; the handler is idempotent.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

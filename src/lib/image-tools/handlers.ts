/**
 * AI image generation tool cores.
 *
 * Fulfils the `generate_image` (texting coworker → MMS delivery) and
 * `dashboard_generate_image` (dashboard coworker → inline chat image) tools
 * dispatched by /api/rowboat/tool-call, mirroring the handler-library pattern
 * of knowledge-tools / customer-tools.
 *
 * Cost controls (images are the priciest single tool call we expose):
 *  - hard pre-gate on the shared monthly AI budget (no local-model degrade
 *    path exists for images, so over-budget refuses like voice does);
 *  - a durable 3-per-session limit per asking entity — the dashboard session
 *    is the active chat thread, the texting session is the texter's phone
 *    number over a rolling 24h window. AiFlow runs are exempt (owner-authored
 *    and explicitly run) and never call these wrappers.
 *  - consuming the 3rd (final) slot records an activity-log alert
 *    (`coworker_logs` status `urgent_alert`) and, gated by the
 *    `image_limit_alerts` notification preference (default ON), dispatches an
 *    owner notification.
 *  - every generation is metered into the shared AI budget at the flat
 *    per-image list price (image models bill per image, not per text token).
 */

import { randomUUID } from "node:crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  geminiGenerateImage,
  GEMINI_IMAGE_ASPECT_RATIOS,
  type GeminiImageAspectRatio
} from "@/lib/gemini-generate-image";
import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import { meterGeminiSpendForBusiness } from "@/lib/billing/ai-spend-meter";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import type { PlanTier } from "@/lib/plans/tier";
import { rateLimitDurable } from "@/lib/rate-limit";
import { insertCoworkerLog } from "@/lib/db/logs";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { dispatchUrgentNotification } from "@/lib/notifications/dispatch";
import { getActiveThread } from "@/lib/db/dashboard-chat";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export const GENERATED_IMAGES_BUCKET = "generated-images";

/** Default image model; override per-deployment with GEMINI_IMAGE_MODEL. */
export const DEFAULT_IMAGE_MODEL = "gemini-3.1-flash-lite-image";

/**
 * Flat per-image list prices (micro-USD, 1K tier). Image models bill per
 * generated image; unknown models assume the priciest tier we could deploy so
 * the budget fuse never undercounts.
 */
export const IMAGE_COST_MICROS: Record<string, number> = {
  "gemini-3.1-flash-lite-image": 34_000,
  "gemini-3.1-flash-image": 67_000,
  "gemini-3-pro-image": 134_000
};
export const DEFAULT_IMAGE_COST_MICROS = 134_000;

/** Hard per-session cap on generations (per asking entity; AiFlows exempt). */
export const IMAGE_SESSION_LIMIT = 3;
/** Session window for the durable limiter (rolling 24h). */
export const IMAGE_SESSION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Signed-URL lifetime for MMS media: Telnyx fetches promptly after the send. */
const MMS_SIGNED_URL_TTL_S = 3600;

export type ToolResult = { ok: boolean; detail?: string; data?: unknown; message?: string };

export function imageModelFromEnv(env: Record<string, string | undefined> = process.env): string {
  const configured = env.GEMINI_IMAGE_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DEFAULT_IMAGE_MODEL;
}

export function imageCostMicrosForModel(model: string): number {
  return IMAGE_COST_MICROS[model.trim()] ?? DEFAULT_IMAGE_COST_MICROS;
}

/** Narrow an arbitrary string to a supported aspect ratio (else undefined). */
export function normalizeAspectRatio(value: unknown): GeminiImageAspectRatio | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return (GEMINI_IMAGE_ASPECT_RATIOS as readonly string[]).includes(trimmed)
    ? (trimmed as GeminiImageAspectRatio)
    : undefined;
}

/**
 * Record the "final image slot consumed" alert: always lands in the activity
 * log (coworker_logs urgent_alert — what the Recent Activity feed surfaces as
 * an alert), and additionally notifies the owner when the
 * `image_limit_alerts` preference (default ON) is enabled. Best-effort: an
 * alerting failure must never fail the generation that triggered it.
 */
export async function recordImageLimitReached(
  businessId: string,
  surface: "dashboard" | "sms",
  sessionKey: string,
  db: SupabaseClient
): Promise<void> {
  try {
    await insertCoworkerLog(
      {
        id: randomUUID(),
        business_id: businessId,
        task_type: "image",
        status: "urgent_alert",
        log_payload: {
          source: "image_generation",
          reason: `Image generation limit reached (${IMAGE_SESSION_LIMIT} per conversation)`,
          surface,
          sessionKey
        }
      },
      db
    );
  } catch (err) {
    logger.warn("image-tools: failed to record limit alert log", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  let prefEnabled = true;
  try {
    const prefs = await getNotificationPreferences(businessId, db);
    if (prefs) prefEnabled = prefs.image_limit_alerts;
  } catch (err) {
    // Fail open to "alert" — the preference defaults ON, and a missed read
    // should not silently drop an owner alert.
    logger.warn("image-tools: preferences lookup failed (alerting anyway)", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
  if (!prefEnabled) return;

  try {
    await dispatchUrgentNotification({
      businessId,
      kind: "image_limit",
      summary: `Your coworker hit its image generation limit (${IMAGE_SESSION_LIMIT} per conversation)`,
      payload: { surface, sessionKey }
    });
  } catch (err) {
    logger.warn("image-tools: limit notification dispatch failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

export type GenerateBusinessImageOpts = {
  aspectRatio?: GeminiImageAspectRatio;
  /**
   * Session identity for the 3-per-session limit. Omit ONLY for surfaces that
   * are explicitly exempt (AiFlow runs — owner-authored, explicitly run).
   */
  session?: { surface: "dashboard" | "sms"; key: string };
  /** Telemetry label recorded on the AI-budget spend row. */
  surface: string;
  client?: SupabaseClient;
};

export type GeneratedImage = {
  /** Storage path within GENERATED_IMAGES_BUCKET: `<businessId>/<uuid>.<ext>`. */
  path: string;
  mimeType: string;
};

function extensionForMime(mimeType: string): string {
  if (mimeType === "image/jpeg") return "jpg";
  if (mimeType === "image/webp") return "webp";
  return "png";
}

/**
 * Core generation used by every surface: session limit → budget gate →
 * generate → upload → meter. Returns `{ ok:false, detail }` failures instead
 * of throwing so tool dispatchers can hand the model a structured refusal.
 */
export async function generateBusinessImage(
  businessId: string,
  prompt: string,
  opts: GenerateBusinessImageOpts
): Promise<ToolResult & { data?: GeneratedImage }> {
  let db: SupabaseClient;
  if (opts.client) {
    db = opts.client;
  } else {
    db = await createSupabaseServiceClient();
  }

  // 1) Cheap refusals first — a misconfigured key or exhausted budget must
  // NOT consume a session slot (the limiter below has no release path).
  const apiKey = process.env.GOOGLE_API_KEY ?? process.env.GEMINI_API_KEY ?? "";
  if (!apiKey) {
    return { ok: false, detail: "image_generation_unavailable" };
  }
  const model = imageModelFromEnv();

  // 2) Shared AI-budget hard gate, INCLUDING headroom for this image's flat
  // price so the charge can never push the business past the cap. Images
  // have no free local fallback, so an over-budget business is refused
  // outright (parity with voice).
  const { data: bizRow } = await db
    .from("businesses")
    .select("tier")
    .eq("id", businessId)
    .maybeSingle();
  const tier = (bizRow as { tier?: PlanTier | null } | null)?.tier ?? null;
  const snapshot = await getChatSpendSnapshotForBusiness(businessId, db, tier);
  if (snapshot.spendMicros + imageCostMicrosForModel(model) > snapshot.effectiveCapMicros) {
    return {
      ok: false,
      detail: "ai_budget_exceeded",
      message:
        "The monthly AI budget is used up, so no more images can be generated this period."
    };
  }

  // 3) Per-session limit (AiFlow runs pass no session and skip it). The slot
  // is consumed for every ATTEMPTED generation from here on — deliberately,
  // so a repeatedly-failing expensive call can't be retried unbounded (the
  // limiter is the cost fuse; there is no decrement API).
  if (opts.session) {
    const limiterKey = `imggen:${businessId}:${opts.session.surface}:${opts.session.key}`;
    const limit = await rateLimitDurable(limiterKey, {
      interval: IMAGE_SESSION_WINDOW_MS,
      maxRequests: IMAGE_SESSION_LIMIT
    });
    if (!limit.success) {
      return {
        ok: false,
        detail: "image_limit_reached",
        message: `The image limit (${IMAGE_SESSION_LIMIT} per conversation) has been reached. Tell the user plainly instead of retrying.`
      };
    }
    if (limit.remaining === 0) {
      // This call consumes the FINAL slot — alert now (once per session key;
      // later calls fail the limiter above and never reach here).
      await recordImageLimitReached(businessId, opts.session.surface, opts.session.key, db);
    }
  }

  // 4) Generate.
  let bytes: Buffer;
  let mimeType: string;
  try {
    const result = await geminiGenerateImage({
      apiKey,
      model,
      prompt,
      aspectRatio: opts.aspectRatio
    });
    bytes = result.bytes;
    mimeType = result.mimeType;
  } catch (err) {
    if (err instanceof GeminiEmptyError) {
      // Google still bills empty responses — meter the token usage it
      // reported (no flat per-image price: no image was produced).
      await meterGeminiSpendForBusiness({
        businessId,
        model,
        surface: opts.surface,
        usage: err.usage,
        client: db
      });
    }
    logger.warn("image-tools: generation failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return { ok: false, detail: "image_generation_failed" };
  }

  // 5) Store BEFORE metering: a storage failure yields no usable image, so
  // the business must not be charged for it. (Google did bill the raw call,
  // but under-counting a rare storage blip beats charging for nothing.)
  const path = `${businessId}/${randomUUID()}.${extensionForMime(mimeType)}`;
  const { error: uploadErr } = await db.storage
    .from(GENERATED_IMAGES_BUCKET)
    .upload(path, bytes, { contentType: mimeType });
  if (uploadErr) {
    logger.warn("image-tools: upload failed", { businessId, error: uploadErr.message });
    return { ok: false, detail: "image_store_failed" };
  }

  // 6) Meter the flat per-image cost into the shared AI budget.
  await meterGeminiSpendForBusiness({
    businessId,
    model,
    surface: opts.surface,
    costMicrosOverride: imageCostMicrosForModel(model),
    client: db
  });

  return { ok: true, data: { path, mimeType } };
}

/**
 * Dashboard coworker tool: generate and return a STABLE owner-authenticated
 * URL (the /api/dashboard/images proxy) the model embeds as markdown; the
 * chat UI renders it inline. Session = the active dashboard chat thread, so
 * starting a new conversation resets the count.
 */
export async function generateImageForDashboard(
  businessId: string,
  prompt: string,
  aspectRatio?: GeminiImageAspectRatio,
  client?: SupabaseClient
): Promise<ToolResult> {
  const db = client ?? (await createSupabaseServiceClient());
  let sessionKey = "no-thread";
  try {
    const thread = await getActiveThread(businessId, db);
    if (thread) sessionKey = thread.id;
  } catch (err) {
    // A thread-lookup blip must not break the tool; the per-business
    // fallback key still bounds generation volume.
    logger.warn("image-tools: active thread lookup failed", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  const result = await generateBusinessImage(businessId, prompt, {
    aspectRatio,
    session: { surface: "dashboard", key: sessionKey },
    surface: "generate_image_dashboard",
    client: db
  });
  if (!result.ok || !result.data) return result;

  const imageUrl = `/api/dashboard/images/${result.data.path}`;
  return {
    ok: true,
    data: {
      imageUrl,
      markdown: `![Generated image](${imageUrl})`,
      note: "Embed the image in your reply using the provided markdown."
    }
  };
}

/**
 * Texting coworker tool: generate and deliver straight to the texter as a
 * Telnyx MMS (the SMS reply path is text-only, so delivery happens here).
 * Session = the texter's phone number over a rolling 24h window.
 */
export async function generateImageForSms(
  businessId: string,
  prompt: string,
  toE164: string,
  caption?: string,
  client?: SupabaseClient
): Promise<ToolResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const result = await generateBusinessImage(businessId, prompt, {
    session: { surface: "sms", key: toE164 },
    surface: "generate_image_sms",
    client: db
  });
  if (!result.ok || !result.data) return result;

  const { data: signed, error: signErr } = await db.storage
    .from(GENERATED_IMAGES_BUCKET)
    .createSignedUrl(result.data.path, MMS_SIGNED_URL_TTL_S);
  if (signErr || !signed?.signedUrl) {
    logger.warn("image-tools: sign for MMS failed", {
      businessId,
      error: signErr?.message ?? "no url"
    });
    return { ok: false, detail: "image_store_failed" };
  }

  try {
    const config = await getTelnyxMessagingForBusiness(businessId, db);
    const { id: messageId } = await sendTelnyxSms(
      config,
      toE164,
      caption?.trim() || "Here is the image you asked for.",
      { meterBusinessId: businessId, mediaUrls: [signed.signedUrl] }
    );
    return { ok: true, data: { messageId, toE164 } };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const isQuota = /Monthly SMS limit|SMS quota blocked|throttled/i.test(message);
    logger.warn("image-tools: MMS send failed", { businessId, error: message });
    // The image was already generated (and paid for) — a retry would burn
    // another session slot and another charge, so steer the model away.
    return {
      ok: false,
      detail: isQuota ? "sms_quota_blocked" : "mms_send_failed",
      message: isQuota
        ? "The image was created but the monthly text-message limit is reached, so it could not be delivered. Do NOT call this tool again — tell the user plainly."
        : "The image was created but the picture message failed to send. Do NOT call this tool again (each attempt is billed) — tell the user delivery failed."
    };
  }
}

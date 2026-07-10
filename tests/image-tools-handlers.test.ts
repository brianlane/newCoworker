import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockCreateClient = vi.hoisted(() => vi.fn());
const mockGenerateImage = vi.hoisted(() => vi.fn());
const mockMeterSpend = vi.hoisted(() => vi.fn());
const mockSpendSnapshot = vi.hoisted(() => vi.fn());
const mockRateLimitDurable = vi.hoisted(() => vi.fn());
const mockInsertLog = vi.hoisted(() => vi.fn());
const mockGetPrefs = vi.hoisted(() => vi.fn());
const mockDispatch = vi.hoisted(() => vi.fn());
const mockGetActiveThread = vi.hoisted(() => vi.fn());
const mockGetMessaging = vi.hoisted(() => vi.fn());
const mockSendSms = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient: mockCreateClient }));
vi.mock("@/lib/gemini-generate-image", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/gemini-generate-image")>()),
  geminiGenerateImage: mockGenerateImage
}));
vi.mock("@/lib/billing/ai-spend-meter", () => ({
  meterGeminiSpendForBusiness: mockMeterSpend
}));
vi.mock("@/lib/db/chat-usage", () => ({
  getChatSpendSnapshotForBusiness: mockSpendSnapshot
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimitDurable: mockRateLimitDurable }));
vi.mock("@/lib/db/logs", () => ({ insertCoworkerLog: mockInsertLog }));
vi.mock("@/lib/db/notification-preferences", () => ({
  getNotificationPreferences: mockGetPrefs
}));
vi.mock("@/lib/notifications/dispatch", () => ({
  dispatchUrgentNotification: mockDispatch
}));
vi.mock("@/lib/db/dashboard-chat", () => ({ getActiveThread: mockGetActiveThread }));
vi.mock("@/lib/telnyx/messaging", () => ({
  getTelnyxMessagingForBusiness: mockGetMessaging,
  sendTelnyxSms: mockSendSms
}));

import { GeminiEmptyError } from "@/lib/gemini-generate-content";
import {
  DEFAULT_IMAGE_COST_MICROS,
  DEFAULT_IMAGE_MODEL,
  GENERATED_IMAGES_BUCKET,
  IMAGE_SESSION_LIMIT,
  generateBusinessImage,
  generateImageForDashboard,
  generateImageForSms,
  imageCostMicrosForModel,
  imageModelFromEnv,
  normalizeAspectRatio,
  recordImageLimitReached
} from "@/lib/image-tools/handlers";

const BIZ = "11111111-2222-3333-4444-555555555555";

type StorageStub = {
  upload: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
};

function stubDb(opts?: {
  tier?: string | null;
  bizRow?: unknown;
  uploadError?: { message: string } | null;
  signedUrl?: string | null;
  signError?: { message: string } | null;
}) {
  const storage: StorageStub = {
    upload: vi.fn(async () => ({ error: opts?.uploadError ?? null })),
    createSignedUrl: vi.fn(async () => ({
      data:
        opts?.signedUrl === null
          ? null
          : { signedUrl: opts?.signedUrl ?? "https://signed.example/img" },
      error: opts?.signError ?? null
    }))
  };
  const from = vi.fn(() => {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({
        data: opts?.bizRow !== undefined ? opts.bizRow : { tier: opts?.tier ?? "standard" },
        error: null
      })
    };
    return builder;
  });
  return {
    from,
    storage: { from: vi.fn(() => storage) },
    _storage: storage
  };
}

function allowLimiter(remaining = 2) {
  mockRateLimitDurable.mockResolvedValue({
    success: true,
    limit: IMAGE_SESSION_LIMIT,
    remaining,
    reset: Date.now() + 1000
  });
}

function budgetOk() {
  mockSpendSnapshot.mockResolvedValue({
    periodStart: "2026-07-01T00:00:00.000Z",
    spendMicros: 1_000,
    baseCapMicros: 10_000_000,
    creditMicros: 0,
    effectiveCapMicros: 10_000_000
  });
}

function generationOk(mimeType = "image/png") {
  mockGenerateImage.mockResolvedValue({
    bytes: Buffer.from("img"),
    mimeType,
    usage: { promptTokens: 10, outputTokens: 1290 }
  });
}

describe("image-tools handlers", () => {
  const savedEnv = {
    GEMINI_IMAGE_MODEL: process.env.GEMINI_IMAGE_MODEL,
    GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
    GEMINI_API_KEY: process.env.GEMINI_API_KEY
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_IMAGE_MODEL;
    process.env.GOOGLE_API_KEY = "test-google-key";
    delete process.env.GEMINI_API_KEY;
    mockInsertLog.mockResolvedValue({});
    mockGetPrefs.mockResolvedValue(null);
    mockDispatch.mockResolvedValue({ results: [] });
    mockMeterSpend.mockResolvedValue(undefined);
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  describe("imageModelFromEnv", () => {
    it("defaults to the lite image model and honors a configured override", () => {
      expect(imageModelFromEnv({})).toBe(DEFAULT_IMAGE_MODEL);
      expect(imageModelFromEnv({ GEMINI_IMAGE_MODEL: " gemini-3-pro-image " })).toBe(
        "gemini-3-pro-image"
      );
      expect(imageModelFromEnv({ GEMINI_IMAGE_MODEL: "  " })).toBe(DEFAULT_IMAGE_MODEL);
    });
  });

  describe("imageCostMicrosForModel", () => {
    it("prices known models flat per image and unknown models at the priciest tier", () => {
      expect(imageCostMicrosForModel("gemini-3.1-flash-lite-image")).toBe(34_000);
      expect(imageCostMicrosForModel(" gemini-3.1-flash-image ")).toBe(67_000);
      expect(imageCostMicrosForModel("gemini-99-image")).toBe(DEFAULT_IMAGE_COST_MICROS);
    });
  });

  describe("normalizeAspectRatio", () => {
    it("accepts supported ratios and rejects everything else", () => {
      expect(normalizeAspectRatio(" 16:9 ")).toBe("16:9");
      expect(normalizeAspectRatio("7:5")).toBeUndefined();
      expect(normalizeAspectRatio(42)).toBeUndefined();
      expect(normalizeAspectRatio(undefined)).toBeUndefined();
    });
  });

  describe("recordImageLimitReached", () => {
    it("writes the activity-log alert and dispatches the owner notification (pref default ON)", async () => {
      const db = stubDb();
      await recordImageLimitReached(BIZ, "dashboard", "thread-1", db as never);
      expect(mockInsertLog).toHaveBeenCalledWith(
        expect.objectContaining({
          business_id: BIZ,
          task_type: "image",
          status: "urgent_alert",
          log_payload: expect.objectContaining({ surface: "dashboard", sessionKey: "thread-1" })
        }),
        db
      );
      expect(mockDispatch).toHaveBeenCalledWith(
        expect.objectContaining({ businessId: BIZ, kind: "image_limit" })
      );
    });

    it("skips the owner notification when the preference is off (alert log still written)", async () => {
      mockGetPrefs.mockResolvedValue({ image_limit_alerts: false });
      const db = stubDb();
      await recordImageLimitReached(BIZ, "sms", "+15550001111", db as never);
      expect(mockInsertLog).toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("still dispatches when the preference row exists with the toggle on", async () => {
      mockGetPrefs.mockResolvedValue({ image_limit_alerts: true });
      const db = stubDb();
      await recordImageLimitReached(BIZ, "sms", "+15550001111", db as never);
      expect(mockDispatch).toHaveBeenCalled();
    });

    it("fails open to alerting when the preferences read throws (Error and non-Error)", async () => {
      mockGetPrefs.mockRejectedValue(new Error("db down"));
      const db = stubDb();
      await recordImageLimitReached(BIZ, "dashboard", "t", db as never);
      expect(mockDispatch).toHaveBeenCalled();

      mockDispatch.mockClear();
      mockGetPrefs.mockRejectedValue("db down (non-Error)");
      await recordImageLimitReached(BIZ, "dashboard", "t", db as never);
      expect(mockDispatch).toHaveBeenCalled();
    });

    it("never throws when the log insert or the dispatch fails (either error shape)", async () => {
      const db = stubDb();
      mockInsertLog.mockRejectedValue(new Error("insert down"));
      mockDispatch.mockRejectedValue("dispatch down");
      await expect(
        recordImageLimitReached(BIZ, "dashboard", "t", db as never)
      ).resolves.toBeUndefined();

      mockInsertLog.mockRejectedValue("insert down (non-Error)");
      mockDispatch.mockRejectedValue(new Error("dispatch down"));
      await expect(
        recordImageLimitReached(BIZ, "sms", "t2", db as never)
      ).resolves.toBeUndefined();
    });
  });

  describe("generateBusinessImage", () => {
    it("refuses with image_limit_reached when the session limiter is exhausted", async () => {
      budgetOk();
      mockRateLimitDurable.mockResolvedValue({
        success: false,
        limit: IMAGE_SESSION_LIMIT,
        remaining: 0,
        reset: Date.now()
      });
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "dashboard", key: "t1" },
        surface: "test",
        client: db as never
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toBe("image_limit_reached");
      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:dashboard:t1`,
        expect.objectContaining({ maxRequests: IMAGE_SESSION_LIMIT })
      );
      expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it("fires the limit-reached alert exactly when the FINAL slot is consumed", async () => {
      allowLimiter(0);
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "sms", key: "+15550001111" },
        surface: "test",
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(mockInsertLog).toHaveBeenCalledWith(
        expect.objectContaining({ status: "urgent_alert" }),
        db
      );
    });

    it("does not alert while slots remain", async () => {
      allowLimiter(1);
      budgetOk();
      generationOk();
      const db = stubDb();
      await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "sms", key: "+15550001111" },
        surface: "test",
        client: db as never
      });
      expect(mockInsertLog).not.toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("skips the session limiter entirely for exempt (AiFlow) callers", async () => {
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "aiflow",
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(mockRateLimitDurable).not.toHaveBeenCalled();
    });

    it("hard-refuses when the shared AI budget is exhausted", async () => {
      allowLimiter();
      mockSpendSnapshot.mockResolvedValue({
        periodStart: "2026-07-01T00:00:00.000Z",
        spendMicros: 10_000_000,
        baseCapMicros: 10_000_000,
        creditMicros: 0,
        effectiveCapMicros: 10_000_000
      });
      const db = stubDb({ tier: "starter" });
      const result = await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "dashboard", key: "t1" },
        surface: "test",
        client: db as never
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toBe("ai_budget_exceeded");
      expect(mockSpendSnapshot).toHaveBeenCalledWith(BIZ, db, "starter");
      expect(mockGenerateImage).not.toHaveBeenCalled();
      // A budget refusal must not consume a session slot.
      expect(mockRateLimitDurable).not.toHaveBeenCalled();
    });

    it("refuses when the flat image price would push spend past the cap (headroom check)", async () => {
      mockSpendSnapshot.mockResolvedValue({
        periodStart: "2026-07-01T00:00:00.000Z",
        // 10M cap - 1k spend leaves less than the 34k lite image price.
        spendMicros: 9_999_000,
        baseCapMicros: 10_000_000,
        creditMicros: 0,
        effectiveCapMicros: 10_000_000
      });
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "test",
        client: db as never
      });
      expect(result.detail).toBe("ai_budget_exceeded");
      expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it("passes a null tier when the business row is missing", async () => {
      budgetOk();
      generationOk();
      const db = stubDb({ bizRow: null });
      await generateBusinessImage(BIZ, "a cat", { surface: "test", client: db as never });
      expect(mockSpendSnapshot).toHaveBeenCalledWith(BIZ, db, null);
    });

    it("refuses when no Gemini key is configured (before consuming a session slot)", async () => {
      delete process.env.GOOGLE_API_KEY;
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "dashboard", key: "t1" },
        surface: "test",
        client: db as never
      });
      expect(result).toEqual({ ok: false, detail: "image_generation_unavailable" });
      expect(mockRateLimitDurable).not.toHaveBeenCalled();
    });

    it("falls back to GEMINI_API_KEY when GOOGLE_API_KEY is unset", async () => {
      delete process.env.GOOGLE_API_KEY;
      process.env.GEMINI_API_KEY = "alt-key";
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "test",
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: "alt-key" })
      );
    });

    it("meters billed usage on a GeminiEmptyError (Google still bills empties)", async () => {
      budgetOk();
      const usage = { promptTokens: 5, outputTokens: 9 };
      mockGenerateImage.mockRejectedValue(new GeminiEmptyError(usage));
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "test",
        client: db as never
      });
      expect(result).toEqual({ ok: false, detail: "image_generation_failed" });
      expect(mockMeterSpend).toHaveBeenCalledWith(
        expect.objectContaining({ usage, surface: "test" })
      );
    });

    it("does not meter on a non-billing generation failure", async () => {
      budgetOk();
      mockGenerateImage.mockRejectedValue("gemini_http_500");
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "test",
        client: db as never
      });
      expect(result).toEqual({ ok: false, detail: "image_generation_failed" });
      expect(mockMeterSpend).not.toHaveBeenCalled();
    });

    it("meters the flat per-image cost and uploads on success (env model override)", async () => {
      process.env.GEMINI_IMAGE_MODEL = "gemini-3-pro-image";
      budgetOk();
      generationOk("image/jpeg");
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "test",
        aspectRatio: "1:1",
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(result.data?.path).toMatch(new RegExp(`^${BIZ}/[0-9a-f-]{36}\\.jpg$`));
      expect(result.data?.mimeType).toBe("image/jpeg");
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({ model: "gemini-3-pro-image", aspectRatio: "1:1" })
      );
      expect(mockMeterSpend).toHaveBeenCalledWith(
        expect.objectContaining({ costMicrosOverride: 134_000, model: "gemini-3-pro-image" })
      );
      expect(db.storage.from).toHaveBeenCalledWith(GENERATED_IMAGES_BUCKET);
      expect(db._storage.upload).toHaveBeenCalledWith(
        expect.stringMatching(/\.jpg$/),
        expect.any(Buffer),
        { contentType: "image/jpeg" }
      );
    });

    it("uses the webp extension for image/webp and png otherwise", async () => {
      budgetOk();
      generationOk("image/webp");
      const db = stubDb();
      const webp = await generateBusinessImage(BIZ, "a", { surface: "t", client: db as never });
      expect(webp.data?.path).toMatch(/\.webp$/);

      generationOk("image/png");
      const png = await generateBusinessImage(BIZ, "a", { surface: "t", client: db as never });
      expect(png.data?.path).toMatch(/\.png$/);
    });

    it("creates a service client when none is injected (session path)", async () => {
      const db = stubDb();
      mockCreateClient.mockResolvedValue(db as never);
      allowLimiter();
      budgetOk();
      generationOk();
      const result = await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "dashboard", key: "t1" },
        surface: "test"
      });
      expect(result.ok).toBe(true);
      expect(mockCreateClient).toHaveBeenCalled();
      expect(mockRateLimitDurable).toHaveBeenCalled();
    });

    it("returns image_store_failed when the upload errors — and does not charge for it", async () => {
      budgetOk();
      generationOk();
      const db = stubDb({ uploadError: { message: "bucket missing" } });
      const result = await generateBusinessImage(BIZ, "a cat", {
        surface: "test",
        client: db as never
      });
      expect(result).toEqual({ ok: false, detail: "image_store_failed" });
      expect(mockMeterSpend).not.toHaveBeenCalled();
    });
  });

  describe("generateImageForDashboard", () => {
    it("keys the session by the active chat thread and returns the proxy URL + markdown", async () => {
      mockGetActiveThread.mockResolvedValue({ id: "thread-9" });
      allowLimiter();
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateImageForDashboard(BIZ, "a cat", "16:9", db as never);
      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:dashboard:thread-9`,
        expect.anything()
      );
      expect(result.ok).toBe(true);
      const data = result.data as { imageUrl: string; markdown: string };
      expect(data.imageUrl).toMatch(new RegExp(`^/api/dashboard/images/${BIZ}/`));
      expect(data.markdown).toBe(`![Generated image](${data.imageUrl})`);
    });

    it("falls back to a per-business session key when no thread is active", async () => {
      mockGetActiveThread.mockResolvedValue(null);
      allowLimiter();
      budgetOk();
      generationOk();
      const db = stubDb();
      await generateImageForDashboard(BIZ, "a cat", undefined, db as never);
      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:dashboard:no-thread`,
        expect.anything()
      );
    });

    it("tolerates a thread-lookup failure (fallback key, tool still works)", async () => {
      mockGetActiveThread.mockRejectedValue(new Error("thread read down"));
      allowLimiter();
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateImageForDashboard(BIZ, "a cat", undefined, db as never);
      expect(result.ok).toBe(true);
      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:dashboard:no-thread`,
        expect.anything()
      );

      // Non-Error rejections take the String(err) logging path.
      mockGetActiveThread.mockRejectedValue("thread read down (non-Error)");
      generationOk();
      const again = await generateImageForDashboard(BIZ, "a cat", undefined, db as never);
      expect(again.ok).toBe(true);
    });

    it("passes a core failure through unchanged", async () => {
      mockGetActiveThread.mockResolvedValue({ id: "t" });
      mockRateLimitDurable.mockResolvedValue({ success: false, limit: 3, remaining: 0, reset: 0 });
      const db = stubDb();
      const result = await generateImageForDashboard(BIZ, "a cat", undefined, db as never);
      expect(result.ok).toBe(false);
      expect(result.detail).toBe("image_limit_reached");
    });

    it("creates a service client when none is injected", async () => {
      const db = stubDb();
      mockCreateClient.mockResolvedValue(db as never);
      mockGetActiveThread.mockResolvedValue(null);
      allowLimiter();
      budgetOk();
      generationOk();
      const result = await generateImageForDashboard(BIZ, "a cat");
      expect(result.ok).toBe(true);
      expect(mockCreateClient).toHaveBeenCalled();
    });
  });

  describe("generateImageForSms", () => {
    it("generates, signs, and delivers as MMS with the caption", async () => {
      allowLimiter();
      budgetOk();
      generationOk();
      mockGetMessaging.mockResolvedValue({ apiKey: "k", messagingProfileId: "p" });
      mockSendSms.mockResolvedValue({ id: "msg-1", channel: "sms" });
      const db = stubDb({ signedUrl: "https://signed.example/pic.png" });

      const result = await generateImageForSms(BIZ, "a cat", "+15550001111", "Here!", db as never);

      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:sms:+15550001111`,
        expect.anything()
      );
      expect(mockSendSms).toHaveBeenCalledWith(
        { apiKey: "k", messagingProfileId: "p" },
        "+15550001111",
        "Here!",
        expect.objectContaining({
          meterBusinessId: BIZ,
          mediaUrls: ["https://signed.example/pic.png"]
        })
      );
      expect(result).toEqual({ ok: true, data: { messageId: "msg-1", toE164: "+15550001111" } });
    });

    it("uses a default caption when none is provided", async () => {
      allowLimiter();
      budgetOk();
      generationOk();
      mockGetMessaging.mockResolvedValue({ apiKey: "k", messagingProfileId: "p" });
      mockSendSms.mockResolvedValue({ id: "msg-2", channel: "sms" });
      const db = stubDb();
      await generateImageForSms(BIZ, "a cat", "+15550001111", "  ", db as never);
      expect(mockSendSms.mock.calls[0][2]).toBe("Here is the image you asked for.");
    });

    it("passes a core failure through unchanged", async () => {
      mockRateLimitDurable.mockResolvedValue({ success: false, limit: 3, remaining: 0, reset: 0 });
      const db = stubDb();
      const result = await generateImageForSms(BIZ, "a cat", "+15550001111", undefined, db as never);
      expect(result.detail).toBe("image_limit_reached");
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it("returns image_store_failed when signing errors or yields no URL", async () => {
      allowLimiter();
      budgetOk();
      generationOk();
      const errDb = stubDb({ signError: { message: "sign down" } });
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", undefined, errDb as never)).detail
      ).toBe("image_store_failed");

      generationOk();
      const noUrlDb = stubDb({ signedUrl: null });
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", undefined, noUrlDb as never)).detail
      ).toBe("image_store_failed");
    });

    it("maps a quota refusal to sms_quota_blocked and other send failures to mms_send_failed", async () => {
      allowLimiter();
      budgetOk();
      generationOk();
      mockGetMessaging.mockResolvedValue({ apiKey: "k", messagingProfileId: "p" });
      mockSendSms.mockRejectedValue(new Error("Monthly SMS limit reached"));
      const db = stubDb();
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", undefined, db as never)).detail
      ).toBe("sms_quota_blocked");

      generationOk();
      mockSendSms.mockRejectedValue("telnyx 500");
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", undefined, db as never)).detail
      ).toBe("mms_send_failed");
    });

    it("creates a service client when none is injected", async () => {
      const db = stubDb();
      mockCreateClient.mockResolvedValue(db as never);
      allowLimiter();
      budgetOk();
      generationOk();
      mockGetMessaging.mockResolvedValue({ apiKey: "k", messagingProfileId: "p" });
      mockSendSms.mockResolvedValue({ id: "msg-3", channel: "sms" });
      const result = await generateImageForSms(BIZ, "a cat", "+15550001111");
      expect(result.ok).toBe(true);
      expect(mockCreateClient).toHaveBeenCalled();
    });
  });
});

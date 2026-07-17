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
  MAX_INPUT_IMAGE_BYTES,
  generateBusinessImage,
  generateImageForDashboard,
  generateImageForSms,
  imageCostMicrosForModel,
  imageModelFromEnv,
  normalizeAspectRatio,
  normalizeImageRef,
  recordImageLimitReached,
  resolveInputImage
} from "@/lib/image-tools/handlers";

const BIZ = "11111111-2222-3333-4444-555555555555";
const REF_UUID = "99999999-8888-7777-6666-555555555555";
const GOOD_REF = `${BIZ}/${REF_UUID}.jpg`;

type StorageStub = {
  upload: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
  download: ReturnType<typeof vi.fn>;
};

/** Minimal Blob stand-in for storage downloads (arrayBuffer + type). */
function blobOf(bytes: Buffer, type = "image/jpeg") {
  return { type, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
}

function stubDb(opts?: {
  tier?: string | null;
  bizRow?: unknown;
  uploadError?: { message: string } | null;
  signedUrl?: string | null;
  signError?: { message: string } | null;
  downloadResult?: { data: unknown; error: { message: string } | null };
}) {
  const storage: StorageStub = {
    upload: vi.fn(async () => ({ error: opts?.uploadError ?? null })),
    createSignedUrl: vi.fn(async () => ({
      data:
        opts?.signedUrl === null
          ? null
          : { signedUrl: opts?.signedUrl ?? "https://signed.example/img" },
      error: opts?.signError ?? null
    })),
    download: vi.fn(async () =>
      opts?.downloadResult ?? { data: blobOf(Buffer.from("src-img")), error: null }
    )
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

  describe("normalizeImageRef", () => {
    it("accepts the bare path and the proxy URL form (case-normalized)", () => {
      expect(normalizeImageRef(BIZ, GOOD_REF)).toBe(GOOD_REF);
      expect(normalizeImageRef(BIZ, ` /api/dashboard/images/${BIZ}/${REF_UUID}.JPG `)).toBe(
        GOOD_REF
      );
      expect(normalizeImageRef(BIZ, `${BIZ}/${REF_UUID}.webp`)).toBe(`${BIZ}/${REF_UUID}.webp`);
    });

    it("rejects cross-tenant refs, non-strings, and malformed shapes", () => {
      const otherBiz = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      expect(normalizeImageRef(BIZ, `${otherBiz}/${REF_UUID}.jpg`)).toBeNull();
      expect(normalizeImageRef(BIZ, 42)).toBeNull();
      expect(normalizeImageRef(BIZ, "https://evil.example/x.jpg")).toBeNull();
      expect(normalizeImageRef(BIZ, `${BIZ}/../${REF_UUID}.jpg`)).toBeNull();
      expect(normalizeImageRef(BIZ, `${BIZ}/${REF_UUID}.gif`)).toBeNull();
    });
  });

  describe("resolveInputImage", () => {
    it("downloads a valid ref and returns bytes + mime", async () => {
      const db = stubDb();
      const resolved = await resolveInputImage(BIZ, GOOD_REF, db as never);
      expect(resolved).not.toBeNull();
      expect(Buffer.from(resolved!.bytes).toString()).toBe("src-img");
      expect(resolved!.mimeType).toBe("image/jpeg");
      expect(db._storage.download).toHaveBeenCalledWith(GOOD_REF);
    });

    it("falls back to the extension mime when the blob type is empty", async () => {
      const db = stubDb({ downloadResult: { data: blobOf(Buffer.from("x"), ""), error: null } });
      const resolved = await resolveInputImage(BIZ, GOOD_REF, db as never);
      expect(resolved!.mimeType).toBe("image/jpeg");
    });

    it("returns null for bad refs, download errors, empty, and oversized objects", async () => {
      expect(await resolveInputImage(BIZ, "nope", stubDb() as never)).toBeNull();
      expect(
        await resolveInputImage(
          BIZ,
          GOOD_REF,
          stubDb({ downloadResult: { data: null, error: { message: "missing" } } }) as never
        )
      ).toBeNull();
      // Errorless empty download (no data, no error object).
      expect(
        await resolveInputImage(
          BIZ,
          GOOD_REF,
          stubDb({ downloadResult: { data: null, error: null } }) as never
        )
      ).toBeNull();
      expect(
        await resolveInputImage(
          BIZ,
          GOOD_REF,
          stubDb({ downloadResult: { data: blobOf(Buffer.alloc(0)), error: null } }) as never
        )
      ).toBeNull();
      expect(
        await resolveInputImage(
          BIZ,
          GOOD_REF,
          stubDb({
            downloadResult: {
              data: blobOf(Buffer.alloc(MAX_INPUT_IMAGE_BYTES + 1)),
              error: null
            }
          }) as never
        )
      ).toBeNull();
    });
  });

  describe("recordImageLimitReached", () => {
    it("writes the activity-log alert and dispatches the owner notification (pref default ON)", async () => {
      const db = stubDb();
      await recordImageLimitReached(BIZ, "dashboard", "thread-1", IMAGE_SESSION_LIMIT, db as never);
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
      await recordImageLimitReached(BIZ, "sms", "+15550001111", IMAGE_SESSION_LIMIT, db as never);
      expect(mockInsertLog).toHaveBeenCalled();
      expect(mockDispatch).not.toHaveBeenCalled();
    });

    it("still dispatches when the preference row exists with the toggle on", async () => {
      mockGetPrefs.mockResolvedValue({ image_limit_alerts: true });
      const db = stubDb();
      await recordImageLimitReached(BIZ, "sms", "+15550001111", IMAGE_SESSION_LIMIT, db as never);
      expect(mockDispatch).toHaveBeenCalled();
    });

    it("treats a pre-migration row (no image_limit_alerts column) as default ON", async () => {
      mockGetPrefs.mockResolvedValue({ sms_urgent: true }); // no image_limit_alerts field
      const db = stubDb();
      await recordImageLimitReached(BIZ, "sms", "+15550001111", IMAGE_SESSION_LIMIT, db as never);
      expect(mockDispatch).toHaveBeenCalled();
    });

    it("fails open to alerting when the preferences read throws (Error and non-Error)", async () => {
      mockGetPrefs.mockRejectedValue(new Error("db down"));
      const db = stubDb();
      await recordImageLimitReached(BIZ, "dashboard", "t", IMAGE_SESSION_LIMIT, db as never);
      expect(mockDispatch).toHaveBeenCalled();

      mockDispatch.mockClear();
      mockGetPrefs.mockRejectedValue("db down (non-Error)");
      await recordImageLimitReached(BIZ, "dashboard", "t", IMAGE_SESSION_LIMIT, db as never);
      expect(mockDispatch).toHaveBeenCalled();
    });

    it("never throws when the log insert or the dispatch fails (either error shape)", async () => {
      const db = stubDb();
      mockInsertLog.mockRejectedValue(new Error("insert down"));
      mockDispatch.mockRejectedValue("dispatch down");
      await expect(
        recordImageLimitReached(BIZ, "dashboard", "t", IMAGE_SESSION_LIMIT, db as never)
      ).resolves.toBeUndefined();

      mockInsertLog.mockRejectedValue("insert down (non-Error)");
      mockDispatch.mockRejectedValue(new Error("dispatch down"));
      await expect(
        recordImageLimitReached(BIZ, "sms", "t2", IMAGE_SESSION_LIMIT, db as never)
      ).resolves.toBeUndefined();
    });
  });

  describe("generateBusinessImage", () => {
    it("refuses with image_limit_reached when the session limiter is exhausted (Standard tier)", async () => {
      budgetOk();
      mockRateLimitDurable.mockResolvedValue({
        success: false,
        limit: 10,
        remaining: 0,
        reset: Date.now()
      });
      const db = stubDb({ tier: "standard" });
      const result = await generateBusinessImage(BIZ, "a cat", {
        session: { surface: "dashboard", key: "t1" },
        surface: "test",
        client: db as never
      });
      expect(result.ok).toBe(false);
      expect(result.detail).toBe("image_limit_reached");
      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:dashboard:t1`,
        expect.objectContaining({ maxRequests: 10 })
      );
      expect(mockGenerateImage).not.toHaveBeenCalled();
    });

    it("uses the Starter per-session cap when tier is starter", async () => {
      budgetOk();
      mockRateLimitDurable.mockResolvedValue({
        success: false,
        limit: IMAGE_SESSION_LIMIT,
        remaining: 0,
        reset: Date.now()
      });
      const db = stubDb({ tier: "starter" });
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

    it("passes a resolved input image through to Gemini (editing mode)", async () => {
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateBusinessImage(BIZ, "age this face 20 years", {
        inputImageRef: GOOD_REF,
        surface: "test",
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputImage: expect.objectContaining({ mimeType: "image/jpeg" })
        })
      );
    });

    it("refuses with input_image_not_found before consuming a session slot", async () => {
      budgetOk();
      const db = stubDb({ downloadResult: { data: null, error: { message: "missing" } } });
      const result = await generateBusinessImage(BIZ, "edit", {
        inputImageRef: GOOD_REF,
        session: { surface: "dashboard", key: "t1" },
        surface: "test",
        client: db as never
      });
      expect(result.detail).toBe("input_image_not_found");
      expect(mockRateLimitDurable).not.toHaveBeenCalled();
      expect(mockGenerateImage).not.toHaveBeenCalled();
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
      const result = await generateImageForDashboard(BIZ, "a cat", { aspectRatio: "16:9", client: db as never });
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
      await generateImageForDashboard(BIZ, "a cat", { client: db as never });
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
      const result = await generateImageForDashboard(BIZ, "a cat", { client: db as never });
      expect(result.ok).toBe(true);
      expect(mockRateLimitDurable).toHaveBeenCalledWith(
        `imggen:${BIZ}:dashboard:no-thread`,
        expect.anything()
      );

      // Non-Error rejections take the String(err) logging path.
      mockGetActiveThread.mockRejectedValue("thread read down (non-Error)");
      generationOk();
      const again = await generateImageForDashboard(BIZ, "a cat", { client: db as never });
      expect(again.ok).toBe(true);
    });

    it("passes a core failure through unchanged", async () => {
      mockGetActiveThread.mockResolvedValue({ id: "t" });
      mockRateLimitDurable.mockResolvedValue({ success: false, limit: 3, remaining: 0, reset: 0 });
      const db = stubDb();
      const result = await generateImageForDashboard(BIZ, "a cat", { client: db as never });
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

    it("passes an attached image through as the edit source (proxy URL form)", async () => {
      mockGetActiveThread.mockResolvedValue({ id: "t" });
      allowLimiter();
      budgetOk();
      generationOk();
      const db = stubDb();
      const result = await generateImageForDashboard(BIZ, "make it a sunset", {
        inputImageRef: `/api/dashboard/images/${GOOD_REF}`,
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputImage: expect.objectContaining({ mimeType: "image/jpeg" })
        })
      );
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

      const result = await generateImageForSms(BIZ, "a cat", "+15550001111", { caption: "Here!", client: db as never });

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
      await generateImageForSms(BIZ, "a cat", "+15550001111", { caption: "  ", client: db as never });
      expect(mockSendSms.mock.calls[0][2]).toBe("Here is the image you asked for.");
    });

    it("passes a core failure through unchanged", async () => {
      mockRateLimitDurable.mockResolvedValue({ success: false, limit: 3, remaining: 0, reset: 0 });
      const db = stubDb();
      const result = await generateImageForSms(BIZ, "a cat", "+15550001111", { client: db as never });
      expect(result.detail).toBe("image_limit_reached");
      expect(mockSendSms).not.toHaveBeenCalled();
    });

    it("returns image_store_failed when signing errors or yields no URL", async () => {
      allowLimiter();
      budgetOk();
      generationOk();
      const errDb = stubDb({ signError: { message: "sign down" } });
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", { client: errDb as never })).detail
      ).toBe("image_store_failed");

      generationOk();
      const noUrlDb = stubDb({ signedUrl: null });
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", { client: noUrlDb as never })).detail
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
        (await generateImageForSms(BIZ, "a", "+15550001111", { client: db as never })).detail
      ).toBe("sms_quota_blocked");

      generationOk();
      mockSendSms.mockRejectedValue("telnyx 500");
      expect(
        (await generateImageForSms(BIZ, "a", "+15550001111", { client: db as never })).detail
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

    it("passes the texter's photo ref through as the edit source", async () => {
      allowLimiter();
      budgetOk();
      generationOk();
      mockGetMessaging.mockResolvedValue({ apiKey: "k", messagingProfileId: "p" });
      mockSendSms.mockResolvedValue({ id: "msg-4", channel: "sms" });
      const db = stubDb();
      const result = await generateImageForSms(BIZ, "add a party hat", "+15550001111", {
        inputImageRef: GOOD_REF,
        client: db as never
      });
      expect(result.ok).toBe(true);
      expect(mockGenerateImage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputImage: expect.objectContaining({ mimeType: "image/jpeg" })
        })
      );
    });
  });
});

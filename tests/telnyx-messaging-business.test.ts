import { describe, it, expect, vi, beforeEach } from "vitest";
import { getTelnyxMessagingForBusiness } from "@/lib/telnyx/messaging";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";

describe("getTelnyxMessagingForBusiness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TELNYX_API_KEY", "platform_key");
    vi.stubEnv("TELNYX_MESSAGING_PROFILE_ID", "platform_prof");
    vi.stubEnv("TELNYX_SMS_FROM_E164", "+10000000001");
  });

  it("returns platform env when businessId is absent", async () => {
    const cfg = await getTelnyxMessagingForBusiness(null);
    expect(cfg.messagingProfileId).toBe("platform_prof");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("returns platform env when business has no row", async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({ data: null, error: null })
          })
        })
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const cfg = await getTelnyxMessagingForBusiness("biz-1");
    expect(cfg.apiKey).toBe("platform_key");
    expect(cfg.messagingProfileId).toBe("platform_prof");
    expect(cfg.fromE164).toBe("+10000000001");
  });

  it("overrides profile and from from business_telnyx_settings", async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                telnyx_messaging_profile_id: "biz_prof",
                telnyx_sms_from_e164: "+10000000002"
              },
              error: null
            })
          })
        })
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const cfg = await getTelnyxMessagingForBusiness("biz-2");
    expect(cfg.apiKey).toBe("platform_key");
    expect(cfg.messagingProfileId).toBe("biz_prof");
    expect(cfg.fromE164).toBe("+10000000002");
  });

  it("ignores empty strings in DB row and keeps platform fallbacks", async () => {
    const db = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockReturnValue({
          eq: vi.fn().mockReturnValue({
            maybeSingle: vi.fn().mockResolvedValue({
              data: {
                telnyx_messaging_profile_id: "",
                telnyx_sms_from_e164: ""
              },
              error: null
            })
          })
        })
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);

    const cfg = await getTelnyxMessagingForBusiness("biz-3");
    expect(cfg.messagingProfileId).toBe("platform_prof");
    expect(cfg.fromE164).toBe("+10000000001");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationLink } from "@/lib/notifications/display";

const { dispatchUrgentNotification, resolveContactNames, createSupabaseServiceClient, businessLookup } =
  vi.hoisted(() => {
    const businessLookup = vi.fn();
    return {
      dispatchUrgentNotification: vi.fn(),
      resolveContactNames: vi.fn(),
      businessLookup,
      createSupabaseServiceClient: vi.fn().mockResolvedValue({
        from: () => ({
          select: () => ({
            eq: () => ({ maybeSingle: businessLookup })
          })
        })
      })
    };
  });

vi.mock("@/lib/notifications/dispatch", () => ({ dispatchUrgentNotification }));
vi.mock("@/lib/db/contact-names", () => ({ resolveContactNames }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient }));

describe("notificationLink link_click", () => {
  it("deep-links to the thread href in payload", () => {
    expect(
      notificationLink({
        kind: "link_click",
        payload: { thread_href: "/dashboard/messages/%2B16025550147" }
      })
    ).toEqual({
      href: "/dashboard/messages/%2B16025550147",
      label: "Open thread"
    });
  });

  it("falls back to messages index when thread href missing", () => {
    expect(notificationLink({ kind: "link_click", payload: {} })).toEqual({
      href: "/dashboard/messages",
      label: "Open thread"
    });
  });
});

describe("notifyLinkClickFirstTap", () => {
  beforeEach(() => {
    dispatchUrgentNotification.mockReset();
    dispatchUrgentNotification.mockResolvedValue({ results: [] });
    resolveContactNames.mockReset();
    resolveContactNames.mockResolvedValue(new Map([["+16478879033", { name: "Muhammad al" }]]));
    businessLookup.mockReset();
    businessLookup.mockResolvedValue({ data: { name: "KYP Ads" }, error: null });
  });

  it("dispatches on first click with booking-link wording for calendly URLs", async () => {
    const { notifyLinkClickFirstTap } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClickFirstTap({
      ok: true,
      url: "https://calendly.com/kyp-ads/strategy",
      business_id: "biz-1",
      link_id: "link-1",
      short_code: "36q72wrm",
      click_count: 1,
      to_e164: "+16478879033",
      original_url: "https://calendly.com/kyp-ads/strategy",
      flow_id: "flow-1",
      run_id: "run-1",
      is_first_click: true
    });

    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "link_click",
        summary: "Muhammad al tapped your booking link",
        smsBody: "KYP Ads: Muhammad al (+16478879033) just opened your booking link.",
        payload: expect.objectContaining({
          thread_href: `/dashboard/messages/${encodeURIComponent("+16478879033")}`
        })
      })
    );
  });

  it("labels cal.com destinations as booking links too", async () => {
    const { notifyLinkClickFirstTap } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClickFirstTap({
      ok: true,
      url: "https://cal.com/kyp/intro",
      business_id: "biz-1",
      link_id: "link-1",
      short_code: "abc12345",
      click_count: 1,
      to_e164: "+16478879033",
      original_url: "https://cal.com/kyp/intro",
      flow_id: null,
      run_id: null,
      is_first_click: true
    });
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Muhammad al tapped your booking link" })
    );
  });

  it("falls back to the raw number and hostname when the contact is unnamed", async () => {
    resolveContactNames.mockResolvedValue(new Map());
    businessLookup.mockResolvedValue({ data: null, error: null });
    const { notifyLinkClickFirstTap } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClickFirstTap({
      ok: true,
      url: "https://www.example.com/offer",
      business_id: "biz-1",
      link_id: "link-1",
      short_code: "abc12345",
      click_count: 1,
      to_e164: "+16478879033",
      original_url: "https://www.example.com/offer",
      flow_id: null,
      run_id: null,
      is_first_click: true
    });
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "+16478879033 tapped your example.com",
        // No name resolved → no "(number)" suffix duplicating the label.
        smsBody: "Your business: +16478879033 just opened your example.com."
      })
    );
  });

  it("falls back to 'link' for a URL with an empty host and logs non-Error dispatch failures", async () => {
    dispatchUrgentNotification.mockRejectedValueOnce("string failure");
    const { notifyLinkClickFirstTap } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClickFirstTap({
      ok: true,
      url: "https://example.com/offer",
      business_id: "biz-1",
      link_id: "link-1",
      short_code: "abc12345",
      click_count: 1,
      to_e164: null,
      // Parses as a URL but carries no hostname → the `host || "link"` branch.
      original_url: "file:///local/path",
      flow_id: null,
      run_id: null,
      is_first_click: true
    });
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your link" })
    );
  });

  it("uses hostname label for non-calendly URLs and logs dispatch failures", async () => {
    dispatchUrgentNotification.mockRejectedValueOnce(new Error("smtp down"));
    const { notifyLinkClickFirstTap } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClickFirstTap({
      ok: true,
      url: "https://example.com/offer",
      business_id: "biz-1",
      link_id: "link-1",
      short_code: "abc12345",
      click_count: 1,
      to_e164: null,
      original_url: "not-a-url",
      flow_id: null,
      run_id: null,
      is_first_click: true
    });
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your link" })
    );
  });

  it("skips repeat clicks", async () => {
    const { notifyLinkClickFirstTap } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClickFirstTap({
      ok: true,
      url: "https://example.com",
      business_id: "biz-1",
      link_id: "link-1",
      short_code: "abc12345",
      click_count: 2,
      to_e164: null,
      original_url: "https://example.com",
      flow_id: null,
      run_id: null,
      is_first_click: false
    });
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationLink } from "@/lib/notifications/display";
import type { LinkClickRpcResult } from "@/lib/notifications/link-click-notify";

const {
  dispatchUrgentNotification,
  resolveContactNames,
  hasRecentNotificationForContact,
  createSupabaseServiceClient,
  businessLookup
} = vi.hoisted(() => {
  const businessLookup = vi.fn();
  return {
    dispatchUrgentNotification: vi.fn(),
    resolveContactNames: vi.fn(),
    hasRecentNotificationForContact: vi.fn(),
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
vi.mock("@/lib/db/notifications", () => ({ hasRecentNotificationForContact }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServiceClient }));

function rpcResult(overrides: Partial<LinkClickRpcResult> = {}): LinkClickRpcResult {
  return {
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
    is_first_click: true,
    is_prefetch: false,
    should_notify: true,
    ...overrides
  };
}

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

describe("notifyLinkClick", () => {
  beforeEach(() => {
    dispatchUrgentNotification.mockReset();
    dispatchUrgentNotification.mockResolvedValue({ results: [] });
    resolveContactNames.mockReset();
    resolveContactNames.mockResolvedValue(new Map([["+16478879033", { name: "Muhammad al" }]]));
    hasRecentNotificationForContact.mockReset();
    hasRecentNotificationForContact.mockResolvedValue(false);
    businessLookup.mockReset();
    businessLookup.mockResolvedValue({ data: { name: "KYP Ads" }, error: null });
  });

  it("dispatches when the RPC says should_notify, with booking-link wording for calendly URLs", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());

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

  it("skips when should_notify is false (prefetch or already notified)", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult({ should_notify: false, is_prefetch: true }));
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
    expect(hasRecentNotificationForContact).not.toHaveBeenCalled();
  });

  it("collapses per contact: a recent link_click alert suppresses this one", async () => {
    hasRecentNotificationForContact.mockResolvedValue(true);
    const { notifyLinkClick, LINK_CLICK_CONTACT_THROTTLE_MS } = await import(
      "@/lib/notifications/link-click-notify"
    );
    await notifyLinkClick(rpcResult());
    expect(hasRecentNotificationForContact).toHaveBeenCalledWith(
      "biz-1",
      "link_click",
      "+16478879033",
      LINK_CLICK_CONTACT_THROTTLE_MS,
      expect.anything()
    );
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
  });

  it("fails toward delivering when the throttle check errors (Error and non-Error)", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    hasRecentNotificationForContact.mockRejectedValueOnce(new Error("db down"));
    await notifyLinkClick(rpcResult());
    hasRecentNotificationForContact.mockRejectedValueOnce("string failure");
    await notifyLinkClick(rpcResult());
    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(2);
  });

  it("skips the throttle for group links with no recipient number", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(
      rpcResult({ to_e164: null, original_url: "https://www.example.com/offer" })
    );
    expect(hasRecentNotificationForContact).not.toHaveBeenCalled();
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your example.com" })
    );
  });

  it("labels cal.com destinations as booking links too", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(
      rpcResult({ original_url: "https://cal.com/kyp/intro", url: "https://cal.com/kyp/intro" })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Muhammad al tapped your booking link" })
    );
  });

  it("falls back to the raw number and hostname when the contact is unnamed", async () => {
    resolveContactNames.mockResolvedValue(new Map());
    businessLookup.mockResolvedValue({ data: null, error: null });
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult({ original_url: "https://www.example.com/offer" }));
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
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    // Parses as a URL but carries no hostname → the `host || "link"` branch.
    await notifyLinkClick(rpcResult({ to_e164: null, original_url: "file:///local/path" }));
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your link" })
    );
  });

  it("uses the 'link' label for unparseable URLs and logs Error dispatch failures", async () => {
    dispatchUrgentNotification.mockRejectedValueOnce(new Error("smtp down"));
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult({ to_e164: null, original_url: "not-a-url" }));
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your link" })
    );
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";
import { notificationLink } from "@/lib/notifications/display";
import type { LinkClickRpcResult } from "@/lib/notifications/link-click-notify";

const {
  dispatchUrgentNotification,
  resolveContactNames,
  hasRecentNotificationForContact,
  createSupabaseServiceClient,
  businessLookup,
  linkSourceLookup,
  linkUpdate
} = vi.hoisted(() => {
  const businessLookup = vi.fn();
  const linkSourceLookup = vi.fn();
  const linkUpdate = vi.fn();
  return {
    dispatchUrgentNotification: vi.fn(),
    resolveContactNames: vi.fn(),
    hasRecentNotificationForContact: vi.fn(),
    businessLookup,
    linkSourceLookup,
    linkUpdate,
    // Table-aware on purpose: the alert reads `businesses` for the name AND
    // `sms_links` for the sending surface, and a mock that answered both with
    // one stub would let a broken source lookup pass as a business row.
    createSupabaseServiceClient: vi.fn().mockResolvedValue({
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: table === "sms_links" ? linkSourceLookup : businessLookup
          })
        }),
        update: (patch: Record<string, unknown>) => ({
          eq: (...args: unknown[]) => linkUpdate(table, patch, ...args)
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
    linkSourceLookup.mockReset();
    linkSourceLookup.mockResolvedValue({ data: { source: "ai_flow" }, error: null });
    linkUpdate.mockReset();
    linkUpdate.mockResolvedValue({ data: null, error: null });
  });

  it("dispatches when the RPC says should_notify, with booking-link wording for calendly URLs", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());

    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "link_click",
        summary: "Muhammad al tapped your booking link: calendly.com/kyp-ads/strategy",
        smsBody:
          "KYP Ads: Muhammad al (+16478879033) just opened your booking link: calendly.com/kyp-ads/strategy",
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

  it("never alerts on an untracked owner/teammate link, even if should_notify says true", async () => {
    // The owner tapping his own AiFlow alert is not lead engagement. Asserted
    // against a should_notify:true payload on purpose: the guarantee must not
    // depend on the RPC also getting that flag right.
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult({ tracked: false, should_notify: true }));
    expect(dispatchUrgentNotification).not.toHaveBeenCalled();
    expect(hasRecentNotificationForContact).not.toHaveBeenCalled();
  });

  it("collapses per contact: a recent link_click alert suppresses this one and releases the stamp", async () => {
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
    // The suppressed link gets its alert back for a later engagement moment.
    expect(linkUpdate).toHaveBeenCalledWith("sms_links", { notified_at: null }, "id", "link-1");
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
      expect.objectContaining({ summary: "A lead tapped your example.com/offer" })
    );
  });

  it("labels cal.com destinations as booking links too", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(
      rpcResult({ original_url: "https://cal.com/kyp/intro", url: "https://cal.com/kyp/intro" })
    );
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "Muhammad al tapped your booking link: cal.com/kyp/intro" })
    );
  });

  it("falls back to the raw number and hostname when the contact is unnamed", async () => {
    resolveContactNames.mockResolvedValue(new Map());
    businessLookup.mockResolvedValue({ data: null, error: null });
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult({ original_url: "https://www.example.com/offer" }));
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        summary: "+16478879033 tapped your example.com/offer",
        // No name resolved → no "(number)" suffix duplicating the label.
        smsBody: "Your business: +16478879033 just opened your example.com/offer"
      })
    );
  });

  it("falls back to 'link' for a URL with an empty host; a non-Error dispatch failure releases the stamp", async () => {
    dispatchUrgentNotification.mockRejectedValueOnce("string failure");
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    // Parses as a URL but carries no hostname, so the path alone is the label.
    await notifyLinkClick(rpcResult({ to_e164: null, original_url: "file:///local/path" }));
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your /local/path" })
    );
    // Thrown dispatch → notified_at released so the next human tap retries.
    expect(linkUpdate).toHaveBeenCalledWith("sms_links", { notified_at: null }, "id", "link-1");
  });

  it("uses the 'link' label for unparseable URLs and releases the stamp on Error dispatch failures", async () => {
    dispatchUrgentNotification.mockRejectedValueOnce(new Error("smtp down"));
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult({ to_e164: null, original_url: "not-a-url" }));
    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({ summary: "A lead tapped your link" })
    );
    expect(linkUpdate).toHaveBeenCalledWith("sms_links", { notified_at: null }, "id", "link-1");
  });

  it("keeps the stamp on success, and stays at-most-once when the release itself fails", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());
    expect(linkUpdate).not.toHaveBeenCalled();

    dispatchUrgentNotification.mockRejectedValueOnce(new Error("smtp down"));
    linkUpdate.mockRejectedValueOnce(new Error("db down"));
    await expect(notifyLinkClick(rpcResult())).resolves.toBeUndefined();

    dispatchUrgentNotification.mockRejectedValueOnce(new Error("smtp down"));
    linkUpdate.mockRejectedValueOnce("string failure");
    await expect(notifyLinkClick(rpcResult())).resolves.toBeUndefined();
  });
});

describe("describeLinkDestination", () => {
  it("names a Stripe Checkout URL a payment link", async () => {
    const { describeLinkDestination } = await import("@/lib/notifications/link-click-notify");
    const { label } = describeLinkDestination("https://checkout.stripe.com/c/pay/cs_live_abc");
    expect(label).toBe("payment link");
  });

  it("names a link on our own /pay/ path a payment link too", async () => {
    const { describeLinkDestination } = await import("@/lib/notifications/link-click-notify");
    expect(describeLinkDestination("https://www.newcoworker.com/pay/tok_1").label).toBe(
      "payment link"
    );
  });

  it("names our /book/ path a booking link", async () => {
    const { describeLinkDestination } = await import("@/lib/notifications/link-click-notify");
    expect(describeLinkDestination("https://newcoworker.com/book/ncb_abc").label).toBe(
      "booking link"
    );
  });

  // The exact confusion that prompted this: a lead asked to pay and was sent
  // the questionnaire. The two must never read alike in an alert.
  it("names the onboarding questionnaire, distinctly from a payment link", async () => {
    const { describeLinkDestination, linkDestinationPhrase } = await import(
      "@/lib/notifications/link-click-notify"
    );
    const url = "https://www.newcoworker.com/onboard/questionnaire?tier=standard&period=monthly";
    expect(describeLinkDestination(url).label).toBe("signup questionnaire");
    expect(linkDestinationPhrase(url)).toBe(
      "signup questionnaire: newcoworker.com/onboard/questionnaire"
    );
  });

  it("truncates an address too long to inline, keeping the alert one SMS", async () => {
    const { describeLinkDestination } = await import("@/lib/notifications/link-click-notify");
    const { display } = describeLinkDestination(
      `https://checkout.stripe.com/c/pay/${"cs_live_".repeat(20)}`
    );
    expect(display.length).toBe(60);
    expect(display.endsWith("...")).toBe(true);
  });

  it("falls back to 'link' when there is no host and no path", async () => {
    const { describeLinkDestination, linkDestinationPhrase } = await import(
      "@/lib/notifications/link-click-notify"
    );
    expect(describeLinkDestination("file:///")).toEqual({ label: "link", display: "link" });
    // label === display, so the phrase must not read "link: link".
    expect(linkDestinationPhrase("file:///")).toBe("link");
  });

  it("falls back to 'link' for an unparseable URL", async () => {
    const { linkDestinationPhrase } = await import("@/lib/notifications/link-click-notify");
    expect(linkDestinationPhrase("not-a-url")).toBe("link");
  });
});

describe("linkSourceLabel", () => {
  it("maps known sending surfaces to owner-readable text", async () => {
    const { linkSourceLabel } = await import("@/lib/notifications/link-click-notify");
    expect(linkSourceLabel("sms_auto_reply")).toBe("your AI coworker's reply");
    expect(linkSourceLabel("ai_flow")).toBe("an AiFlow");
    expect(linkSourceLabel("aiflow")).toBe("an AiFlow");
    expect(linkSourceLabel("voice_follow_up")).toBe("a call follow up");
    expect(linkSourceLabel("owner_notify")).toBe("an owner alert");
    expect(linkSourceLabel("owner_manual")).toBe("a message you sent");
  });

  it("passes an unknown source through rather than hiding it", async () => {
    const { linkSourceLabel } = await import("@/lib/notifications/link-click-notify");
    expect(linkSourceLabel("some_new_surface")).toBe("some_new_surface");
  });

  it("returns null when there is no source", async () => {
    const { linkSourceLabel } = await import("@/lib/notifications/link-click-notify");
    expect(linkSourceLabel(null)).toBeNull();
    expect(linkSourceLabel(undefined)).toBeNull();
  });
});

describe("notifyLinkClick alert contents", () => {
  beforeEach(() => {
    dispatchUrgentNotification.mockReset();
    dispatchUrgentNotification.mockResolvedValue({ results: [] });
    resolveContactNames.mockReset();
    resolveContactNames.mockResolvedValue(new Map([["+16478879033", { name: "Muhammad al" }]]));
    hasRecentNotificationForContact.mockReset();
    hasRecentNotificationForContact.mockResolvedValue(false);
    businessLookup.mockReset();
    businessLookup.mockResolvedValue({ data: { name: "KYP Ads" }, error: null });
    linkSourceLookup.mockReset();
    linkSourceLookup.mockResolvedValue({ data: { source: "sms_auto_reply" }, error: null });
    linkUpdate.mockReset();
    linkUpdate.mockResolvedValue({ data: null, error: null });
  });

  it("carries the untruncated destination and the sending surface in the email", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    const url = "https://www.newcoworker.com/onboard/questionnaire?tier=standard&period=monthly";
    await notifyLinkClick(rpcResult({ original_url: url, url }));

    expect(dispatchUrgentNotification).toHaveBeenCalledWith(
      expect.objectContaining({
        emailSubject: "Lead link click: Muhammad al opened your signup questionnaire",
        // Full URL, query string included: the email has room the SMS does not.
        emailBody: [
          "Muhammad al (+16478879033) opened your signup questionnaire: newcoworker.com/onboard/questionnaire.",
          `Where it went: ${url}`,
          "Sent by: your AI coworker's reply"
        ].join("\n\n"),
        ctaPath: `/dashboard/messages/${encodeURIComponent("+16478879033")}`,
        ctaLabel: "Open the conversation",
        payload: expect.objectContaining({
          destination_label: "signup questionnaire",
          source: "your AI coworker's reply"
        })
      })
    );
  });

  it("omits the attribution line when the link has no recorded source", async () => {
    linkSourceLookup.mockResolvedValue({ data: { source: null }, error: null });
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());

    const call = dispatchUrgentNotification.mock.calls[0][0];
    expect(call.emailBody).not.toContain("Sent by:");
    expect(call.payload.source).toBeNull();
  });

  it("still alerts when the source lookup fails; attribution is not worth losing the alert over", async () => {
    linkSourceLookup.mockRejectedValueOnce(new Error("db down"));
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());

    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(1);
    expect(dispatchUrgentNotification.mock.calls[0][0].emailBody).not.toContain("Sent by:");
  });

  it("still alerts when the source lookup rejects with a non-Error", async () => {
    linkSourceLookup.mockRejectedValueOnce("string failure");
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());
    expect(dispatchUrgentNotification).toHaveBeenCalledTimes(1);
  });

  it("reads the source from sms_links, not from the businesses row", async () => {
    const { notifyLinkClick } = await import("@/lib/notifications/link-click-notify");
    await notifyLinkClick(rpcResult());
    expect(linkSourceLookup).toHaveBeenCalled();
  });
});

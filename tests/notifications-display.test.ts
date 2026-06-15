import { describe, it, expect } from "vitest";
import {
  applyContactNamesToEventLinks,
  eventLinkE164,
  notificationDetailFields,
  notificationEventLinks,
  notificationLink
} from "@/lib/notifications/display";

describe("notifications/display", () => {
  describe("notificationLink", () => {
    it("routes SMS cap alerts to Billing", () => {
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "sms_cap_reached" } })
      ).toEqual({ href: "/dashboard/billing", label: "Open Billing" });
    });

    it("routes chat spend cap alerts to Billing", () => {
      expect(
        notificationLink({
          kind: "urgent_alert",
          payload: { taskType: "chat_spend_cap_reached" }
        })
      ).toEqual({ href: "/dashboard/billing", label: "Open Billing" });
    });

    it("routes flow task types to AiFlows", () => {
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "ai_flow_failed" } })
      ).toEqual({ href: "/dashboard/aiflows", label: "Open AiFlows" });
    });

    it("routes voice captures to Calls by kind", () => {
      expect(notificationLink({ kind: "voice_capture", payload: {} })).toEqual({
        href: "/dashboard/calls",
        label: "Open Calls"
      });
    });

    it("routes call/voice task types to Calls", () => {
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "call_capture" } })
      ).toEqual({ href: "/dashboard/calls", label: "Open Calls" });
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "voice_bridge_down" } })
      ).toEqual({ href: "/dashboard/calls", label: "Open Calls" });
    });

    it("falls back to the dashboard for other urgent alerts", () => {
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "something_else" } })
      ).toEqual({ href: "/dashboard", label: "Open Dashboard" });
    });

    it("handles urgent alerts with a missing/non-string taskType", () => {
      expect(notificationLink({ kind: "urgent_alert", payload: {} })).toEqual({
        href: "/dashboard",
        label: "Open Dashboard"
      });
      expect(notificationLink({ kind: "urgent_alert", payload: { taskType: 42 } })).toEqual({
        href: "/dashboard",
        label: "Open Dashboard"
      });
    });

    it("returns null for digests and unknown kinds", () => {
      expect(notificationLink({ kind: "digest", payload: { window: "daily" } })).toBeNull();
      expect(notificationLink({ kind: null, payload: null })).toBeNull();
    });
  });

  describe("notificationDetailFields", () => {
    it("renders digest fields with window labels", () => {
      expect(
        notificationDetailFields({
          kind: "digest",
          payload: {
            window: "weekly",
            recipient: "owner@biz.com",
            activitySummary: "44 events, 3 texts"
          }
        })
      ).toEqual([
        { label: "Window", value: "Weekly" },
        { label: "Sent to", value: "owner@biz.com" },
        { label: "Activity", value: "44 events, 3 texts" }
      ]);
    });

    it("labels daily windows and trims values", () => {
      expect(
        notificationDetailFields({
          kind: "digest",
          payload: { window: "daily", recipient: "  o@b.com  " }
        })
      ).toEqual([
        { label: "Window", value: "Daily" },
        { label: "Sent to", value: "o@b.com" }
      ]);
    });

    it("renders urgent-alert fields (summary, taskType, period)", () => {
      expect(
        notificationDetailFields({
          kind: "urgent_alert",
          payload: {
            summary: "Monthly SMS limit reached",
            taskType: "sms_cap_reached",
            period_key: "2026-06"
          }
        })
      ).toEqual([
        { label: "Detail", value: "Monthly SMS limit reached" },
        { label: "Event", value: "sms cap reached" },
        { label: "Period", value: "2026-06" }
      ]);
    });

    it("skips blank, missing, and non-string values", () => {
      expect(
        notificationDetailFields({
          kind: "urgent_alert",
          payload: { summary: "   ", taskType: 7, recipient: null }
        })
      ).toEqual([]);
      expect(notificationDetailFields({ kind: null, payload: null })).toEqual([]);
    });
  });

  describe("notificationEventLinks", () => {
    it("returns the validated events from a digest payload", () => {
      expect(
        notificationEventLinks({
          kind: "digest",
          payload: {
            events: [
              { label: "Call — +15551111111 (completed)", href: "/dashboard/calls", at: "2026-06-11T10:00:00Z" },
              { label: " Texts — 2 received, 1 sent ", href: "/dashboard/messages" }
            ]
          }
        })
      ).toEqual([
        {
          label: "Call — +15551111111 (completed)",
          href: "/dashboard/calls",
          at: "2026-06-11T10:00:00Z"
        },
        { label: "Texts — 2 received, 1 sent", href: "/dashboard/messages" }
      ]);
    });

    it("returns [] when events are missing or not an array", () => {
      expect(notificationEventLinks({ kind: "digest", payload: null })).toEqual([]);
      expect(notificationEventLinks({ kind: "digest", payload: {} })).toEqual([]);
      expect(notificationEventLinks({ kind: "digest", payload: { events: "junk" } })).toEqual([]);
    });

    it("drops malformed entries and non-relative hrefs (tamper defence)", () => {
      expect(
        notificationEventLinks({
          kind: "digest",
          payload: {
            events: [
              null,
              "string",
              { label: "", href: "/dashboard/calls" },
              { label: "no href" },
              { label: "external", href: "https://evil.example.com" },
              { label: "protocol-relative", href: "//evil.example.com/phish" },
              { label: "bad at", href: "/dashboard/calls", at: 42 },
              { label: "empty at", href: "/dashboard/calls", at: "" },
              { label: "ok", href: "/dashboard/aiflows" }
            ]
          }
        })
      ).toEqual([
        { label: "bad at", href: "/dashboard/calls" },
        { label: "empty at", href: "/dashboard/calls" },
        { label: "ok", href: "/dashboard/aiflows" }
      ]);
    });
  });

  describe("eventLinkE164", () => {
    it("decodes the E.164 from a text-thread deep link", () => {
      expect(eventLinkE164("/dashboard/messages/%2B15550001111")).toBe("+15550001111");
    });

    it("returns null for non-text-thread hrefs", () => {
      expect(eventLinkE164("/dashboard/calls")).toBeNull();
      expect(eventLinkE164("/dashboard/customers/%2B15550001111")).toBeNull();
    });

    it("returns null when the encoded segment is malformed", () => {
      expect(eventLinkE164("/dashboard/messages/%E0%A4%A")).toBeNull();
    });
  });

  describe("applyContactNamesToEventLinks", () => {
    const events = [
      { label: "Texts with +15550001111 — 0 received, 10 sent", href: "/dashboard/messages/%2B15550001111" },
      { label: "New customer — Mike Haas (+15550001111)", href: "/dashboard/customers/%2B15550001111" },
      { label: "Call — +15550009999 (completed)", href: "/dashboard/calls" }
    ];

    it("substitutes known names into text-thread labels only", () => {
      const names = new Map([["+15550001111", "Mike Haas"]]);
      expect(applyContactNamesToEventLinks(events, names)).toEqual([
        { label: "Texts with Mike Haas — 0 received, 10 sent", href: "/dashboard/messages/%2B15550001111" },
        // Customer + call events are left untouched (already named / no thread link).
        { label: "New customer — Mike Haas (+15550001111)", href: "/dashboard/customers/%2B15550001111" },
        { label: "Call — +15550009999 (completed)", href: "/dashboard/calls" }
      ]);
    });

    it("leaves a text-thread label unchanged when the number is unknown", () => {
      const names = new Map([["+19998887777", "Someone Else"]]);
      expect(applyContactNamesToEventLinks(events, names)).toEqual(events);
    });

    it("returns the events untouched when the name map is empty", () => {
      const empty = new Map<string, string>();
      const result = applyContactNamesToEventLinks(events, empty);
      expect(result).toBe(events);
    });
  });
});

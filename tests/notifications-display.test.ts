import { describe, it, expect } from "vitest";
import {
  notificationDetailFields,
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
});

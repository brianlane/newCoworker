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
    const UUID = "163bee63-4175-4782-b5a8-01bcb7ea57f6";
    const FLOW_UUID = "94f2156f-90c9-479d-b795-992f0561294a";

    it("sends a booking alert to the contact page, where the owner picker is", () => {
      // The generic contactE164 branch would send these to the text thread,
      // which is not where you assign a lead. Both booking kinds must match
      // the email's own button.
      for (const kind of ["unassigned_booking", "assigned_booking"]) {
        expect(
          notificationLink({ kind, payload: { contactE164: "+12187702372" } })
        ).toEqual({
          href: "/dashboard/customers/%2B12187702372",
          label: "Open contact"
        });
      }
    });

    it("falls back to the bookings list when a booking alert carried no phone", () => {
      expect(notificationLink({ kind: "unassigned_booking", payload: {} })).toEqual({
        href: "/dashboard/bookings",
        label: "Open Bookings"
      });
    });

    it("prefers an href the producer already stamped", () => {
      expect(
        notificationLink({
          kind: "link_click",
          payload: { thread_href: "/dashboard/messages/%2B14805551212" }
        })
      ).toEqual({ href: "/dashboard/messages/%2B14805551212", label: "Open thread" });
    });

    it("ignores a stamped href that would leave the dashboard", () => {
      // Protocol-relative: browsers resolve "//evil.example.com" off-site. A
      // link click is still a text-thread event, so it stays on Messages.
      expect(
        notificationLink({ kind: "link_click", payload: { thread_href: "//evil.example.com" } })
      ).toEqual({ href: "/dashboard/messages", label: "Open thread" });
      expect(
        notificationLink({
          kind: "link_click",
          payload: { thread_href: "https://evil.example.com" }
        })
      ).toEqual({ href: "/dashboard/messages", label: "Open thread" });
    });

    it("uses the clicked recipient's thread when no href was stamped", () => {
      expect(
        notificationLink({ kind: "link_click", payload: { to_e164: "+14805551212" } })
      ).toEqual({ href: "/dashboard/messages/%2B14805551212", label: "Open text thread" });
    });

    it("opens the texter's thread for a notify_team alert", () => {
      // The live shape: src/app/api/rowboat/tool-call stamps customerPhone.
      expect(
        notificationLink({
          kind: "sms_team_notify",
          payload: { customerPhone: "+14803386269", customerName: "Stacey Riggs" }
        })
      ).toEqual({ href: "/dashboard/messages/%2B14803386269", label: "Open text thread" });
    });

    it("opens the contact's thread for needs-human and customer-reply alerts", () => {
      for (const taskType of ["sms_needs_human", "sms_customer_reply"]) {
        expect(
          notificationLink({ kind: "urgent_alert", payload: { taskType, contactE164: "+12546305870" } })
        ).toEqual({ href: "/dashboard/messages/%2B12546305870", label: "Open text thread" });
      }
    });

    it("addresses short-code threads too", () => {
      expect(
        notificationLink({ kind: "sms_team_notify", payload: { customerPhone: "62240" } })
      ).toEqual({ href: "/dashboard/messages/62240", label: "Open text thread" });
    });

    it("drops a malformed phone rather than linking somewhere broken", () => {
      expect(
        notificationLink({ kind: "sms_team_notify", payload: { customerPhone: "602-695-1142" } })
      ).toEqual({ href: "/dashboard/activity", label: "Open Activity" });
      expect(
        notificationLink({ kind: "sms_team_notify", payload: { customerPhone: 42 } })
      ).toEqual({ href: "/dashboard/activity", label: "Open Activity" });
      expect(
        notificationLink({ kind: "sms_team_notify", payload: { customerPhone: "   " } })
      ).toEqual({ href: "/dashboard/activity", label: "Open Activity" });
    });

    it("opens the call transcript the page resolved for voice alerts", () => {
      for (const kind of ["voice_capture", "voice_team_notify"]) {
        expect(
          notificationLink({ kind, payload: { transcriptId: UUID, callerPhone: "+14805551212" } })
        ).toEqual({ href: `/dashboard/calls/${UUID}`, label: "Open call" });
      }
    });

    it("falls back to the caller's profile when no transcript resolved", () => {
      expect(
        notificationLink({ kind: "voice_team_notify", payload: { callerPhone: "+14805551212" } })
      ).toEqual({ href: "/dashboard/customers/%2B14805551212", label: "Open contact" });
    });

    it("falls back to the calls list when a voice alert names nobody", () => {
      expect(notificationLink({ kind: "voice_capture", payload: {} })).toEqual({
        href: "/dashboard/calls",
        label: "Open Calls"
      });
      // A tampered (non-UUID) transcript id must not reach the URL.
      expect(
        notificationLink({ kind: "voice_capture", payload: { transcriptId: "../../etc" } })
      ).toEqual({ href: "/dashboard/calls", label: "Open Calls" });
    });

    it("opens the document for signed/expired/expiring alerts", () => {
      for (const kind of ["document_signed", "document_expired", "document_expiring"]) {
        expect(notificationLink({ kind, payload: { documentId: UUID } })).toEqual({
          href: `/dashboard/documents/${UUID}`,
          label: "Open document"
        });
      }
    });

    it("falls back to the documents list without a usable document id", () => {
      expect(notificationLink({ kind: "document_signed", payload: {} })).toEqual({
        href: "/dashboard/documents",
        label: "Open Documents"
      });
    });

    it("opens the texter's thread for an SMS image cap", () => {
      // On the SMS surface the session key IS the texter's number.
      expect(
        notificationLink({
          kind: "image_limit",
          payload: { surface: "sms", sessionKey: "+14805551212" }
        })
      ).toEqual({ href: "/dashboard/messages/%2B14805551212", label: "Open text thread" });
    });

    it("opens dashboard chat for a dashboard image cap", () => {
      expect(
        notificationLink({
          kind: "image_limit",
          payload: { surface: "dashboard", sessionKey: "session-123" }
        })
      ).toEqual({ href: "/dashboard/chat", label: "Open Chat" });
    });

    it("routes email handoffs to Emails", () => {
      expect(
        notificationLink({ kind: "email_coworker_handoff", payload: { thread_id: "abc" } })
      ).toEqual({ href: "/dashboard/emails", label: "Open Emails" });
    });

    it("opens the contact for a bounced customer email, not Activity or their thread", () => {
      // Email and push already used ctaPath (contact page). The dashboard
      // list used to fall through to Activity because this kind was missing
      // and the payload stamps `to_e164`, not `contactE164`.
      expect(
        notificationLink({
          kind: "contact_email_bounce",
          payload: { to_e164: "+13023538730", address: "benjamin@dead.example" }
        })
      ).toEqual({
        href: "/dashboard/customers/%2B13023538730",
        label: "Open contact"
      });
      expect(
        notificationLink({
          kind: "contact_email_bounce",
          payload: { contactE164: "+13023538730" }
        })
      ).toEqual({
        href: "/dashboard/customers/%2B13023538730",
        label: "Open contact"
      });
    });

    it("falls back to Emails when a bounce alert carried no phone", () => {
      expect(notificationLink({ kind: "contact_email_bounce", payload: {} })).toEqual({
        href: "/dashboard/emails",
        label: "Open Emails"
      });
    });

    it("routes connection alerts to Integrations", () => {
      for (const kind of ["byon_port", "byon_activation", "calendar_connection_broken"]) {
        expect(notificationLink({ kind, payload: {} })).toEqual({
          href: "/dashboard/integrations",
          label: "Open Integrations"
        });
      }
    });

    it("routes spend cap alerts to Billing", () => {
      for (const taskType of ["sms_cap_reached", "chat_spend_cap_reached"]) {
        expect(notificationLink({ kind: "urgent_alert", payload: { taskType } })).toEqual({
          href: "/dashboard/billing",
          label: "Open Billing"
        });
      }
    });

    it("opens the failing run for a flow alert", () => {
      expect(
        notificationLink({
          kind: "urgent_alert",
          payload: { taskType: "aiflow_run_failed", runId: UUID, flowId: FLOW_UUID }
        })
      ).toEqual({
        href: `/dashboard/aiflows/runs?flowId=${FLOW_UUID}&run=${UUID}`,
        label: "Open flow run"
      });
    });

    it("opens the run without a flow id on older alerts", () => {
      // Rows dispatched before the edge function stamped flowId.
      expect(
        notificationLink({
          kind: "urgent_alert",
          payload: { taskType: "aiflow_run_failed", runId: UUID }
        })
      ).toEqual({ href: `/dashboard/aiflows/runs?run=${UUID}`, label: "Open flow run" });
    });

    it("falls back to AiFlows for a flow alert with no run", () => {
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "ai_flow_failed" } })
      ).toEqual({ href: "/dashboard/aiflows", label: "Open AiFlows" });
    });

    it("routes call/voice task types to Calls", () => {
      for (const taskType of ["call_capture", "voice_bridge_down", "missed_call_spike"]) {
        expect(notificationLink({ kind: "urgent_alert", payload: { taskType } })).toEqual({
          href: "/dashboard/calls",
          label: "Open Calls"
        });
      }
    });

    it("falls back to the activity feed for digests and anything unrecognized", () => {
      expect(notificationLink({ kind: "digest", payload: { window: "daily" } })).toEqual({
        href: "/dashboard/activity",
        label: "Open Activity"
      });
      expect(notificationLink({ kind: null, payload: null })).toEqual({
        href: "/dashboard/activity",
        label: "Open Activity"
      });
      expect(
        notificationLink({ kind: "urgent_alert", payload: { taskType: "something_else" } })
      ).toEqual({ href: "/dashboard/activity", label: "Open Activity" });
      expect(notificationLink({ kind: "urgent_alert", payload: { taskType: 42 } })).toEqual({
        href: "/dashboard/activity",
        label: "Open Activity"
      });
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

    it("prefers the untruncated payload.message over the capped summary for Detail", () => {
      // notify_team stores the full model-written request as payload.message
      // and a list-capped headline as payload.summary; the expanded card must
      // show the whole thing (Amy's Jul 31 2026 alert lost the budget and the
      // claimed agent to the cap).
      expect(
        notificationDetailFields({
          kind: "sms_team_notify",
          payload: {
            summary: "Texter follow-up needed: New buyer lead…",
            message: "New buyer lead. Budget around $412K. Jason Lane is the claimed agent."
          }
        })
      ).toEqual([
        {
          label: "Detail",
          value: "New buyer lead. Budget around $412K. Jason Lane is the claimed agent."
        }
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
              { label: "Call: +15551111111 (completed)", href: "/dashboard/calls", at: "2026-06-11T10:00:00Z" },
              { label: " Texts: 2 received, 1 sent ", href: "/dashboard/messages" }
            ]
          }
        })
      ).toEqual([
        {
          label: "Call: +15551111111 (completed)",
          href: "/dashboard/calls",
          at: "2026-06-11T10:00:00Z"
        },
        { label: "Texts: 2 received, 1 sent", href: "/dashboard/messages" }
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
      { label: "Texts with +15550001111: 0 received, 10 sent", href: "/dashboard/messages/%2B15550001111" },
      { label: "New customer: Mike Haas (+15550001111)", href: "/dashboard/customers/%2B15550001111" },
      { label: "Call: +15550009999 (completed)", href: "/dashboard/calls" }
    ];

    it("substitutes known names into text-thread labels only", () => {
      const names = new Map([["+15550001111", "Mike Haas"]]);
      expect(applyContactNamesToEventLinks(events, names)).toEqual([
        { label: "Texts with Mike Haas: 0 received, 10 sent", href: "/dashboard/messages/%2B15550001111" },
        // Customer + call events are left untouched (already named / no thread link).
        { label: "New customer: Mike Haas (+15550001111)", href: "/dashboard/customers/%2B15550001111" },
        { label: "Call: +15550009999 (completed)", href: "/dashboard/calls" }
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

describe("notificationDetailFields: contact-owner routing", () => {
  it("names the teammate a redirected alert reached", () => {
    const fields = notificationDetailFields({
      payload: {
        recipient: "+16025245719",
        routed_to: "contact_owner",
        routed_member_name: "Dave Lane"
      }
    } as never);
    expect(fields).toContainEqual({ label: "Routed to", value: "Dave Lane" });
  });

  it("falls back to a generic label when the roster name is missing", () => {
    const fields = notificationDetailFields({
      payload: { routed_to: "contact_owner", routed_member_name: null }
    } as never);
    expect(fields).toContainEqual({ label: "Routed to", value: "The lead's owner" });
  });

  it("says business owner when nothing redirected", () => {
    const fields = notificationDetailFields({
      payload: { routed_to: "business_owner", routing_reason: "contact_unowned" }
    } as never);
    expect(fields).toContainEqual({ label: "Routed to", value: "Business owner" });
  });

  it("omits the field entirely for a business-level alert", () => {
    const fields = notificationDetailFields({ payload: { recipient: "o@x.co" } } as never);
    expect(fields.some((f) => f.label === "Routed to")).toBe(false);
  });
});

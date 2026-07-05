"use strict";

/**
 * The four REST-hook triggers. Sample payloads must mirror
 * supabase/functions/_shared/webhook_events.ts::buildWebhookPayload —
 * they are what the Zap editor shows before real data arrives.
 */

const { makeHookTrigger } = require("./hook-factory");

const smsInbound = makeHookTrigger({
  key: "sms_inbound",
  event: "sms.inbound",
  noun: "Text Message",
  label: "New Inbound Text",
  description: "Triggers when a customer texts your coworker's number.",
  sample: {
    event: "sms.inbound",
    business_id: "3f2a1b4c-0000-0000-0000-000000000001",
    id: "9e8d7c6b-0000-0000-0000-000000000002",
    occurred_at: "2026-07-01T17:03:21.000Z",
    data: {
      from: "+16025551234",
      text: "Hi, are you available Saturday?",
      channel: "sms"
    }
  }
});

const smsOutbound = makeHookTrigger({
  key: "sms_outbound",
  event: "sms.outbound",
  noun: "Text Message",
  label: "New Outbound Text",
  description:
    "Triggers when your coworker (or you) sends a text — useful for logging conversations to a CRM or spreadsheet.",
  sample: {
    event: "sms.outbound",
    business_id: "3f2a1b4c-0000-0000-0000-000000000001",
    id: "9e8d7c6b-0000-0000-0000-000000000003",
    occurred_at: "2026-07-01T17:04:02.000Z",
    data: {
      to: "+16025551234",
      from: "+16025550100",
      text: "Yes! I have 10am or 2pm open on Saturday.",
      source: "ai_flow",
      channel: "sms"
    }
  }
});

const callCompleted = makeHookTrigger({
  key: "call_completed",
  event: "call.completed",
  noun: "Call",
  label: "Call Completed",
  description:
    "Triggers when a phone call handled by your coworker ends, with the summary and sentiment.",
  sample: {
    event: "call.completed",
    business_id: "3f2a1b4c-0000-0000-0000-000000000001",
    id: "9e8d7c6b-0000-0000-0000-000000000004",
    occurred_at: "2026-07-01T17:10:44.000Z",
    data: {
      caller: "+16025551234",
      direction: "inbound",
      status: "completed",
      started_at: "2026-07-01T17:08:02.000Z",
      ended_at: "2026-07-01T17:10:41.000Z",
      summary: "Caller asked about weekend availability; booked Saturday 10am.",
      sentiment: "positive"
    }
  }
});

const emailInbound = makeHookTrigger({
  key: "email_inbound",
  event: "email.inbound",
  noun: "Email",
  label: "New Inbound Email",
  description: "Triggers when your coworker's AI mailbox receives an email.",
  sample: {
    event: "email.inbound",
    business_id: "3f2a1b4c-0000-0000-0000-000000000001",
    id: "9e8d7c6b-0000-0000-0000-000000000005",
    occurred_at: "2026-07-01T17:15:00.000Z",
    data: {
      from: "customer@example.com",
      to: "amy@ai.newcoworker.com",
      subject: "Quote request",
      body_preview: "Hi, could you send me a quote for a two-story exterior…"
    }
  }
});

module.exports = { smsInbound, smsOutbound, callCompleted, emailInbound };

import { describe, expect, it } from "vitest";

import {
  WEBHOOK_EVENT_SOURCES,
  WEBHOOK_EVENT_TYPES,
  buildWebhookPayload,
  inboundSmsTextFromEnvelope,
  isWebhookEventType
} from "../supabase/functions/_shared/webhook_events";

describe("isWebhookEventType", () => {
  it("accepts the four event types and rejects everything else", () => {
    for (const t of WEBHOOK_EVENT_TYPES) expect(isWebhookEventType(t)).toBe(true);
    expect(isWebhookEventType("sms.deleted")).toBe(false);
    expect(isWebhookEventType("")).toBe(false);
    expect(isWebhookEventType(42)).toBe(false);
    expect(isWebhookEventType(null)).toBe(false);
  });

  it("every event type has a source table config", () => {
    for (const t of WEBHOOK_EVENT_TYPES) {
      expect(WEBHOOK_EVENT_SOURCES[t].table).toBeTruthy();
      expect(WEBHOOK_EVENT_SOURCES[t].select).toContain("created_at");
    }
  });
});

describe("inboundSmsTextFromEnvelope", () => {
  it("reads text from the Telnyx envelope", () => {
    expect(
      inboundSmsTextFromEnvelope({ data: { payload: { text: "hi there" } } })
    ).toBe("hi there");
  });

  it("falls back to legacy body string", () => {
    expect(inboundSmsTextFromEnvelope({ data: { payload: { body: "legacy" } } })).toBe(
      "legacy"
    );
  });

  it("degrades to empty string for junk", () => {
    expect(inboundSmsTextFromEnvelope(null)).toBe("");
    expect(inboundSmsTextFromEnvelope("string")).toBe("");
    expect(inboundSmsTextFromEnvelope({})).toBe("");
    expect(inboundSmsTextFromEnvelope({ data: { payload: { text: 5 } } })).toBe("");
  });
});

describe("buildWebhookPayload", () => {
  it("shapes sms.inbound from the job row", () => {
    const payload = buildWebhookPayload("sms.inbound", {
      id: "row-1",
      created_at: "2026-07-01T00:00:00Z",
      business_id: "biz-1",
      customer_e164: "+16025551234",
      channel: "sms",
      payload: { data: { payload: { text: "hello" } } }
    });
    expect(payload).toEqual({
      event: "sms.inbound",
      business_id: "biz-1",
      id: "row-1",
      occurred_at: "2026-07-01T00:00:00Z",
      data: { from: "+16025551234", text: "hello", channel: "sms" }
    });
  });

  it("shapes sms.outbound from the log row", () => {
    const payload = buildWebhookPayload("sms.outbound", {
      id: "row-2",
      created_at: "2026-07-01T00:01:00Z",
      business_id: "biz-1",
      to_e164: "+16025551234",
      from_e164: "+16025550100",
      body: "reply",
      source: "api",
      channel: "rcs"
    });
    expect(payload.data).toEqual({
      to: "+16025551234",
      from: "+16025550100",
      text: "reply",
      source: "api",
      channel: "rcs"
    });
  });

  it("shapes call.completed from the transcript row", () => {
    const payload = buildWebhookPayload("call.completed", {
      id: "row-3",
      created_at: "2026-07-01T00:02:00Z",
      business_id: "biz-1",
      caller_e164: "+16025551234",
      direction: "inbound",
      status: "completed",
      started_at: "2026-07-01T00:00:00Z",
      ended_at: "2026-07-01T00:01:50Z",
      summary: "Booked Saturday",
      sentiment: "positive"
    });
    expect(payload.data.summary).toBe("Booked Saturday");
    expect(payload.data.caller).toBe("+16025551234");
  });

  it("shapes email.inbound and nulls missing fields", () => {
    const payload = buildWebhookPayload("email.inbound", {
      id: "row-4",
      created_at: "2026-07-01T00:03:00Z",
      business_id: "biz-1",
      from_email: "c@example.com",
      to_email: "amy@ai.example.com"
    });
    expect(payload.data).toEqual({
      from: "c@example.com",
      to: "amy@ai.example.com",
      subject: null,
      body_preview: null
    });
  });

  it("defaults missing business_id and channel gracefully", () => {
    const payload = buildWebhookPayload("sms.inbound", {
      id: "row-5",
      created_at: "2026-07-01T00:04:00Z"
    });
    expect(payload.business_id).toBe("");
    expect(payload.data.channel).toBe("sms");

    const outbound = buildWebhookPayload("sms.outbound", {
      id: "row-6",
      created_at: "2026-07-01T00:05:00Z"
    });
    expect(outbound.data.channel).toBe("sms");
    expect(outbound.data.to).toBeNull();
  });
});

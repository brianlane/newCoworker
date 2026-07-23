import { describe, expect, it } from "vitest";

import {
  adminAlertSummary,
  formatAdminLabel,
  formatAlertStatusLabel,
  getLogBadgeVariant,
  getMonthLabel,
  getVpsInventoryBadgeVariant,
  summarizeAlertCounts
} from "@/lib/admin/dashboard";

describe("admin dashboard month labels", () => {
  it("pins the date to the first day before subtracting months", () => {
    const march31 = new Date("2026-03-31T12:00:00Z");

    expect(getMonthLabel(1, march31)).toBe("Feb");
    expect(getMonthLabel(2, march31)).toBe("Jan");
  });

  it("defaults to the current date", () => {
    expect(typeof getMonthLabel(0)).toBe("string");
  });

  it("keeps errors loud but calms owner-alert rows", () => {
    // urgent_alert = "the tenant's owner was paged" — awareness, not an
    // incident, so it gets the outlined style instead of solid orange.
    expect(getLogBadgeVariant("urgent_alert")).toBe("high_load");
    expect(getLogBadgeVariant("error")).toBe("error");
    expect(getLogBadgeVariant("success")).toBe("success");
    expect(getLogBadgeVariant("queued")).toBe("pending");
  });

  it("labels urgent_alert rows as owner alerted", () => {
    expect(formatAlertStatusLabel("urgent_alert")).toBe("owner alerted");
    expect(formatAlertStatusLabel("error")).toBe("error");
    expect(formatAlertStatusLabel("data_flow")).toBe("data flow");
  });

  it("replaces every underscore when formatting admin labels", () => {
    expect(formatAdminLabel("data_flow_check")).toBe("data flow check");
    expect(formatAdminLabel("urgent_alert")).toBe("urgent alert");
  });

  it("maps vps_inventory states to pool-telemetry badge variants", () => {
    expect(getVpsInventoryBadgeVariant("available")).toBe("success");
    expect(getVpsInventoryBadgeVariant("assigned")).toBe("pending");
    expect(getVpsInventoryBadgeVariant("retired")).toBe("neutral");
    // Defensive: an unknown state renders neutrally rather than crashing.
    expect(getVpsInventoryBadgeVariant("weird")).toBe("neutral");
  });
});

describe("adminAlertSummary", () => {
  const log = (
    task_type: string,
    status: string,
    log_payload: Record<string, unknown> | null
  ) => ({ task_type, status, log_payload });

  it("summarizes voice notify_team rows with the caller and message", () => {
    expect(
      adminAlertSummary(
        log("call", "urgent_alert", {
          source: "voice_tool_notify_team",
          message: "Wants a quote for a 20ft fence",
          callerName: "John Doe",
          callerPhone: "+16025550100"
        })
      )
    ).toBe("Caller follow-up: John Doe (+16025550100) — Wants a quote for a 20ft fence");
  });

  it("falls back to 'a caller' when voice notify_team has no person", () => {
    expect(
      adminAlertSummary(log("call", "urgent_alert", { source: "voice_tool_notify_team" }))
    ).toBe("Caller follow-up: a caller");
  });

  it("summarizes sms notify_team rows with the texter and message", () => {
    expect(
      adminAlertSummary(
        log("sms", "urgent_alert", {
          source: "sms_tool_notify_team",
          message: "Needs pricing today",
          customerName: "Tim Tsai",
          customerPhone: "+14805550111"
        })
      )
    ).toBe("Texter follow-up: Tim Tsai (+14805550111) — Needs pricing today");
  });

  it("falls back to 'a texter' when sms notify_team has no person", () => {
    expect(
      adminAlertSummary(log("sms", "urgent_alert", { source: "sms_tool_notify_team" }))
    ).toBe("Texter follow-up: a texter");
  });

  it("summarizes urgent voice captures with the reason", () => {
    expect(
      adminAlertSummary(
        log("call", "urgent_alert", {
          source: "voice_tool_capture",
          callerName: "Raina",
          reason: "pipe burst, needs callback ASAP"
        })
      )
    ).toBe("Urgent caller: Raina — pipe burst, needs callback ASAP");
  });

  it("falls back to notes, then to no detail, for voice captures", () => {
    expect(
      adminAlertSummary(
        log("call", "urgent_alert", {
          source: "voice_tool_capture",
          callerPhone: "+16025550122",
          notes: "left voicemail earlier"
        })
      )
    ).toBe("Urgent caller: +16025550122 — left voicemail earlier");
    expect(
      adminAlertSummary(log("call", "urgent_alert", { source: "voice_tool_capture" }))
    ).toBe("Urgent caller: unknown caller");
  });

  it("does not dress routine (success) captures up as urgent", () => {
    expect(
      adminAlertSummary(
        log("call", "success", {
          source: "voice_tool_capture",
          callerName: "Jane",
          reason: "wants a quote"
        })
      )
    ).toBe("Caller captured: Jane — wants a quote");
  });

  it("summarizes provisioning rows with phase and message", () => {
    expect(
      adminAlertSummary(
        log("provisioning", "error", {
          phase: "deploy",
          percent: 60,
          message: "docker compose failed"
        })
      )
    ).toBe("Provisioning failed at deploy: docker compose failed");
    expect(adminAlertSummary(log("provisioning", "thinking", {}))).toBe(
      "Provisioning update"
    );
    expect(
      adminAlertSummary(
        log("provisioning", "success", { phase: "finalize", message: "Deploy complete" })
      )
    ).toBe("Provisioning completed at finalize: Deploy complete");
  });

  it("uses the first useful payload string for generic rows", () => {
    expect(adminAlertSummary(log("sms", "error", { summary: "Telnyx 40310" }))).toBe(
      "Telnyx 40310"
    );
    expect(adminAlertSummary(log("sms", "error", { message: "send failed" }))).toBe(
      "send failed"
    );
    expect(adminAlertSummary(log("data_flow", "error", { reason: "quota hit" }))).toBe(
      "quota hit"
    );
    expect(
      adminAlertSummary(log("sms", "urgent_alert", { inbound_preview: "call me back" }))
    ).toBe("call me back");
    expect(adminAlertSummary(log("call", "urgent_alert", { notes: "asked for Amy" }))).toBe(
      "asked for Amy"
    );
    expect(adminAlertSummary(log("email", "error", { error: "SMTP 550" }))).toBe("SMTP 550");
  });

  it("attributes generic detail to the person when present", () => {
    expect(
      adminAlertSummary(
        log("sms", "urgent_alert", {
          contact_label: "Tim Tsai",
          inbound_preview: "sounds good, what time?"
        })
      )
    ).toBe("Tim Tsai — sounds good, what time?");
  });

  it("shows the person alone when the row has no detail text", () => {
    expect(
      adminAlertSummary(log("webchat", "urgent_alert", { visitorName: "Jane" }))
    ).toBe("webchat: Jane");
    expect(
      adminAlertSummary(log("sms", "urgent_alert", { contact_e164: "+16025550133" }))
    ).toBe("sms: +16025550133");
  });

  it("falls back to task type + status for empty payloads", () => {
    expect(adminAlertSummary(log("sms", "urgent_alert", null))).toBe("sms owner alerted");
    expect(adminAlertSummary(log("data_flow", "error", {}))).toBe("data flow error");
    // Non-string / blank payload values are ignored, not rendered.
    expect(
      adminAlertSummary(log("sms", "error", { message: 42, reason: "   " }))
    ).toBe("sms error");
  });

  it("truncates runaway payload text", () => {
    const result = adminAlertSummary(
      log("sms", "urgent_alert", { message: "x".repeat(400) })
    );
    expect(result.length).toBe(160);
    expect(result.endsWith("…")).toBe(true);
  });
});

describe("summarizeAlertCounts", () => {
  const now = new Date("2026-07-22T12:00:00Z");

  it("counts errors and trailing-24h rows independently", () => {
    const counts = summarizeAlertCounts(
      [
        { status: "error", created_at: "2026-07-22T11:00:00Z" },
        { status: "urgent_alert", created_at: "2026-07-22T01:00:00Z" },
        { status: "urgent_alert", created_at: "2026-07-15T00:00:00Z" },
        { status: "error", created_at: "2026-07-10T00:00:00Z" }
      ],
      now
    );
    expect(counts).toEqual({ errors: 2, last24h: 2 });
  });

  it("ignores unparseable timestamps for the 24h count", () => {
    const counts = summarizeAlertCounts(
      [{ status: "urgent_alert", created_at: "not-a-date" }],
      now
    );
    expect(counts).toEqual({ errors: 0, last24h: 0 });
  });

  it("defaults to the current time", () => {
    const counts = summarizeAlertCounts([
      { status: "urgent_alert", created_at: new Date().toISOString() }
    ]);
    expect(counts.last24h).toBe(1);
  });
});

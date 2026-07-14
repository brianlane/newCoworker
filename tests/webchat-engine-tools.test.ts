import { describe, expect, it, vi } from "vitest";
import {
  executeWebchatEngineTool,
  webchatBookFailureGuidance,
  WEBCHAT_ENGINE_TOOL_GATES,
  WEBCHAT_TOOL_DECLARATIONS,
  WEBCHAT_TOOL_DISABLED_MESSAGE,
  type WebchatToolExecutorDeps
} from "@/lib/webchat/engine-tools";

const BIZ = "11111111-1111-4111-8111-111111111111";

function deps(overrides: Partial<WebchatToolExecutorDeps> = {}): WebchatToolExecutorDeps {
  return {
    isToolEnabled: vi.fn(async () => true),
    knowledgeLookup: vi.fn(async () => ({ ok: true, data: { answer: "we open at 9" } })),
    captureLead: vi.fn(async () => ({ ok: true as const, data: { logId: "log-1" } })),
    findSlots: vi.fn(async () => ({ ok: true, data: { slots: [] } })),
    bookAppointment: vi.fn(async () => ({ ok: true, data: { eventId: "evt-1" } })),
    shareDocument: vi.fn(async () => ({ ok: true, data: { url: "https://x/d" } })),
    ...overrides
  };
}

describe("declaration ↔ gate lockstep", () => {
  it("declares exactly the gated tool names (no drift in either direction)", () => {
    const declared = WEBCHAT_TOOL_DECLARATIONS.map((d) => d.name).sort();
    const gated = Object.keys(WEBCHAT_ENGINE_TOOL_GATES).sort();
    expect(declared).toEqual(gated);
    // The complete anonymous-surface allowlist: info + lead gen ONLY.
    expect(declared).toEqual([
      "webchat_business_knowledge_lookup",
      "webchat_calendar_book_appointment",
      "webchat_calendar_find_slots",
      "webchat_capture_lead",
      "webchat_document_share"
    ]);
  });
});

describe("executeWebchatEngineTool", () => {
  it("fails closed on unknown tool names without touching the gate", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(BIZ, "send_sms", {}, d);
    expect(res).toEqual({ ok: false, detail: "unknown_tool" });
    expect(d.isToolEnabled).not.toHaveBeenCalled();
  });

  it("returns the disabled message when the owner toggled the tool off", async () => {
    const d = deps({ isToolEnabled: vi.fn(async () => false) });
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_business_knowledge_lookup",
      { question: "hours?" },
      d
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toBe("tool_disabled");
    expect(res.message).toBe(WEBCHAT_TOOL_DISABLED_MESSAGE);
    expect(d.isToolEnabled).toHaveBeenCalledWith(BIZ, "webchat", "business_knowledge_lookup");
  });

  it("dispatches knowledge lookup with the clients audience", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_business_knowledge_lookup",
      { question: "what are your hours?" },
      d
    );
    expect(res.ok).toBe(true);
    expect(d.knowledgeLookup).toHaveBeenCalledWith(BIZ, "what are your hours?", {
      audience: "clients"
    });
  });

  it("rejects invalid knowledge args", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(BIZ, "webchat_business_knowledge_lookup", {}, d);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^invalid_args:/);
    expect(d.knowledgeLookup).not.toHaveBeenCalled();
  });

  it("dispatches lead capture with the parsed args", async () => {
    const d = deps();
    const args = { name: "Ann", phone: "+16025551234", sessionRef: "ref-1" };
    const res = await executeWebchatEngineTool(BIZ, "webchat_capture_lead", args, d);
    expect(res.ok).toBe(true);
    expect(d.captureLead).toHaveBeenCalledWith(BIZ, args);
  });

  it("rejects a malformed lead email", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_capture_lead",
      { email: "not-an-email" },
      d
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^invalid_args:/);
  });

  it("applies the 30-minute default duration on find_slots", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(BIZ, "webchat_calendar_find_slots", {}, d);
    expect(res.ok).toBe(true);
    expect(d.findSlots).toHaveBeenCalledWith(BIZ, expect.objectContaining({ durationMinutes: 30 }));
  });

  it("rejects an out-of-range find_slots duration", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_calendar_find_slots",
      { durationMinutes: 2 },
      d
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^invalid_args:/);
  });

  it("books with offset datetimes and a null caller context", async () => {
    const d = deps();
    const args = {
      startIso: "2026-07-15T10:00:00-07:00",
      endIso: "2026-07-15T10:30:00-07:00",
      summary: "Consult",
      attendeeName: "Ann"
    };
    const res = await executeWebchatEngineTool(BIZ, "webchat_calendar_book_appointment", args, d);
    expect(res.ok).toBe(true);
    expect(d.bookAppointment).toHaveBeenCalledWith(BIZ, expect.objectContaining(args), null);
  });

  it("rejects a bare no-offset datetime on booking", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_calendar_book_appointment",
      {
        startIso: "2026-07-15 10:00",
        endIso: "2026-07-15T10:30:00-07:00",
        summary: "Consult",
        attendeeName: "Ann"
      },
      d
    );
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^invalid_args:/);
  });

  it.each(["calendar_book_failed", "calendar_not_connected"] as const)(
    "attaches capture_lead escalation guidance on %s",
    async (detail) => {
      const d = deps({ bookAppointment: vi.fn(async () => ({ ok: false, detail })) });
      const res = await executeWebchatEngineTool(
        BIZ,
        "webchat_calendar_book_appointment",
        {
          startIso: "2026-07-15T10:00:00-07:00",
          endIso: "2026-07-15T10:30:00-07:00",
          summary: "Consult",
          attendeeName: "Ann"
        },
        d
      );
      expect(res.ok).toBe(false);
      expect(res.message).toBe(webchatBookFailureGuidance(detail));
      expect(res.message).toContain("capture_lead");
    }
  );

  it("passes through booking failures that need no steering", async () => {
    const d = deps({
      bookAppointment: vi.fn(async () => ({ ok: false, detail: "invalid_window" }))
    });
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_calendar_book_appointment",
      {
        startIso: "2026-07-15T10:00:00-07:00",
        endIso: "2026-07-15T10:30:00-07:00",
        summary: "Consult",
        attendeeName: "Ann"
      },
      d
    );
    expect(res).toEqual({ ok: false, detail: "invalid_window" });
  });

  it("shares documents inline-only on the webchat surface", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(
      BIZ,
      "webchat_document_share",
      { document: "Price sheet" },
      d
    );
    expect(res.ok).toBe(true);
    // No phone/email ever cross into the handler from this surface.
    expect(d.shareDocument).toHaveBeenCalledWith(BIZ, { documentRef: "Price sheet" }, "webchat");
  });

  it("rejects an empty document ref", async () => {
    const d = deps();
    const res = await executeWebchatEngineTool(BIZ, "webchat_document_share", { document: "" }, d);
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/^invalid_args:/);
  });
});

describe("webchatBookFailureGuidance", () => {
  it("explains the missing calendar without blaming a technical error", () => {
    const msg = webchatBookFailureGuidance("calendar_not_connected");
    expect(msg).toContain("No calendar is connected");
  });

  it("steers generic failures to re-check availability", () => {
    const msg = webchatBookFailureGuidance("calendar_book_failed");
    expect(msg).toContain("never blame a technical error");
  });
});

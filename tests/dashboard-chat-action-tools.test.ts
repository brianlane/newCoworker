/**
 * Inline dashboard-chat action tools
 * (src/lib/dashboard-chat/action-tools.ts): declaration gating, send_sms
 * (normalize → opt-out fail-closed → metered send → outbound-log insert),
 * the calendar lifecycle pass-throughs with owner-surface guidance, and the
 * never-throws contract.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  ACTION_TOOL_NAMES,
  actionToolDeclarations,
  executeActionTool,
  isActionToolName,
  type ActionToolDeps,
  type ActionToolGates
} from "@/lib/dashboard-chat/action-tools";

const BIZ = "11111111-1111-4111-8111-111111111111";

const ALL_ON: ActionToolGates = {
  send_sms: true,
  send_whatsapp: true,
  calendar_find_slots: true,
  calendar_book_appointment: true,
  calendar_reschedule_appointment: true,
  calendar_cancel_appointment: true
};

function insertResult(result: { error: { message: string } | null }) {
  return {
    from: vi.fn(() => ({ insert: vi.fn(async () => result) }))
  };
}

/** Deps where every core succeeds; override per test. */
function happyDeps(overrides: Partial<ActionToolDeps> = {}): ActionToolDeps {
  return {
    getMessagingConfig: vi.fn(async () => ({
      apiKey: "k",
      messagingProfileId: "p",
      fromE164: "+15550001111"
    })),
    sendSms: vi.fn(async () => ({ id: "msg-1", channel: "sms" as const })),
    checkOptOut: vi.fn(async () => ({ ok: true as const, optedOut: false })),
    findSlots: vi.fn(async () => ({ ok: true, data: { slots: [] } })),
    book: vi.fn(async () => ({ ok: true, data: { eventId: "e1" } })),
    reschedule: vi.fn(async () => ({ ok: true, data: { eventId: "e1" } })),
    cancel: vi.fn(async () => ({ ok: true, data: { canceled: true } })),
    createDb: vi.fn(async () => insertResult({ error: null })) as never,
    ...overrides
  };
}

describe("send_whatsapp", () => {
  it("delivers via the central helper and reports the delivery path", async () => {
    const sendWhatsApp = vi.fn(async () => ({
      ok: true as const,
      via: "text" as const,
      messageId: "wamid-1"
    }));
    const result = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567", body: "Hello!" } },
      { sendWhatsApp }
    )) as { ok: boolean; via?: string; toE164?: string };
    expect(result.ok).toBe(true);
    expect(result.via).toBe("text");
    expect(sendWhatsApp).toHaveBeenCalledWith({
      businessId: BIZ,
      to: "+15551234567",
      text: "Hello!",
      audience: "contact"
    });

    const template = vi.fn(async () => ({
      ok: true as const,
      via: "template" as const,
      messageId: "wamid-2"
    }));
    const tmplResult = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567", body: "Hi" } },
      { sendWhatsApp: template }
    )) as { note?: string };
    expect(tmplResult.note).toContain("approved template");
  });

  it("rejects invalid args and destinations", async () => {
    const sendWhatsApp = vi.fn();
    const bad = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567" } },
      { sendWhatsApp }
    )) as { ok: boolean; message?: string };
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("invalid_args");

    const garbage = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "not-a-phone", body: "x" } },
      { sendWhatsApp }
    )) as { ok: boolean; message?: string };
    expect(garbage.ok).toBe(false);
    expect(garbage.message).toBe("invalid_destination");
    expect(sendWhatsApp).not.toHaveBeenCalled();
  });

  it("maps policy skips and failures to owner-facing guidance", async () => {
    const notConnected = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567", body: "x" } },
      { sendWhatsApp: vi.fn(async () => ({ ok: false as const, reason: "not_connected" as const })) }
    )) as { ok: boolean; message?: string };
    expect(notConnected.ok).toBe(false);
    expect(notConnected.message).toContain("whatsapp_not_connected");

    const windowClosed = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567", body: "x" } },
      {
        sendWhatsApp: vi.fn(async () => ({
          ok: false as const,
          reason: "template_not_approved" as const
        }))
      }
    )) as { message?: string };
    expect(windowClosed.message).toContain("whatsapp_window_closed");

    const failed = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567", body: "x" } },
      { sendWhatsApp: vi.fn(async () => ({ ok: false as const, reason: "send_failed" as const })) }
    )) as { message?: string };
    expect(failed.message).toContain("whatsapp_send_failed");
  });
});

describe("declarations & naming", () => {
  it("filters declarations to the gates that are ON, in stable order", () => {
    const all = actionToolDeclarations(ALL_ON);
    expect(all.map((d) => d.name)).toEqual([...ACTION_TOOL_NAMES]);

    const some = actionToolDeclarations({
      ...ALL_ON,
      send_sms: false,
      send_whatsapp: false,
      calendar_cancel_appointment: false
    });
    expect(some.map((d) => d.name)).toEqual([
      "calendar_find_slots",
      "calendar_book_appointment",
      "calendar_reschedule_appointment"
    ]);
  });

  it("isActionToolName distinguishes action tools from everything else", () => {
    expect(isActionToolName("send_sms")).toBe(true);
    expect(isActionToolName("calendar_book_appointment")).toBe(true);
    expect(isActionToolName("create_aiflow")).toBe(false);
    expect(isActionToolName("")).toBe(false);
  });
});

describe("send_sms", () => {
  const ARGS = { toE164: "+15145188192", body: "This is a test message." };

  it("normalizes, checks the STOP list, sends metered, and logs the outbound row", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "send_sms", args: { toE164: "(514) 518-8192", body: ARGS.body } },
      deps
    );
    expect(res).toMatchObject({
      ok: true,
      messageId: "msg-1",
      toE164: "+15145188192",
      sentBody: ARGS.body
    });
    expect(deps.checkOptOut).toHaveBeenCalledWith(BIZ, "+15145188192");
    expect(deps.sendSms).toHaveBeenCalledWith(
      expect.objectContaining({ fromE164: "+15550001111" }),
      "+15145188192",
      ARGS.body,
      { meterBusinessId: BIZ }
    );
    expect(deps.createDb).toHaveBeenCalled();
  });

  it("writes the sms_outbound_log row with the dashboard_chat source", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const deps = happyDeps({
      createDb: vi.fn(async () => ({ from: vi.fn(() => ({ insert })) })) as never
    });
    await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        business_id: BIZ,
        to_e164: "+15145188192",
        from_e164: "+15550001111",
        body: ARGS.body,
        source: "dashboard_chat",
        telnyx_message_id: "msg-1",
        channel: "sms"
      })
    );
  });

  it("still succeeds when the outbound-log insert fails (returned error AND thrown)", async () => {
    for (const createDb of [
      vi.fn(async () => insertResult({ error: { message: "insert denied" } })),
      vi.fn(async () => {
        throw new Error("db down");
      }),
      vi.fn(async () => {
        throw "db string blast";
      })
    ]) {
      const deps = happyDeps({ createDb: createDb as never });
      const res = await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
      expect(res).toMatchObject({ ok: true, messageId: "msg-1" });
    }
  });

  it("logs a null from_e164 when the messaging config has none", async () => {
    const insert = vi.fn(async () => ({ error: null }));
    const deps = happyDeps({
      getMessagingConfig: vi.fn(async () => ({ apiKey: "k", messagingProfileId: "p" })),
      createDb: vi.fn(async () => ({ from: vi.fn(() => ({ insert })) })) as never
    });
    const res = await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
    expect(res).toMatchObject({ ok: true });
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ from_e164: null }));
  });

  it("rejects invalid args without touching any core", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "send_sms", args: { toE164: "+15145188192" } },
      deps
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  it("refuses an unnormalizable destination", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "send_sms", args: { toE164: "not-a-number-x", body: "hi" } },
      deps
    );
    expect(res).toEqual({ ok: false, message: "invalid_destination" });
    expect(deps.checkOptOut).not.toHaveBeenCalled();
  });

  it("fails CLOSED when the opt-out check errors", async () => {
    const deps = happyDeps({
      checkOptOut: vi.fn(async () => ({ ok: false as const, error: "rpc down" }))
    });
    const res = await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
    expect(res).toEqual({ ok: false, message: "opt_out_check_failed" });
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  it("refuses an opted-out recipient", async () => {
    const deps = happyDeps({
      checkOptOut: vi.fn(async () => ({ ok: true as const, optedOut: true }))
    });
    const res = await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
    expect(res).toMatchObject({
      ok: false,
      message: expect.stringContaining("recipient_opted_out")
    });
    expect(deps.sendSms).not.toHaveBeenCalled();
  });

  it("classifies quota refusals and generic send failures honestly", async () => {
    const quota = happyDeps({
      sendSms: vi.fn(async () => {
        throw new Error("Monthly SMS limit reached");
      })
    });
    expect(await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, quota)).toMatchObject({
      ok: false,
      message: expect.stringContaining("sms_quota_blocked")
    });

    const generic = happyDeps({
      sendSms: vi.fn(async () => {
        throw "telnyx 500";
      })
    });
    expect(await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, generic)).toMatchObject({
      ok: false,
      message: expect.stringContaining("sms_send_failed")
    });
  });
});

describe("calendar_find_slots", () => {
  it("passes parsed args (defaulted duration) to the core and returns its result", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_find_slots", args: { purpose: "intro call" } },
      deps
    );
    expect(res).toEqual({ ok: true, data: { slots: [] } });
    expect(deps.findSlots).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ purpose: "intro call", durationMinutes: 30 })
    );
  });

  it("rejects invalid args", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_find_slots", args: { durationMinutes: 2 } },
      deps
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
    expect(deps.findSlots).not.toHaveBeenCalled();
  });
});

describe("calendar_book_appointment", () => {
  const BOOK_ARGS = {
    startIso: "2026-07-20T10:00:00-04:00",
    endIso: "2026-07-20T10:30:00-04:00",
    summary: "Strategy call",
    attendeeName: "Uday Nandam"
  };

  it("returns the core's success unchanged", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(BIZ, { name: "calendar_book_appointment", args: BOOK_ARGS }, deps);
    expect(res).toEqual({ ok: true, data: { eventId: "e1" } });
    expect(deps.book).toHaveBeenCalledWith(BIZ, expect.objectContaining(BOOK_ARGS), null);
  });

  it("attaches owner-surface guidance for book failures and missing calendars", async () => {
    for (const [detail, needle] of [
      ["calendar_book_failed", "no longer available"],
      ["calendar_not_connected", "/dashboard/integrations"]
    ] as const) {
      const deps = happyDeps({ book: vi.fn(async () => ({ ok: false, detail })) });
      const res = await executeActionTool(
        BIZ,
        { name: "calendar_book_appointment", args: BOOK_ARGS },
        deps
      );
      expect(res).toMatchObject({ ok: false, detail, message: expect.stringContaining(needle) });
    }
  });

  it("passes other failure details through without guidance", async () => {
    const deps = happyDeps({
      book: vi.fn(async () => ({ ok: false, detail: "invalid_window" }))
    });
    const res = await executeActionTool(BIZ, { name: "calendar_book_appointment", args: BOOK_ARGS }, deps);
    expect(res).toEqual({ ok: false, detail: "invalid_window" });
  });

  it("rejects invalid args (no-offset datetimes)", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      {
        name: "calendar_book_appointment",
        args: { ...BOOK_ARGS, startIso: "2026-07-20 10:00" }
      },
      deps
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
  });
});

describe("calendar_reschedule_appointment", () => {
  const RES_ARGS = {
    newStartIso: "2026-07-21T15:00:00-04:00",
    newEndIso: "2026-07-21T15:30:00-04:00",
    attendeePhone: "+15145188192"
  };

  it("returns a plain success unchanged", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_reschedule_appointment", args: RES_ARGS },
      deps
    );
    expect(res).toEqual({ ok: true, data: { eventId: "e1" } });
  });

  it("steers the model on Calendly's reschedule_link_created", async () => {
    const deps = happyDeps({
      reschedule: vi.fn(async () => ({
        ok: true,
        detail: "reschedule_link_created",
        data: { rescheduleLink: "https://calendly.com/r/abc" }
      }))
    });
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_reschedule_appointment", args: RES_ARGS },
      deps
    );
    expect(res).toMatchObject({
      ok: true,
      detail: "reschedule_link_created",
      message: expect.stringContaining("NOT been moved")
    });
  });

  it("attaches lifecycle guidance per failure detail and passes unknown details through", async () => {
    for (const [detail, needle] of [
      ["booking_not_found", "Never book"],
      ["calendar_not_connected", "/dashboard/integrations"],
      ["calendar_reschedule_failed", "second appointment"]
    ] as const) {
      const deps = happyDeps({ reschedule: vi.fn(async () => ({ ok: false, detail })) });
      const res = await executeActionTool(
        BIZ,
        { name: "calendar_reschedule_appointment", args: RES_ARGS },
        deps
      );
      expect(res).toMatchObject({ ok: false, detail, message: expect.stringContaining(needle) });
    }

    const deps = happyDeps({
      reschedule: vi.fn(async () => ({ ok: false, detail: "invalid_window" }))
    });
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_reschedule_appointment", args: RES_ARGS },
      deps
    );
    expect(res).toEqual({ ok: false, detail: "invalid_window" });
  });

  it("rejects invalid args", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_reschedule_appointment", args: { newStartIso: "soon" } },
      deps
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
  });
});

describe("calendar_cancel_appointment", () => {
  it("returns the core's success unchanged", async () => {
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_cancel_appointment", args: { attendeePhone: "+15145188192" } },
      deps
    );
    expect(res).toEqual({ ok: true, data: { canceled: true } });
  });

  it("attaches cancel-verb guidance on lifecycle failures", async () => {
    const deps = happyDeps({
      cancel: vi.fn(async () => ({ ok: false, detail: "calendar_cancel_failed" }))
    });
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_cancel_appointment", args: {} },
      deps
    );
    expect(res).toMatchObject({
      ok: false,
      detail: "calendar_cancel_failed",
      message: expect.stringContaining("cancel did not go through")
    });
  });

  it("passes a no-guidance failure through and rejects invalid args", async () => {
    const deps = happyDeps({
      cancel: vi.fn(async () => ({ ok: false, detail: "vagaro_auth_failed" }))
    });
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_cancel_appointment", args: {} },
      deps
    );
    expect(res).toEqual({ ok: false, detail: "vagaro_auth_failed" });

    const res2 = await executeActionTool(
      BIZ,
      { name: "calendar_cancel_appointment", args: { attendeeEmail: "not-an-email" } },
      happyDeps()
    );
    expect(res2).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
  });
});

describe("never-throws contract", () => {
  it("degrades a thrown core (Error and non-Error) to an honest failure", async () => {
    for (const thrown of [new Error("provider down"), "string blast"]) {
      const deps = happyDeps({
        findSlots: vi.fn(async () => {
          throw thrown;
        })
      });
      const res = await executeActionTool(
        BIZ,
        { name: "calendar_find_slots", args: {} },
        deps
      );
      expect(res).toMatchObject({
        ok: false,
        message: expect.stringContaining("never pretend")
      });
    }
  });
});

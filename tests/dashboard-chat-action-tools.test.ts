/**
 * Inline dashboard-chat action tools
 * (src/lib/dashboard-chat/action-tools.ts): declaration gating, send_sms
 * (normalize → opt-out fail-closed → metered send → outbound-log insert),
 * the calendar lifecycle pass-throughs with owner-surface guidance, and the
 * never-throws contract.
 */
import { describe, expect, it, vi } from "vitest";

// edit_aiflow's staging store and its in-flight probe are internals of the
// shared core, not action-tool deps: mock the modules rather than widening
// ActionToolDeps with plumbing this dispatcher does not otherwise touch.
const stagedTokens = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>() }));
vi.mock("@/lib/ai-flows/pending-edits", () => ({
  PENDING_EDIT_TTL_MINUTES: 15,
  stagePendingEdit: vi.fn(async (input: Record<string, unknown>) => {
    const row = {
      id: "pending-1",
      business_id: input.businessId,
      flow_id: input.flowId,
      token: "tok-test",
      definition: input.definition,
      new_name: input.newName ?? null,
      summary: input.summary,
      ambiguities: input.ambiguities,
      risk: input.risk,
      base_updated_at: input.baseUpdatedAt,
      surface: input.surface ?? null,
      actor: input.actor ?? null,
      created_at: "2026-08-18T00:00:00Z",
      expires_at: "2026-08-18T00:15:00Z",
      consumed_at: null
    };
    stagedTokens.rows.set("tok-test", row);
    return row;
  }),
  consumePendingEdit: vi.fn(async (_biz: string, token: string) => {
    const row = stagedTokens.rows.get(token);
    return row ? { ok: true as const, row } : { ok: false as const, message: "not staged any more" };
  }),
  peekPendingEdit: vi.fn(async (_biz: string, token: string) => stagedTokens.rows.get(token) ?? null)
}));
vi.mock("@/lib/ai-flows/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai-flows/db")>();
  return { ...actual, highestActiveRunStep: vi.fn(async () => null) };
});

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
  calendar_cancel_appointment: true,
  calendar_join_waitlist: true,
  list_aiflows: true,
  run_aiflow: true,
  edit_aiflow: true,
  undo_aiflow_edit: true,
  generate_image: true,
  update_notification_preferences: true,
  flag_contact_spam: true,
  set_contact_reply_mode: true,
  manage_employee: true
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
    recordContactInteraction: vi.fn(async () => ({}) as never),
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

    const inactive = (await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+15551234567", body: "x" } },
      {
        sendWhatsApp: vi.fn(async () => ({
          ok: false as const,
          reason: "connection_inactive" as const
        }))
      }
    )) as { ok: boolean; message?: string };
    expect(inactive.ok).toBe(false);
    expect(inactive.message).toContain("whatsapp_connection_inactive");

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

  it("upserts the recipient as a contact after a successful delivery (whatsapp channel)", async () => {
    const deps = happyDeps({
      sendWhatsApp: vi.fn(async () => ({
        ok: true as const,
        via: "text" as const,
        messageId: "wamid-3"
      }))
    });
    await executeActionTool(
      BIZ,
      {
        name: "send_whatsapp",
        args: { toE164: "+13127310559", body: "Hello!", contactName: "Ayanna" }
      },
      deps
    );
    expect(deps.recordContactInteraction).toHaveBeenCalledWith(
      BIZ,
      "+13127310559",
      "whatsapp",
      { displayName: "Ayanna" },
      expect.anything()
    );

    // A failed delivery never upserts.
    const failedDeps = happyDeps({
      sendWhatsApp: vi.fn(async () => ({ ok: false as const, reason: "send_failed" as const }))
    });
    await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+13127310559", body: "x" } },
      failedDeps
    );
    expect(failedDeps.recordContactInteraction).not.toHaveBeenCalled();

    // And a failed upsert never fails the delivered message.
    const upsertDown = happyDeps({
      sendWhatsApp: vi.fn(async () => ({
        ok: true as const,
        via: "text" as const,
        messageId: "wamid-4"
      })),
      recordContactInteraction: vi.fn(async () => {
        throw new Error("rollup down");
      }) as never
    });
    const res = await executeActionTool(
      BIZ,
      { name: "send_whatsapp", args: { toE164: "+13127310559", body: "x" } },
      upsertDown
    );
    expect(res).toMatchObject({ ok: true, messageId: "wamid-4" });
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
      calendar_cancel_appointment: false,
      list_aiflows: false,
      run_aiflow: false,
      edit_aiflow: false,
      undo_aiflow_edit: false,
      generate_image: false,
      update_notification_preferences: false,
      flag_contact_spam: false,
      set_contact_reply_mode: false,
      manage_employee: false
    });
    expect(some.map((d) => d.name)).toEqual([
      "calendar_find_slots",
      "calendar_book_appointment",
      "calendar_reschedule_appointment",
      "calendar_join_waitlist"
    ]);
  });

  it("isActionToolName distinguishes action tools from everything else", () => {
    expect(isActionToolName("send_sms")).toBe(true);
    expect(isActionToolName("calendar_book_appointment")).toBe(true);
    expect(isActionToolName("update_notification_preferences")).toBe(true);
    expect(isActionToolName("create_aiflow")).toBe(false);
    expect(isActionToolName("")).toBe(false);
  });
});

describe("update_notification_preferences", () => {
  it("is declared with owner-consent guidance and gated off cleanly", () => {
    const decls = actionToolDeclarations(ALL_ON);
    const decl = decls.find((d) => d.name === "update_notification_preferences");
    expect(decl?.description).toMatch(/explicitly asks/i);
    expect(decl?.description).toMatch(/notification|alert/i);
    // Recipients are NOT parameters, booleans only.
    const props = Object.keys(
      (decl?.parameters as { properties: Record<string, unknown> }).properties
    );
    expect(props).toContain("customer_reply_alerts");
    expect(props).not.toContain("phone_number");
    expect(props).not.toContain("alert_email");

    const gatedOff = actionToolDeclarations({ ...ALL_ON, update_notification_preferences: false });
    expect(gatedOff.map((d) => d.name)).not.toContain("update_notification_preferences");
  });

  it("applies toggles through the shared core (full control on the dashboard surface)", async () => {
    const applyNotificationToggles = vi.fn(async () => ({
      ok: true as const,
      data: {
        updated: { customer_reply_alerts: true },
        settings: { customer_reply_alerts: true }
      }
    }));
    const res = (await executeActionTool(
      BIZ,
      {
        name: "update_notification_preferences",
        args: { customer_reply_alerts: true, email_digest: false }
      },
      { applyNotificationToggles: applyNotificationToggles as never }
    )) as { ok: boolean; note?: string };
    expect(applyNotificationToggles).toHaveBeenCalledWith(BIZ, {
      customer_reply_alerts: true,
      email_digest: false
    });
    expect(res.ok).toBe(true);
    expect(res.note).toMatch(/tell the owner/i);
  });

  it("passes core refusals through and rejects invalid args without touching the core", async () => {
    const applyNotificationToggles = vi.fn(async () => ({
      ok: false as const,
      detail: "unknown_toggle:phone_number",
      message: "Only these toggles exist: …"
    }));
    const refused = (await executeActionTool(
      BIZ,
      { name: "update_notification_preferences", args: { phone_number: "+1555" } },
      { applyNotificationToggles: applyNotificationToggles as never }
    )) as { ok: boolean; detail?: string };
    expect(refused.ok).toBe(false);
    expect(refused.detail).toBe("unknown_toggle:phone_number");

    const untouched = vi.fn();
    const invalid = (await executeActionTool(
      BIZ,
      { name: "update_notification_preferences", args: { customer_reply_alerts: "yes" } },
      { applyNotificationToggles: untouched as never }
    )) as { ok: boolean; message?: string };
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain("invalid_args");
    expect(untouched).not.toHaveBeenCalled();
  });
});

describe("flag_contact_spam", () => {
  it("is declared with explicit-consent + irreversibility guidance and gated off cleanly", () => {
    const decl = actionToolDeclarations(ALL_ON).find((d) => d.name === "flag_contact_spam");
    expect(decl?.description).toMatch(/ONLY when the owner explicitly/i);
    expect(decl?.description).toMatch(/CANNOT be undone/i);
    const props = Object.keys(
      (decl?.parameters as { properties: Record<string, unknown> }).properties
    );
    expect(props).toEqual(["phone", "reason"]);

    const gatedOff = actionToolDeclarations({ ...ALL_ON, flag_contact_spam: false });
    expect(gatedOff.map((d) => d.name)).not.toContain("flag_contact_spam");
  });

  it("delegates to the shared core and returns its payload verbatim", async () => {
    const flagSpam = vi.fn(async () => ({
      ok: true as const,
      phoneE164: "+12038097763",
      optedOut: true as const,
      canceledRuns: 1,
      runsSweepComplete: true,
      contactTagged: true,
      note: "Tell the owner…"
    }));
    const res = (await executeActionTool(
      BIZ,
      { name: "flag_contact_spam", args: { phone: "+12038097763", reason: "junk form fill" } },
      { flagSpam: flagSpam as never }
    )) as { ok: boolean; canceledRuns?: number };
    expect(flagSpam).toHaveBeenCalledWith(BIZ, {
      phone: "+12038097763",
      reason: "junk form fill"
    });
    expect(res.ok).toBe(true);
    expect(res.canceledRuns).toBe(1);
  });

  it("rejects invalid args without touching the core", async () => {
    const flagSpam = vi.fn();
    const invalid = (await executeActionTool(
      BIZ,
      { name: "flag_contact_spam", args: {} },
      { flagSpam: flagSpam as never }
    )) as { ok: boolean; message?: string };
    expect(invalid.ok).toBe(false);
    expect(invalid.message).toContain("invalid_args");
    expect(flagSpam).not.toHaveBeenCalled();
  });

  it("steers 'stop texting' requests away from the spam block (Chris Gregoris, Jul 24 2026)", () => {
    const decl = actionToolDeclarations(ALL_ON).find((d) => d.name === "flag_contact_spam");
    expect(decl?.description).toMatch(/NEVER use it just because the owner asked to stop texting/i);
    expect(decl?.description).toContain("set_contact_reply_mode");
  });
});

describe("set_contact_reply_mode", () => {
  it("is declared with stop/resume + reversibility guidance and gated off cleanly", () => {
    const decl = actionToolDeclarations(ALL_ON).find((d) => d.name === "set_contact_reply_mode");
    expect(decl?.description).toMatch(/stop texting/i);
    expect(decl?.description).toMatch(/reversible/i);
    // And it points spam declarations at the irreversible tool.
    expect(decl?.description).toContain("flag_contact_spam");
    const props = Object.keys(
      (decl?.parameters as { properties: Record<string, unknown> }).properties
    );
    expect(props).toEqual(["phone", "mode"]);

    const gatedOff = actionToolDeclarations({ ...ALL_ON, set_contact_reply_mode: false });
    expect(gatedOff.map((d) => d.name)).not.toContain("set_contact_reply_mode");
  });

  it("delegates to the shared core and returns its payload verbatim", async () => {
    const setReplyMode = vi.fn(async () => ({
      ok: true as const,
      phoneE164: "+18579289096",
      mode: "suppress" as const,
      canceledRuns: 2,
      runsSweepComplete: true,
      note: "Tell the owner…"
    }));
    const res = (await executeActionTool(
      BIZ,
      { name: "set_contact_reply_mode", args: { phone: "+18579289096", mode: "suppress" } },
      { setReplyMode: setReplyMode as never }
    )) as { ok: boolean; canceledRuns?: number };
    expect(setReplyMode).toHaveBeenCalledWith(BIZ, { phone: "+18579289096", mode: "suppress" });
    expect(res.ok).toBe(true);
    expect(res.canceledRuns).toBe(2);
  });

  it("rejects invalid args (bad mode included) without touching the core", async () => {
    const setReplyMode = vi.fn();
    for (const args of [{}, { phone: "+18579289096" }, { phone: "+18579289096", mode: "off" }]) {
      const invalid = (await executeActionTool(
        BIZ,
        { name: "set_contact_reply_mode", args },
        { setReplyMode: setReplyMode as never }
      )) as { ok: boolean; message?: string };
      expect(invalid.ok).toBe(false);
      expect(invalid.message).toContain("invalid_args");
    }
    expect(setReplyMode).not.toHaveBeenCalled();
  });
});

describe("manage_employee", () => {
  it("is declared with confirm-before-redirecting-leads guidance and gated off cleanly", () => {
    const decl = actionToolDeclarations(ALL_ON).find((d) => d.name === "manage_employee");
    // The two irreversible-feeling moves must be called out: a mistyped
    // number sends a teammate's leads to a stranger, and deactivating or
    // un-rotating someone silently reroutes live leads.
    expect(decl?.description).toMatch(/number back digit by digit/i);
    // The two single-recipient switches must read as distinct, or the model
    // turns off the rotation when the owner only meant "stop naming me".
    const props2 = (decl?.parameters as { properties: Record<string, { description: string }> })
      .properties;
    expect(props2.leadRotation.description).toContain("namedLeads");
    expect(props2.namedLeads.description).toMatch(/independent of leadRotation/i);
    expect(decl?.description).toMatch(/confirm/i);
    expect(decl?.description).toMatch(/never invent a number/i);
    const props = Object.keys(
      (decl?.parameters as { properties: Record<string, unknown> }).properties
    );
    expect(props).toEqual([
      "action",
      "employee",
      "name",
      "phone",
      "email",
      "scheduleText",
      "preferredText",
      "leadRotation",
      "namedLeads",
      "namedGroupOffers",
      "wholeTeamOffers"
    ]);
    expect((decl?.parameters as { required: string[] }).required).toEqual(["action"]);

    const gatedOff = actionToolDeclarations({ ...ALL_ON, manage_employee: false });
    expect(gatedOff.map((d) => d.name)).not.toContain("manage_employee");
  });

  it("delegates to the shared core and returns its payload verbatim", async () => {
    const manageRoster = vi.fn(async () => ({
      ok: true as const,
      action: "update" as const,
      employee: {
        id: "m-1",
        name: "Amy Laidlaw",
        phoneE164: "+16026951142",
        email: null,
        active: true,
        leadRotation: false,
        namedLeads: true,
        namedGroupOffers: true,
        wholeTeamOffers: false
      },
      note: "Tell the owner…"
    }));
    const res = (await executeActionTool(
      BIZ,
      {
        name: "manage_employee",
        args: { action: "update", employee: "Amy Laidlaw", leadRotation: false }
      },
      { manageRoster: manageRoster as never }
    )) as { ok: boolean; employee?: { leadRotation?: boolean } };
    expect(manageRoster).toHaveBeenCalledWith(BIZ, {
      action: "update",
      employee: "Amy Laidlaw",
      leadRotation: false
    });
    expect(res.ok).toBe(true);
    expect(res.employee?.leadRotation).toBe(false);
  });

  it("rejects invalid args without touching the core", async () => {
    const manageRoster = vi.fn();
    for (const args of [{}, { action: "fire" }, { action: "update", leadRotation: "no" }]) {
      const invalid = (await executeActionTool(
        BIZ,
        { name: "manage_employee", args },
        { manageRoster: manageRoster as never }
      )) as { ok: boolean; message?: string };
      expect(invalid.ok).toBe(false);
      expect(invalid.message).toContain("invalid_args");
    }
    expect(manageRoster).not.toHaveBeenCalled();
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

  it("refuses a non-NANP destination up front and recommends WhatsApp", async () => {
    // Long codes cannot originate SMS outside +1 at all (Telnyx 40309), so
    // the tool must say so BEFORE attempting the send, or the model invents
    // wrong advice (KYP Ads +852, Jul 30 2026: "check that your number is
    // enabled to receive standard SMS").
    for (const toE164 of ["+85260100607", "+525512345678", "+447700900123"]) {
      const deps = happyDeps();
      const res = (await executeActionTool(
        BIZ,
        { name: "send_sms", args: { toE164, body: "hi" } },
        deps
      )) as { ok: boolean; message?: string };
      expect(res.ok).toBe(false);
      expect(res.message).toContain("sms_unreachable_destination");
      expect(res.message).toContain("WhatsApp");
      expect(res.message).toContain("send_whatsapp");
      expect(deps.checkOptOut).not.toHaveBeenCalled();
      expect(deps.sendSms).not.toHaveBeenCalled();
    }
  });

  it("does NOT confuse a 10-digit US number in the 852 area code with Hong Kong", async () => {
    // Bare "8526010060" is a NANP number (+1 852-601-0060), not +852: the
    // reachability gate runs on the CANONICAL number, after +1 coercion.
    const deps = happyDeps();
    const res = await executeActionTool(
      BIZ,
      { name: "send_sms", args: { toE164: "8526010060", body: "hi" } },
      deps
    );
    expect(res).toMatchObject({ ok: true, toE164: "+18526010060" });
    expect(deps.sendSms).toHaveBeenCalled();
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
    // No send → no contact upsert.
    expect(quota.recordContactInteraction).not.toHaveBeenCalled();

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

  it("upserts the recipient as a contact after a successful send (outbound-first numbers must exist)", async () => {
    // KYP/Ayanna, Jul 20 2026: a number the owner texted twice had NO contact
    // row, so the assistant told James "I don't have any record of Ayanna"
    // hours after texting her for him.
    const deps = happyDeps();
    await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
    expect(deps.recordContactInteraction).toHaveBeenCalledWith(
      BIZ,
      "+15145188192",
      "sms",
      { displayName: null },
      expect.anything()
    );
  });

  it("passes the optional contactName through to the upsert", async () => {
    const deps = happyDeps();
    await executeActionTool(
      BIZ,
      { name: "send_sms", args: { ...ARGS, contactName: "  Ayanna  " } },
      deps
    );
    expect(deps.recordContactInteraction).toHaveBeenCalledWith(
      BIZ,
      "+15145188192",
      "sms",
      { displayName: "Ayanna" },
      expect.anything()
    );
  });

  it("a failed contact upsert never fails the sent message (returned rejection AND thrown string)", async () => {
    for (const recordContactInteraction of [
      vi.fn(async () => {
        throw new Error("rollup down");
      }),
      vi.fn(async () => {
        throw "rollup string blast";
      })
    ]) {
      const deps = happyDeps({ recordContactInteraction: recordContactInteraction as never });
      const res = await executeActionTool(BIZ, { name: "send_sms", args: ARGS }, deps);
      expect(res).toMatchObject({ ok: true, messageId: "msg-1" });
    }
  });

  it("declares the timezone rule on outbound message bodies (KYP/Ayanna Jul 20 2026)", () => {
    const decls = actionToolDeclarations(ALL_ON);
    const sms = decls.find((d) => d.name === "send_sms");
    const whatsapp = decls.find((d) => d.name === "send_whatsapp");
    expect(sms?.description).toMatch(/timezone/i);
    expect(whatsapp?.description).toMatch(/timezone/i);
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

describe("list_aiflows / run_aiflow", () => {
  const FLOWS = [
    {
      id: "11111111-aaaa-4aaa-8aaa-111111111111",
      name: "Booking confirmation text (Calendly)",
      enabled: true,
      definition: { trigger: { channel: "calendar", on: "event_start" } }
    },
    {
      id: "22222222-bbbb-4bbb-8bbb-222222222222",
      name: "Proposal send + follow-up",
      enabled: true,
      definition: { trigger: { channel: "manual" } }
    },
    {
      id: "33333333-cccc-4ccc-8ccc-333333333333",
      name: "Wrong-link booking flag",
      enabled: false,
      definition: { trigger: { channel: "calendar", on: "event_created" } }
    },
    {
      id: "44444444-dddd-4ddd-8ddd-444444444444",
      name: "Lead follow-up",
      enabled: true,
      definition: {}
    },
    {
      id: "55555555-eeee-4eee-8eee-555555555555",
      name: "Privyr intake",
      enabled: true,
      definition: { trigger: { channel: "sms" } }
    },
    {
      id: "66666666-ffff-4fff-8fff-666666666666",
      name: "Calendar misc",
      enabled: true,
      definition: { trigger: { channel: "calendar" } }
    }
  ] as never[];

  it("lists flows with human trigger summaries and the offer-options note", async () => {
    const deps = happyDeps({ listFlows: vi.fn(async () => FLOWS) as never });
    const res = (await executeActionTool(BIZ, { name: "list_aiflows", args: {} }, deps)) as {
      ok: boolean;
      flows: Array<{ name: string; enabled: boolean; trigger: string }>;
      note: string;
    };
    expect(res.ok).toBe(true);
    expect(res.flows).toHaveLength(6);
    expect(res.flows[0].trigger).toBe("calendar (event_start)");
    expect(res.flows[1].trigger).toBe("manual (run on demand)");
    expect(res.flows[3].trigger).toBe("unknown trigger");
    expect(res.flows[4].trigger).toBe("sms"); // any other channel passes through
    expect(res.flows[5].trigger).toBe("calendar (event)"); // missing `on` falls back
    expect(res.note).toContain("offer it as an option");
  });

  it("runs an enabled flow resolved by id, exact name, or unique substring", async () => {
    for (const ref of [
      "22222222-bbbb-4bbb-8bbb-222222222222",
      "proposal send + follow-up",
      "Proposal"
    ]) {
      const enqueueFlowRun = vi.fn(async (_args: unknown) => ({ id: "run-1" }));
      const deps = happyDeps({
        listFlows: vi.fn(async () => FLOWS) as never,
        enqueueFlowRun: enqueueFlowRun as never
      });
      const res = await executeActionTool(
        BIZ,
        { name: "run_aiflow", args: { flow: ref, input: "Uday +17326190286" } },
        deps
      );
      expect(res).toMatchObject({ ok: true, runId: "run-1", flowName: "Proposal send + follow-up" });
      const call = enqueueFlowRun.mock.calls[0][0] as unknown as {
        flowId: string;
        trigger: { channel: string; windowText: string; from: string };
        dedupeKey: string;
      };
      expect(call.flowId).toBe("22222222-bbbb-4bbb-8bbb-222222222222");
      expect(call.trigger).toMatchObject({
        channel: "manual",
        windowText: "Uday +17326190286",
        from: "assistant"
      });
      expect(call.dedupeKey).toMatch(/^manual:/);
    }
  });

  it("refuses to run a VOICE flow (real-time call path; the async worker can't execute it)", async () => {
    const voiceFlows = [
      {
        id: "77777777-aaaa-4aaa-8aaa-777777777777",
        name: "Inbound call qualifier",
        enabled: true,
        definition: { trigger: { channel: "voice" } }
      }
    ] as never[];
    const enqueueFlowRun = vi.fn();
    const deps = happyDeps({
      listFlows: vi.fn(async () => voiceFlows) as never,
      enqueueFlowRun: enqueueFlowRun as never
    });
    const res = await executeActionTool(
      BIZ,
      { name: "run_aiflow", args: { flow: "Inbound call qualifier" } },
      deps
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("voice flow") });
    expect(enqueueFlowRun).not.toHaveBeenCalled();
  });

  it("refuses to run a DISABLED flow, with the review pointer", async () => {
    const enqueueFlowRun = vi.fn();
    const deps = happyDeps({
      listFlows: vi.fn(async () => FLOWS) as never,
      enqueueFlowRun: enqueueFlowRun as never
    });
    const res = await executeActionTool(
      BIZ,
      { name: "run_aiflow", args: { flow: "Wrong-link booking flag" } },
      deps
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("DISABLED") });
    expect(res).toMatchObject({ message: expect.stringContaining("/dashboard/aiflows") });
    expect(enqueueFlowRun).not.toHaveBeenCalled();
  });

  it("fails honestly on no match, ambiguous match, invalid args, and a dedupe-null enqueue", async () => {
    const deps = happyDeps({ listFlows: vi.fn(async () => FLOWS) as never });
    expect(
      await executeActionTool(BIZ, { name: "run_aiflow", args: { flow: "nonexistent flow" } }, deps)
    ).toMatchObject({ ok: false, message: expect.stringContaining("No AiFlow matches") });
    // "booking" hits both the confirmation flow and the wrong-link flag.
    expect(
      await executeActionTool(BIZ, { name: "run_aiflow", args: { flow: "booking" } }, deps)
    ).toMatchObject({ ok: false, message: expect.stringContaining("matches 2 flows") });
    expect(
      await executeActionTool(BIZ, { name: "run_aiflow", args: {} }, deps)
    ).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });

    const nullEnqueue = happyDeps({
      listFlows: vi.fn(async () => FLOWS) as never,
      enqueueFlowRun: vi.fn(async () => null) as never
    });
    expect(
      await executeActionTool(BIZ, { name: "run_aiflow", args: { flow: "Proposal" } }, nullEnqueue)
    ).toMatchObject({ ok: false, message: expect.stringContaining("could not be enqueued") });
  });
});

describe("undo_aiflow_edit", () => {
  const FLOW = {
    id: "11111111-aaaa-4aaa-8aaa-111111111111",
    name: "Lead follow-up",
    enabled: true,
    definition: { version: 1, trigger: { channel: "manual" }, steps: [] }
  };

  it("delegates to the shared core and carries the turn's provenance", async () => {
    const undoFlowEdit = vi.fn(async () => ({
      ok: true as const,
      flowId: FLOW.id,
      flowName: FLOW.name,
      restoredFrom: "2026-08-18T04:00:00Z",
      undoneSource: "ai_edit_sms",
      note: "reverted"
    }));
    const deps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      undoFlowEdit: undoFlowEdit as never,
      flowEditSource: "ai_edit_sms",
      flowEditActor: "+15555550100"
    });
    const res = await executeActionTool(
      BIZ,
      { name: "undo_aiflow_edit", args: { flow: "Lead follow-up" } },
      deps
    );
    expect(res).toMatchObject({ ok: true, flowId: FLOW.id });
    expect(undoFlowEdit).toHaveBeenCalledWith(
      BIZ,
      { flow: "Lead follow-up" },
      expect.objectContaining({ editSource: "ai_edit_sms", editActor: "+15555550100" })
    );
  });

  it("omits provenance keys entirely when the surface supplied none", async () => {
    const undoFlowEdit = vi.fn(
      async (_biz: string, _args: { flow: string }, _deps?: Record<string, unknown>) => ({
        ok: true as const,
        flowId: FLOW.id,
        flowName: FLOW.name,
        restoredFrom: "2026-08-18T04:00:00Z",
        undoneSource: null,
        note: "reverted"
      })
    );
    const deps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      undoFlowEdit: undoFlowEdit as never
    });
    await executeActionTool(BIZ, { name: "undo_aiflow_edit", args: { flow: FLOW.id } }, deps);
    const passed = (undoFlowEdit.mock.calls[0][2] ?? {}) as Record<string, unknown>;
    expect(passed).not.toHaveProperty("editSource");
    expect(passed).not.toHaveProperty("editActor");
  });

  it("refuses invalid args without touching the core", async () => {
    const undoFlowEdit = vi.fn();
    const deps = happyDeps({ undoFlowEdit: undoFlowEdit as never });
    const res = await executeActionTool(BIZ, { name: "undo_aiflow_edit", args: {} }, deps);
    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toMatch(/^invalid_args:/);
    expect(undoFlowEdit).not.toHaveBeenCalled();
  });
});

describe("edit_aiflow", () => {
  const FLOW = {
    id: "11111111-aaaa-4aaa-8aaa-111111111111",
    name: "Lead follow-up",
    enabled: true,
    definition: {
      version: 1,
      trigger: { channel: "manual" },
      steps: [{ id: "s1", type: "notify_owner", message: "original" }]
    }
  };
  const EDITED = {
    version: 1,
    trigger: { channel: "manual" },
    steps: [{ id: "s1", type: "notify_owner", message: "updated" }]
  };

  it("stages on the first call and writes nothing", async () => {
    const persistFlowUpdate = vi.fn(async () => ({ ...FLOW, definition: EDITED }));
    const deps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      compileFlowEdit: vi.fn(async () => ({
        ok: true as const,
        definition: EDITED as never,
        warnings: []
      })) as never,
      persistFlowUpdate: persistFlowUpdate as never,
      flowEditSource: "ai_edit_sms",
      flowEditActor: "+15555550100"
    });
    const res = await executeActionTool(
      BIZ,
      { name: "edit_aiflow", args: { flow: FLOW.id, instructions: "reword it" } },
      deps
    );
    expect(res).toMatchObject({ ok: true, staged: true });
    expect(persistFlowUpdate).not.toHaveBeenCalled();
  });

  it("passes the surface kind through, so SMS gets the text-surface rules", async () => {
    // A structural edit refuses on a text surface; the dispatcher is the only
    // thing that knows which surface the turn is on.
    const deps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      compileFlowEdit: vi.fn(async () => ({
        ok: true as const,
        definition: {
          version: 1,
          trigger: { channel: "manual" },
          steps: [
            { id: "s0", type: "notify_owner", message: "new" },
            { id: "s1", type: "notify_owner", message: "original" }
          ]
        } as never,
        warnings: []
      })) as never,
      flowEditSurfaceKind: "text"
    });
    const res = await executeActionTool(
      BIZ,
      { name: "edit_aiflow", args: { flow: FLOW.id, instructions: "add a step" } },
      deps
    );
    expect(res).toMatchObject({ ok: false });
    expect((res as { message: string }).message).toContain("/dashboard/aiflows?edit=");
  });

  it("delegates to the shared core: compile against the current definition, then persist in place", async () => {
    const compileFlowEdit = vi.fn(async () => ({
      ok: true as const,
      definition: EDITED as never,
      warnings: []
    }));
    const persistFlowUpdate = vi.fn(async () => ({ ...FLOW, definition: EDITED }));
    const deps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      compileFlowEdit: compileFlowEdit as never,
      persistFlowUpdate: persistFlowUpdate as never
    });
    const res = await executeActionTool(
      BIZ,
      {
        name: "edit_aiflow",
        args: { flow: "Lead follow-up", instructions: "say 'updated' instead" }
      },
      deps
    );
    expect(res).toMatchObject({ ok: true, staged: true, flowId: FLOW.id });
    expect(compileFlowEdit).toHaveBeenCalledWith({
      businessId: BIZ,
      flowName: "Lead follow-up",
      currentDefinition: FLOW.definition,
      instructions: "say 'updated' instead"
    });
    // Staging only: the live flow is untouched until the owner confirms.
    expect(persistFlowUpdate).not.toHaveBeenCalled();

    // Second call, with the token: the staged bytes land, provenance and all.
    const token = (res as { confirmationToken: string }).confirmationToken;
    const confirmDeps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      persistFlowUpdate: persistFlowUpdate as never,
      flowEditSource: "ai_edit_dashboard",
      flowEditActor: "owner@example.com"
    });
    const applied = await executeActionTool(
      BIZ,
      {
        name: "edit_aiflow",
        args: {
          flow: "Lead follow-up",
          instructions: "say 'updated' instead",
          confirmationToken: token
        }
      },
      confirmDeps
    );
    expect(applied).toMatchObject({ ok: true, flowId: FLOW.id, flowName: "Lead follow-up" });
    expect(persistFlowUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        id: FLOW.id,
        definition: EDITED,
        editSource: "ai_edit_dashboard",
        editActor: "owner@example.com"
      })
    );
  });

  it("rejects invalid args before touching the core, and passes compile refusals through", async () => {
    const compileFlowEdit = vi.fn();
    const deps = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      compileFlowEdit: compileFlowEdit as never
    });
    expect(
      await executeActionTool(BIZ, { name: "edit_aiflow", args: { flow: "Lead follow-up" } }, deps)
    ).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
    expect(compileFlowEdit).not.toHaveBeenCalled();

    const refusing = happyDeps({
      listFlows: vi.fn(async () => [FLOW]) as never,
      compileFlowEdit: vi.fn(async () => ({
        ok: false as const,
        error: "invalid" as const,
        message: "…the automation was NOT changed…",
        issues: ["bad"]
      })) as never,
      persistFlowUpdate: vi.fn() as never
    });
    const res = await executeActionTool(
      BIZ,
      { name: "edit_aiflow", args: { flow: "Lead follow-up", instructions: "break it" } },
      refusing
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("NOT changed") });
    expect(refusing.persistFlowUpdate).not.toHaveBeenCalled();
  });
});

describe("generate_image", () => {
  it("passes prompt + normalized aspect ratio + input image ref to the dashboard core", async () => {
    const generateImage = vi.fn(async () => ({
      ok: true,
      data: {
        imageUrl: "/api/dashboard/images/b/i.png",
        markdown: "![Generated image](/api/dashboard/images/b/i.png)"
      }
    }));
    const res = await executeActionTool(
      BIZ,
      {
        name: "generate_image",
        args: {
          prompt: "A blue heron logo",
          aspectRatio: "16:9",
          inputImageUrl: "/api/dashboard/images/b/prev.png"
        }
      },
      happyDeps({ generateImage: generateImage as never })
    );
    expect(res).toMatchObject({ ok: true, data: expect.objectContaining({ markdown: expect.any(String) }) });
    expect(generateImage).toHaveBeenCalledWith(BIZ, "A blue heron logo", {
      aspectRatio: "16:9",
      inputImageRef: "/api/dashboard/images/b/prev.png"
    });
  });

  it("drops an unsupported aspect ratio and omits the input ref when absent", async () => {
    const generateImage = vi.fn(async () => ({ ok: true, data: { imageUrl: "u", markdown: "m" } }));
    await executeActionTool(
      BIZ,
      { name: "generate_image", args: { prompt: "p", aspectRatio: "banana" } },
      happyDeps({ generateImage: generateImage as never })
    );
    expect(generateImage).toHaveBeenCalledWith(BIZ, "p", { aspectRatio: undefined });
  });

  it("returns the core's refusal untouched (limit / budget) and rejects invalid args", async () => {
    const refused = await executeActionTool(
      BIZ,
      { name: "generate_image", args: { prompt: "p" } },
      happyDeps({
        generateImage: vi.fn(async () => ({
          ok: false,
          detail: "image_limit_reached",
          message: "The image limit (3 per conversation) has been reached."
        })) as never
      })
    );
    expect(refused).toMatchObject({ ok: false, detail: "image_limit_reached" });

    const generateImage = vi.fn();
    const bad = await executeActionTool(
      BIZ,
      { name: "generate_image", args: {} },
      happyDeps({ generateImage: generateImage as never })
    );
    expect(bad).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
    expect(generateImage).not.toHaveBeenCalled();
  });
});

describe("calendar_join_waitlist", () => {
  it("is declared with a required phone and honest no-promises guidance, gated off cleanly", () => {
    const decl = actionToolDeclarations(ALL_ON).find((d) => d.name === "calendar_join_waitlist");
    expect(decl?.description).toMatch(/waitlist/i);
    expect(decl?.description).toMatch(/Never promise/i);
    expect(
      (decl?.parameters as { required: string[] }).required
    ).toEqual(["attendeePhone"]);

    const gatedOff = actionToolDeclarations({ ...ALL_ON, calendar_join_waitlist: false });
    expect(gatedOff.map((d) => d.name)).not.toContain("calendar_join_waitlist");
  });

  it("delegates parsed args to the shared core and returns its payload verbatim", async () => {
    const joinWaitlist = vi.fn(async () => ({
      ok: true,
      detail: "waitlist_joined",
      data: { phone: "+15551234567" },
      message: "They are on the waitlist."
    }));
    const res = await executeActionTool(
      BIZ,
      {
        name: "calendar_join_waitlist",
        args: { attendeePhone: "+15551234567", attendeeName: "Pat", durationMinutes: 60 }
      },
      happyDeps({ joinWaitlist: joinWaitlist as never })
    );
    expect(res).toMatchObject({ ok: true, detail: "waitlist_joined" });
    expect(joinWaitlist).toHaveBeenCalledWith(
      BIZ,
      { attendeePhone: "+15551234567", attendeeName: "Pat", durationMinutes: 60 },
      null
    );
  });

  it("rejects invalid args before touching the core", async () => {
    const joinWaitlist = vi.fn();
    const res = await executeActionTool(
      BIZ,
      { name: "calendar_join_waitlist", args: { attendeeName: "Pat" } },
      happyDeps({ joinWaitlist: joinWaitlist as never })
    );
    expect(res).toMatchObject({ ok: false, message: expect.stringContaining("invalid_args") });
    expect(joinWaitlist).not.toHaveBeenCalled();
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

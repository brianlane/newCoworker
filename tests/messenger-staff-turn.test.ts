import { describe, expect, it, vi } from "vitest";
import {
  runMessengerStaffTurn,
  type MessengerStaffTurnDeps
} from "@/lib/messenger/staff-turn";
import type { MessengerConversationRow, MessengerMessageRow } from "@/lib/messenger/db";
import type { OwnerSurfaceContext } from "@/lib/owner-surfaces/context";

/**
 * WhatsApp from the business's own people.
 *
 * The bug this closes: an owner messaging their own business's WhatsApp
 * number reached the CUSTOMER sales assistant. It pitched them, asked for
 * their contact details, and filed them as a lead. James Fung (KYP Ads) has
 * no working SMS, so WhatsApp is one of the few channels that can reach him
 * at all.
 *
 * Two properties matter more than the rest:
 *
 *  1. Staff mode OFF means SILENT, never "fall through to the customer
 *     assistant". Falling through would re-create the exact bug through the
 *     settings page.
 *  2. Only WhatsApp qualifies. A Messenger or Instagram psid is an opaque
 *     page-scoped id, and a captured contact_phone is SELF-ASSERTED, so
 *     trusting either would let anyone claim to be the owner by typing a
 *     phone number into a DM.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";

function conversation(
  overrides: Partial<MessengerConversationRow> = {}
): MessengerConversationRow {
  return {
    id: "conv-1",
    business_id: BIZ,
    platform: "whatsapp",
    page_id: "phone-number-id",
    psid: "15145188192",
    display_name: "James",
    contact_phone: null,
    last_user_message_at: "2026-08-25T12:00:00Z",
    ...overrides
  } as MessengerConversationRow;
}

function history(): MessengerMessageRow[] {
  return [
    { id: 1, role: "user", content: "what did Dana book today?" } as MessengerMessageRow
  ];
}

function deps(overrides: MessengerStaffTurnDeps = {}): MessengerStaffTurnDeps {
  return {
    resolveSpeaker: vi.fn(async () => ({
      kind: "owner" as const,
      name: "James Fung",
      readFailed: false
    })),
    isStaffModeEnabled: vi.fn(async () => true),
    loadContext: vi.fn(async (): Promise<OwnerSurfaceContext> => ({
      timezone: "America/Toronto",
      tier: "standard" as OwnerSurfaceContext["tier"],
      ownerEmail: "james@kypads.com",
      knowledgeToolEnabled: true,
      emailToolEnabled: true,
      toolStates: {
        send_sms: true,
        send_whatsapp: true,
        calendar_find_slots: true,
        calendar_book_appointment: true,
        calendar_reschedule_appointment: true,
        calendar_cancel_appointment: true,
        calendar_join_waitlist: true,
        run_aiflow: true,
        edit_aiflow: true,
        update_notification_preferences: true,
        flag_contact_spam: true,
        set_contact_reply_mode: true,
        manage_employee: true,
        custom_table_read: true,
        custom_table_write: true,
        custom_table_manage: true
      },
      whatsappConnected: true,
      integrationsLine: null,
      bookingLinkLine: null,
      businessContextBlock: null,
      bridgeExtraTools: null,
      overCap: false
    })),
    runTurn: vi.fn(async () => ({ ok: true, content: "Dana booked two." })) as never,
    ...overrides
  };
}

describe("who gets a staff turn", () => {
  it("answers the owner as the owner", async () => {
    const d = deps();
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "reply", reply: "Dana booked two." });
  });

  it("hands an unknown number back to the customer assistant untouched", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "customer", name: null, readFailed: false })
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "customer" });
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("treats an unresolvable speaker as a customer", async () => {
    // resolveSurfaceSpeaker already fails closed; this asserts we honour it
    // rather than second-guessing the flag.
    const d = deps({
      resolveSpeaker: async () => ({ kind: "customer", name: null, readFailed: true })
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "customer" });
  });

  it("answers a roster teammate too", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "teammate", name: "Dana Ruiz", readFailed: false })
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toMatchObject({ kind: "reply" });
  });
});

describe("only WhatsApp can identify staff", () => {
  it.each(["messenger", "instagram"] as const)(
    "never runs a staff turn on %s",
    async (platform) => {
      // A psid there is an opaque page-scoped id, and contact_phone is
      // self-asserted: trusting either would let anyone claim to be the
      // owner by typing a phone number into a DM.
      const d = deps();
      const out = await runMessengerStaffTurn(
        {
          businessId: BIZ,
          conversation: conversation({ platform, contact_phone: "+15145188192" }),
          history: history()
        },
        d
      );
      expect(out).toEqual({ kind: "customer" });
      expect(d.resolveSpeaker).not.toHaveBeenCalled();
    }
  );

  it("ignores a psid that is not a usable international number", async () => {
    const d = deps();
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation({ psid: "not-a-number" }), history: history() },
      d
    );
    expect(out).toEqual({ kind: "customer" });
    expect(d.resolveSpeaker).not.toHaveBeenCalled();
  });
});

describe("staff mode off means silent", () => {
  it("stays quiet rather than falling through to the customer assistant", async () => {
    // Falling through would re-create the original bug through the settings
    // page: the owner would be pitched by their own sales assistant.
    const d = deps({ isStaffModeEnabled: async () => false });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "silent", reason: "staff_mode_off" });
    expect(d.runTurn).not.toHaveBeenCalled();
  });
});

describe("the turn itself", () => {
  it("runs the owner persona, not the messenger customer preamble", async () => {
    const d = deps();
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    const args = vi.mocked(d.runTurn!).mock.calls[0][0];
    expect(args.systemInstruction).toContain("OWNER MODE");
    expect(args.systemInstruction).toContain("WHATSAPP");
    expect(args.systemInstruction).not.toContain("capture_lead");
  });

  it("never declares the lead-capture tool, so staff cannot be filed as a lead", async () => {
    const d = deps();
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    const args = vi.mocked(d.runTurn!).mock.calls[0][0];
    expect(Object.keys(args.actionToolGates ?? {})).not.toContain("capture_lead");
  });

  it("gives a teammate the team persona and withholds owner powers", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "teammate", name: "Dana Ruiz", readFailed: false })
    });
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    const args = vi.mocked(d.runTurn!).mock.calls[0][0];
    expect(args.systemInstruction).not.toContain("OWNER MODE");
    expect(args.actionToolGates?.edit_aiflow).toBe(false);
    expect(args.actionToolGates?.manage_employee).toBe(false);
    expect(args.actionToolGates?.run_aiflow).toBe(true);
  });

  it("labels the replayed transcript by who is actually speaking", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "teammate", name: "Dana Ruiz", readFailed: false })
    });
    await runMessengerStaffTurn(
      {
        businessId: BIZ,
        conversation: conversation(),
        history: [
          { id: 1, role: "user", content: "earlier question" } as MessengerMessageRow,
          { id: 2, role: "assistant", content: "earlier answer" } as MessengerMessageRow,
          { id: 3, role: "user", content: "and now?" } as MessengerMessageRow
        ]
      },
      d
    );
    const sys = vi.mocked(d.runTurn!).mock.calls[0][0].systemInstruction;
    expect(sys).toContain("[Teammate]: earlier question");
    expect(sys).toContain("[Coworker]: earlier answer");
  });

  it("stamps WhatsApp provenance on any flow edit made here", async () => {
    const d = deps();
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(vi.mocked(d.runTurn!).mock.calls[0][0].flowEditSource).toBe("ai_edit_whatsapp");
  });

  it("replays the recent exchange so the thread has continuity", async () => {
    const d = deps();
    await runMessengerStaffTurn(
      {
        businessId: BIZ,
        conversation: conversation(),
        history: [
          { id: 1, role: "user", content: "earlier question" } as MessengerMessageRow,
          { id: 2, role: "assistant", content: "earlier answer" } as MessengerMessageRow,
          { id: 3, role: "user", content: "what did Dana book today?" } as MessengerMessageRow
        ]
      },
      d
    );
    const args = vi.mocked(d.runTurn!).mock.calls[0][0];
    expect(args.systemInstruction).toContain("earlier question");
    // The message being answered must not appear twice.
    expect(args.systemInstruction).not.toContain("what did Dana book today?");
    expect(args.userMessage).toContain("what did Dana book today?");
  });

  it("never talks over a human who already answered by hand", async () => {
    // A teammate replying from the Meta inbox or Business Suite closes the
    // turn. The customer engine refuses this case too; the staff path has
    // to agree, or the AI follows up on top of a colleague.
    for (const closingRole of ["assistant", "owner"] as const) {
      const d = deps();
      const out = await runMessengerStaffTurn(
        {
          businessId: BIZ,
          conversation: conversation(),
          history: [
            { id: 1, role: "user", content: "what did Dana book today?" } as MessengerMessageRow,
            { id: 2, role: closingRole, content: "answered by hand" } as MessengerMessageRow
          ]
        },
        d
      );
      expect(out, closingRole).toEqual({ kind: "failed", detail: "no_input", terminal: true });
      expect(d.runTurn).not.toHaveBeenCalled();
    }
  });

  it("reports a failed turn instead of silently answering as a customer", async () => {
    // The worker retries a failure. Falling back to the customer engine
    // would pitch the owner, which is worse than saying nothing yet.
    const d = deps({
      runTurn: (async () => ({ ok: false, error: "model_failed", detail: "boom" })) as never
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "failed", detail: "boom" });
  });

  it("refuses an empty reply rather than sending a blank message", async () => {
    const d = deps({ runTurn: (async () => ({ ok: true, content: "   " })) as never });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toMatchObject({ kind: "failed" });
  });

  it("clips a long reply to what the surface allows", async () => {
    const d = deps({
      runTurn: (async () => ({ ok: true, content: "x".repeat(5000) })) as never
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out.kind).toBe("reply");
    if (out.kind === "reply") expect(out.reply.length).toBe(1600);
  });

  it("returns nothing to answer when the window holds no user turn", async () => {
    const d = deps();
    const out = await runMessengerStaffTurn(
      {
        businessId: BIZ,
        conversation: conversation(),
        history: [{ id: 1, role: "assistant", content: "only me" } as MessengerMessageRow]
      },
      d
    );
    expect(out).toMatchObject({ kind: "failed", detail: "no_input", terminal: true });
    expect(d.runTurn).not.toHaveBeenCalled();
  });
});

describe("things that stop a staff turn before it starts", () => {
  it("declines when the business is over its AI spend cap", async () => {
    const base = deps();
    const d = deps({
      loadContext: (async () => ({
        ...(await base.loadContext!(BIZ, {} as never, {} as never)),
        overCap: true
      })) as never
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "failed", detail: "over_cap", terminal: true });
    expect(d.runTurn).not.toHaveBeenCalled();
  });

  it("reports a context load failure instead of answering as a customer", async () => {
    const d = deps({
      loadContext: (async () => {
        throw new Error("settings unreadable");
      }) as never
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "failed", detail: "settings unreadable" });
  });

  it("survives a context load that rejects with something other than an Error", async () => {
    const d = deps({
      loadContext: (async () => {
        throw "connection reset";
      }) as never
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "failed", detail: "connection reset" });
  });

  it("refuses a message whose only user turn is blank", async () => {
    const d = deps();
    const out = await runMessengerStaffTurn(
      {
        businessId: BIZ,
        conversation: conversation(),
        history: [{ id: 1, role: "user", content: "   " } as MessengerMessageRow]
      },
      d
    );
    expect(out).toEqual({ kind: "failed", detail: "no_input", terminal: true });
  });

  it("labels the speaker even when no name is known", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "owner", name: null, readFailed: false })
    });
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(vi.mocked(d.runTurn!).mock.calls[0][0].userMessage).toContain("[WhatsApp from owner]");
  });

  it("falls back to the generic error when the turn reports neither detail nor error", async () => {
    const d = deps({ runTurn: (async () => ({ ok: false })) as never });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(out).toEqual({ kind: "failed", detail: "turn_failed" });
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

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
 *
 * The turn assembly moved to `owner-surfaces/run-turn.ts`, but these tests
 * deliberately still drive it FOR REAL (only the three leaf reads are
 * mocked) rather than stubbing the runner out. The assertions below are
 * about what actually reaches the model on this surface (the owner persona,
 * the WhatsApp provenance stamp, the absence of capture_lead), and a stubbed
 * runner would assert that we called a function, not that the owner stops
 * being pitched.
 */

vi.mock("@/lib/owner-surfaces/staff-mode", () => ({
  staffModeEnabled: vi.fn()
}));
vi.mock("@/lib/owner-surfaces/context", () => ({
  loadOwnerSurfaceContext: vi.fn()
}));
vi.mock("@/lib/dashboard-chat/inline-turn", () => ({
  runInlineChatTurn: vi.fn()
}));

import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import { loadOwnerSurfaceContext } from "@/lib/owner-surfaces/context";
import { staffModeEnabled } from "@/lib/owner-surfaces/staff-mode";
import {
  runMessengerStaffTurn,
  type MessengerStaffTurnDeps
} from "@/lib/messenger/staff-turn";
import type { MessengerConversationRow, MessengerMessageRow } from "@/lib/messenger/db";
import type { OwnerSurfaceContext } from "@/lib/owner-surfaces/context";

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

function context(overrides: Partial<OwnerSurfaceContext> = {}): OwnerSurfaceContext {
  return {
    timezone: "America/Toronto",
    tier: "standard" as OwnerSurfaceContext["tier"],
    ownerEmail: "james@kypads.com",
    knowledgeToolEnabled: true,
    emailToolEnabled: true,
    toolStates: {
      send_sms: true,
      send_whatsapp: true,
      schedule_text: true,
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
    overCap: false,
    ...overrides
  };
}

function deps(overrides: MessengerStaffTurnDeps = {}): MessengerStaffTurnDeps {
  return {
    resolveSpeaker: vi.fn(async () => ({
      kind: "owner" as const,
      name: "James Fung",
      readFailed: false
    })),
    ...overrides
  };
}

/** The args that actually reached the model on the one turn we ran. */
function turnArgs() {
  return vi.mocked(runInlineChatTurn).mock.calls[0][0];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(staffModeEnabled).mockResolvedValue(true);
  vi.mocked(loadOwnerSurfaceContext).mockResolvedValue(context());
  vi.mocked(runInlineChatTurn).mockResolvedValue({
    ok: true,
    content: "Dana booked two.",
    drafts: []
  });
});

describe("who gets a staff turn", () => {
  it("answers the owner as the owner", async () => {
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toMatchObject({ kind: "reply", reply: "Dana booked two." });
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
    expect(runInlineChatTurn).not.toHaveBeenCalled();
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
    vi.mocked(staffModeEnabled).mockResolvedValue(false);
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({ kind: "silent", reason: "staff_mode_off" });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });

  it("asks about THIS surface, not some other one", async () => {
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(staffModeEnabled).toHaveBeenCalledWith(BIZ, "whatsapp");
  });
});

describe("the turn itself", () => {
  it("runs the owner persona, not the messenger customer preamble", async () => {
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    const args = turnArgs();
    expect(args.systemInstruction).toContain("OWNER MODE");
    expect(args.systemInstruction).toContain("WHATSAPP");
    expect(args.systemInstruction).not.toContain("capture_lead");
  });

  it("never declares the lead-capture tool, so staff cannot be filed as a lead", async () => {
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(Object.keys(turnArgs().actionToolGates ?? {})).not.toContain("capture_lead");
  });

  it("gives a teammate the team persona and withholds owner powers", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "teammate", name: "Dana Ruiz", readFailed: false })
    });
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    const args = turnArgs();
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
    const sys = turnArgs().systemInstruction;
    expect(sys).toContain("[Teammate]: earlier question");
    expect(sys).toContain("[Coworker]: earlier answer");
  });

  it("stamps WhatsApp provenance on any flow edit made here", async () => {
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(turnArgs().flowEditSource).toBe("ai_edit_whatsapp");
  });

  it("replays the recent exchange so the thread has continuity", async () => {
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
      deps()
    );
    const args = turnArgs();
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
      vi.clearAllMocks();
      vi.mocked(staffModeEnabled).mockResolvedValue(true);
      vi.mocked(loadOwnerSurfaceContext).mockResolvedValue(context());
      const out = await runMessengerStaffTurn(
        {
          businessId: BIZ,
          conversation: conversation(),
          history: [
            { id: 1, role: "user", content: "what did Dana book today?" } as MessengerMessageRow,
            { id: 2, role: closingRole, content: "answered by hand" } as MessengerMessageRow
          ]
        },
        deps()
      );
      expect(out, closingRole).toEqual({
        kind: "failed",
        detail: "no_input",
        code: "no_input",
        terminal: true
      });
      expect(runInlineChatTurn).not.toHaveBeenCalled();
    }
  });

  it("reports a failed turn instead of silently answering as a customer", async () => {
    // The worker retries a failure. Falling back to the customer engine
    // would pitch the owner, which is worse than saying nothing yet.
    vi.mocked(runInlineChatTurn).mockResolvedValue({
      ok: false,
      error: "model_failed",
      detail: "boom"
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({ kind: "failed", detail: "boom", code: "model_failed" });
  });

  it("refuses an empty reply rather than sending a blank message", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValue({ ok: true, content: "   ", drafts: [] });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({ kind: "failed", detail: "empty_reply", code: "empty" });
  });

  it("clips a long reply to what the surface allows", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValue({
      ok: true,
      content: "x".repeat(5000),
      drafts: []
    });
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out.kind).toBe("reply");
    if (out.kind === "reply") expect(out.reply.length).toBe(1600);
  });

  it("returns nothing to answer when the window holds no user turn", async () => {
    const out = await runMessengerStaffTurn(
      {
        businessId: BIZ,
        conversation: conversation(),
        history: [{ id: 1, role: "assistant", content: "only me" } as MessengerMessageRow]
      },
      deps()
    );
    expect(out).toEqual({
      kind: "failed",
      detail: "no_input",
      code: "no_input",
      terminal: true
    });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });
});

describe("things that stop a staff turn before it starts", () => {
  it("declines when the business is over its AI spend cap", async () => {
    // WhatsApp has nowhere to post an apology that would not spend a billed
    // template, so the shared runner's over_cap verdict lands here as a
    // terminal failure rather than a message.
    vi.mocked(loadOwnerSurfaceContext).mockResolvedValue(context({ overCap: true }));
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({
      kind: "failed",
      detail: "over_cap",
      code: "over_cap",
      terminal: true
    });
    expect(runInlineChatTurn).not.toHaveBeenCalled();
  });

  it("reports a context load failure instead of answering as a customer", async () => {
    vi.mocked(loadOwnerSurfaceContext).mockRejectedValue(new Error("settings unreadable"));
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({
      kind: "failed",
      detail: "settings unreadable",
      code: "context_load_failed"
    });
  });

  it("survives a context load that rejects with something other than an Error", async () => {
    vi.mocked(loadOwnerSurfaceContext).mockRejectedValue("connection reset");
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({
      kind: "failed",
      detail: "connection reset",
      code: "context_load_failed"
    });
  });

  it("refuses a message whose only user turn is blank", async () => {
    const out = await runMessengerStaffTurn(
      {
        businessId: BIZ,
        conversation: conversation(),
        history: [{ id: 1, role: "user", content: "   " } as MessengerMessageRow]
      },
      deps()
    );
    expect(out).toEqual({
      kind: "failed",
      detail: "no_input",
      code: "no_input",
      terminal: true
    });
  });

  it("labels the speaker even when no name is known", async () => {
    const d = deps({
      resolveSpeaker: async () => ({ kind: "owner", name: null, readFailed: false })
    });
    await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      d
    );
    expect(turnArgs().userMessage).toContain("[WhatsApp from owner]");
  });

  it("falls back to the generic error when the turn reports neither detail nor error", async () => {
    vi.mocked(runInlineChatTurn).mockResolvedValue({} as never);
    const out = await runMessengerStaffTurn(
      { businessId: BIZ, conversation: conversation(), history: history() },
      deps()
    );
    expect(out).toEqual({ kind: "failed", detail: "turn_failed", code: "model_failed" });
  });
});

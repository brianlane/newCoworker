/**
 * One email coworker turn: the narrow tool surface a third-party
 * correspondent gets, the threaded reply, and the honest failure paths.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/dashboard-chat/inline-turn", () => ({ runInlineChatTurn: vi.fn() }));
vi.mock("@/lib/dashboard-chat/context-blocks", () => ({
  buildIntegrationsStatusLine: vi.fn(),
  buildBusinessContextBlock: vi.fn()
}));
vi.mock("@/lib/db/agent-tool-settings", () => ({ isAgentToolEnabled: vi.fn() }));
vi.mock("@/lib/email/owner-mailbox", () => ({ sendFromMailboxConnection: vi.fn() }));
vi.mock("@/lib/db/email-log", () => ({ recordOutboundAssistantEmail: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import {
  EMAIL_SURFACE_BLOCK,
  EMAIL_TURN_BUDGET_MS,
  NEEDS_HUMAN_SENTINEL,
  buildEmailTurnSystem,
  replySubject,
  runEmailCoworkerTurn,
  splitHandoffSentinel
} from "@/lib/email-coworker/turn";
import { runInlineChatTurn } from "@/lib/dashboard-chat/inline-turn";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { isAgentToolEnabled } from "@/lib/db/agent-tool-settings";
import { sendFromMailboxConnection } from "@/lib/email/owner-mailbox";
import { recordOutboundAssistantEmail } from "@/lib/db/email-log";

const BIZ = "11111111-1111-4111-8111-111111111111";
const mockTurn = vi.mocked(runInlineChatTurn);
const mockIntegrations = vi.mocked(buildIntegrationsStatusLine);
const mockContext = vi.mocked(buildBusinessContextBlock);
const mockToolEnabled = vi.mocked(isAgentToolEnabled);
const mockSend = vi.mocked(sendFromMailboxConnection);
const mockRecord = vi.mocked(recordOutboundAssistantEmail);

const THREAD = {
  id: "row-1",
  businessId: BIZ,
  provider: "google" as const,
  threadId: "thread-9",
  subject: "NC Discovery Call w/ Liz",
  correspondentEmail: "beth@lizdev.com",
  lastSentMessageRef: "<brian-1@mail>",
  turns: 0,
  turnsDay: null,
  handedOff: false
};

const MESSAGE = {
  id: "m-1",
  threadId: "thread-9",
  fromEmail: "beth@lizdev.com",
  subject: "Re: NC Discovery Call w/ Liz",
  bodyText: "Liz has availability Monday at 12:00 PM EST. Please send the Zoom invite.",
  messageRef: "<beth-1@mail>"
};

const LINK = {
  provider: "google" as const,
  connectionId: "c-1",
  providerConfigKey: "google"
};

beforeEach(() => {
  vi.clearAllMocks();
  mockIntegrations.mockResolvedValue("Connected: Google Calendar");
  mockContext.mockResolvedValue("Business: New Coworker");
  mockToolEnabled.mockResolvedValue(true);
  mockTurn.mockResolvedValue({ ok: true, content: "Monday at 12:00 PM Eastern works." } as never);
  mockSend.mockResolvedValue({
    ok: true,
    provider: "google",
    messageId: "sent-1",
    threadId: "thread-9"
  } as never);
  mockRecord.mockResolvedValue(undefined);
});

describe("EMAIL_SURFACE_BLOCK", () => {
  it("states the third-party booking rule and the no-other-actions boundary", () => {
    // The Beth case: booking the ASSISTANT sends the invite to the wrong
    // person, so this rule is the reason the surface exists at all.
    expect(EMAIL_SURFACE_BLOCK).toMatch(/NOT the business owner/);
    expect(EMAIL_SURFACE_BLOCK).toMatch(/book the PRINCIPAL/i);
    expect(EMAIL_SURFACE_BLOCK).toMatch(/cannot send text messages/i);
    expect(EMAIL_SURFACE_BLOCK).not.toContain("—");
  });
});

describe("splitHandoffSentinel", () => {
  it("strips the sentinel and reports the escalation", () => {
    expect(
      splitHandoffSentinel(`I am bringing in a colleague on pricing.\n\n${NEEDS_HUMAN_SENTINEL}`)
    ).toEqual({ text: "I am bringing in a colleague on pricing.", handoff: true });
  });

  it("leaves an ordinary reply untouched", () => {
    expect(splitHandoffSentinel("Booked for Monday at 9 AM Mountain.")).toEqual({
      text: "Booked for Monday at 9 AM Mountain.",
      handoff: false
    });
  });

  it("collapses the gap a mid-body sentinel leaves behind", () => {
    expect(
      splitHandoffSentinel(`Line one.\n\n${NEEDS_HUMAN_SENTINEL}\n\nLine two.`).text
    ).toBe("Line one.\n\nLine two.");
  });
});

describe("replySubject", () => {
  it("prefixes once and falls back when there is no subject", () => {
    expect(replySubject("Discovery call")).toBe("Re: Discovery call");
    expect(replySubject("Re: Discovery call")).toBe("Re: Discovery call");
    expect(replySubject("RE: Discovery call")).toBe("RE: Discovery call");
    expect(replySubject("  ")).toBe("Re: your message");
    expect(replySubject(null)).toBe("Re: your message");
    expect(replySubject(undefined)).toBe("Re: your message");
  });
});

describe("buildEmailTurnSystem", () => {
  it("carries the surface block, the correspondent, the date line, and context", () => {
    const system = buildEmailTurnSystem({
      businessTimezone: "America/Phoenix",
      correspondentEmail: "beth@lizdev.com",
      subject: "Discovery",
      integrationsLine: "Connected: Google Calendar",
      businessContextBlock: "Business: New Coworker",
      now: new Date("2026-07-25T16:00:00.000Z")
    });
    expect(system).toContain(EMAIL_SURFACE_BLOCK);
    expect(system).toContain('replying to beth@lizdev.com on the thread "Discovery"');
    expect(system).toContain("Connected: Google Calendar");
    expect(system).toContain("Business: New Coworker");
    expect(system).toMatch(/never use an em dash/i);
  });

  it("omits empty blocks rather than leaving blank sections", () => {
    const system = buildEmailTurnSystem({
      businessTimezone: null,
      correspondentEmail: "beth@lizdev.com",
      subject: null,
      integrationsLine: null,
      businessContextBlock: null
    });
    expect(system).toContain("replying to beth@lizdev.com");
    expect(system).not.toContain('on the thread ""');
    expect(system).not.toMatch(/\n\n\n/);
  });
});

describe("runEmailCoworkerTurn", () => {
  it("declares ONLY calendar tools: no texting, no automations, no settings", async () => {
    await runEmailCoworkerTurn({
      thread: THREAD,
      message: MESSAGE,
      link: LINK,
      businessTimezone: "America/Phoenix"
    });
    const gates = mockTurn.mock.calls[0][0].actionToolGates!;
    expect(gates).toMatchObject({
      calendar_find_slots: true,
      calendar_book_appointment: true,
      calendar_reschedule_appointment: true,
      calendar_cancel_appointment: true,
      calendar_join_waitlist: true
    });
    // Everything a third party must never reach, regardless of settings.
    for (const owned of [
      "send_sms",
      "send_whatsapp",
      "list_aiflows",
      "run_aiflow",
      "edit_aiflow",
      "generate_image",
      "update_notification_preferences",
      "flag_contact_spam",
      "set_contact_reply_mode"
    ] as const) {
      expect(gates[owned], `${owned} must be hard-false on the email surface`).toBe(false);
    }
    expect(mockTurn.mock.calls[0][0].includeCreationTools).toBe(false);
    // Bounded so the reply send still fits inside the poll route's 60s.
    expect(mockTurn.mock.calls[0][0].budgetMs).toBe(EMAIL_TURN_BUDGET_MS);
    expect(EMAIL_TURN_BUDGET_MS).toBeLessThan(60_000);
    // Gates are read from the EMAIL surface's own toggles, not the owner's.
    for (const call of mockToolEnabled.mock.calls) {
      expect(call[1]).toBe("email");
    }
  });

  it("honours a disabled calendar toggle", async () => {
    mockToolEnabled.mockImplementation(async (_biz, _agent, tool) =>
      tool !== "calendar_book_appointment"
    );
    await runEmailCoworkerTurn({
      thread: THREAD,
      message: MESSAGE,
      link: LINK,
      businessTimezone: null
    });
    expect(mockTurn.mock.calls[0][0].actionToolGates!.calendar_book_appointment).toBe(false);
  });

  it("replies INTO the thread and files the send under email_coworker", async () => {
    const out = await runEmailCoworkerTurn({
      thread: THREAD,
      message: MESSAGE,
      link: LINK,
      businessTimezone: "America/Phoenix"
    });
    expect(out).toEqual({
      ok: true,
      reply: "Monday at 12:00 PM Eastern works.",
      handoff: false,
      sent: true
    });
    const [, conn, sendArgs] = mockSend.mock.calls[0];
    expect(conn).toEqual({
      provider: "google",
      providerConfigKey: "google",
      connectionId: "c-1"
    });
    expect(sendArgs).toMatchObject({
      toEmail: "beth@lizdev.com",
      subject: "Re: NC Discovery Call w/ Liz",
      thread: {
        threadId: "thread-9",
        inReplyToMessageRef: "<beth-1@mail>",
        providerMessageId: "m-1"
      }
    });
    expect(mockRecord).toHaveBeenCalledWith(
      expect.objectContaining({ source: "email_coworker", providerMessageId: "sent-1" })
    );
    // The inbound message reaches the model with its sender and subject.
    expect(String(mockTurn.mock.calls[0][0].userMessage)).toContain("[Email from beth@lizdev.com]");
    expect(String(mockTurn.mock.calls[0][0].userMessage)).toContain("12:00 PM EST");
  });

  it("falls back to the message's own subject when the thread has none", async () => {
    await runEmailCoworkerTurn({
      thread: { ...THREAD, subject: null },
      message: MESSAGE,
      link: LINK,
      businessTimezone: null
    });
    expect(mockSend.mock.calls[0][2].subject).toBe("Re: NC Discovery Call w/ Liz");
  });

  it("reports an engine failure without sending anything", async () => {
    mockTurn.mockResolvedValue({ ok: false, error: "over_cap", detail: "over_cap" } as never);
    expect(
      await runEmailCoworkerTurn({
        thread: THREAD,
        message: MESSAGE,
        link: LINK,
        businessTimezone: null
      })
    ).toEqual({ ok: false, detail: "over_cap" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("reports a detail-less engine failure and a blank draw honestly", async () => {
    mockTurn.mockResolvedValue({ ok: false } as never);
    expect(
      (
        await runEmailCoworkerTurn({
          thread: THREAD,
          message: MESSAGE,
          link: LINK,
          businessTimezone: null
        })
      ).ok
    ).toBe(false);

    mockTurn.mockResolvedValue({ ok: true, content: "   " } as never);
    expect(
      await runEmailCoworkerTurn({
        thread: THREAD,
        message: MESSAGE,
        link: LINK,
        businessTimezone: null
      })
    ).toEqual({ ok: false, detail: "empty_reply" });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("surfaces a disconnected mailbox and files nothing", async () => {
    mockSend.mockResolvedValue({ ok: false, detail: "email_not_connected" } as never);
    expect(
      await runEmailCoworkerTurn({
        thread: THREAD,
        message: MESSAGE,
        link: LINK,
        businessTimezone: null
      })
    ).toEqual({ ok: false, detail: "email_not_connected" });
    expect(mockRecord).not.toHaveBeenCalled();
  });

  it("reports an escalation and never mails the sentinel to the correspondent", async () => {
    mockTurn.mockResolvedValue({
      ok: true,
      content: `Liz's team handles pricing, I am bringing in a colleague.\n\n${NEEDS_HUMAN_SENTINEL}`
    } as never);
    const out = await runEmailCoworkerTurn({
      thread: THREAD,
      message: MESSAGE,
      link: LINK,
      businessTimezone: null
    });
    expect(out).toMatchObject({ ok: true, handoff: true });
    expect(mockSend.mock.calls[0][2].bodyText).not.toContain(NEEDS_HUMAN_SENTINEL);
    expect(mockSend.mock.calls[0][2].bodyText).toContain("bringing in a colleague");
  });

  it("escalates a sentinel-only draw without mailing an empty body", async () => {
    // Nothing to send, but the signal must still reach a person: dropping it
    // would claim the message, send nothing, and leave the thread live.
    mockTurn.mockResolvedValue({ ok: true, content: NEEDS_HUMAN_SENTINEL } as never);
    expect(
      await runEmailCoworkerTurn({
        thread: THREAD,
        message: MESSAGE,
        link: LINK,
        businessTimezone: null
      })
    ).toEqual({ ok: true, reply: "", handoff: true, sent: false });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("still reports a genuinely empty draw as a failure", async () => {
    mockTurn.mockResolvedValue({ ok: true, content: "   " } as never);
    expect(
      await runEmailCoworkerTurn({
        thread: THREAD,
        message: MESSAGE,
        link: LINK,
        businessTimezone: null
      })
    ).toEqual({ ok: false, detail: "empty_reply" });
  });

  it("passes an explicit clock through to the date line", async () => {
    await runEmailCoworkerTurn({
      thread: THREAD,
      message: MESSAGE,
      link: LINK,
      businessTimezone: "America/Phoenix",
      now: new Date("2026-07-25T16:00:00.000Z")
    });
    expect(String(mockTurn.mock.calls[0][0].systemInstruction)).toMatch(/July 25, 2026/);
  });
});

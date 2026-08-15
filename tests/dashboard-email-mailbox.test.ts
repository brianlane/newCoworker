import { describe, expect, it } from "vitest";
import {
  AI_MAILBOX_KEY,
  AI_MAILBOX_SOURCES,
  CONNECTED_MAILBOX_SOURCES,
  mailboxOptionsFromSendFrom,
  mailboxSources,
  parseMailboxFilter,
  rowMatchesMailbox,
  type MailboxRow
} from "@/lib/dashboard/email-mailbox";
import type { EmailLogSource } from "@/lib/db/email-log";

const SEND_FROM = [
  { id: "", label: "AI coworker: amy@newcoworker.com", email: "amy@newcoworker.com" },
  { id: "conn-1", label: "Gmail: amy@amylaidlaw.com", email: "amy@amylaidlaw.com" }
];

function row(over: Partial<MailboxRow> = {}): MailboxRow {
  return {
    direction: "inbound",
    source: "tenant_mailbox_inbound",
    from_email: "lead@example.com",
    to_email: "amy@newcoworker.com",
    ...over
  };
}

describe("email-mailbox", () => {
  it("covers every email_log source exactly once", () => {
    const all = [...AI_MAILBOX_SOURCES, ...CONNECTED_MAILBOX_SOURCES];
    expect(new Set(all).size).toBe(all.length);
    // The union in email-log.ts is the contract; a new source must be placed
    // on one side or the mailbox chips silently drop its rows.
    const known: EmailLogSource[] = [
      "ai_flow",
      "owner_mailbox",
      "email_trigger",
      "dashboard_chat",
      "sms_assistant",
      "voice_assistant",
      "slack_assistant",
      "tenant_mailbox_inbound",
      "tenant_mailbox_outbound",
      "owner_manual",
      "email_coworker",
      "booking_reminder"
    ];
    expect([...all].sort()).toEqual([...known].sort());
  });

  it("builds no chips when nothing is connected", () => {
    expect(mailboxOptionsFromSendFrom([SEND_FROM[0]])).toEqual([]);
    expect(mailboxOptionsFromSendFrom([])).toEqual([]);
  });

  it("builds AI + connected chips, labelled by address", () => {
    expect(mailboxOptionsFromSendFrom(SEND_FROM)).toEqual([
      { id: AI_MAILBOX_KEY, label: "AI Mailbox", email: "amy@newcoworker.com" },
      { id: "conn-1", label: "amy@amylaidlaw.com", email: "amy@amylaidlaw.com" }
    ]);
  });

  it("falls back to the provider label when a connection has no address", () => {
    expect(
      mailboxOptionsFromSendFrom([
        { id: "", label: "AI coworker", email: null },
        { id: "conn-2", label: "Outlook", email: null }
      ])
    ).toEqual([
      { id: AI_MAILBOX_KEY, label: "AI Mailbox", email: null },
      { id: "conn-2", label: "Outlook", email: null }
    ]);
  });

  it("parses only chips that exist", () => {
    const options = mailboxOptionsFromSendFrom(SEND_FROM);
    expect(parseMailboxFilter("conn-1", options)).toBe("conn-1");
    expect(parseMailboxFilter(" ai ", options)).toBe(AI_MAILBOX_KEY);
    expect(parseMailboxFilter("conn-9", options)).toBe("");
    expect(parseMailboxFilter(undefined, options)).toBe("");
    expect(parseMailboxFilter("ai", [])).toBe("");
  });

  it("matches every row when no mailbox is selected", () => {
    expect(rowMatchesMailbox(row(), "", mailboxOptionsFromSendFrom(SEND_FROM))).toBe(true);
  });

  it("splits AI-mailbox rows from connected-mailbox rows by source", () => {
    const options = mailboxOptionsFromSendFrom(SEND_FROM);
    for (const source of AI_MAILBOX_SOURCES) {
      expect(rowMatchesMailbox(row({ source }), AI_MAILBOX_KEY, options)).toBe(true);
      expect(rowMatchesMailbox(row({ source }), "conn-1", options)).toBe(false);
    }
    for (const source of CONNECTED_MAILBOX_SOURCES) {
      expect(rowMatchesMailbox(row({ source }), AI_MAILBOX_KEY, options)).toBe(false);
    }
  });

  it("picks the connected mailbox an inbound row was addressed to", () => {
    const options = mailboxOptionsFromSendFrom([
      ...SEND_FROM,
      { id: "conn-2", label: "Outlook: brian@amylaidlaw.com", email: "brian@amylaidlaw.com" }
    ]);
    const inbound = row({
      source: "email_trigger",
      to_email: "Team <team@x.com>, Amy <amy@amylaidlaw.com>"
    });
    expect(rowMatchesMailbox(inbound, "conn-1", options)).toBe(true);
    expect(rowMatchesMailbox(inbound, "conn-2", options)).toBe(false);
  });

  it("picks the connected mailbox an outbound row was sent from", () => {
    const options = mailboxOptionsFromSendFrom([
      ...SEND_FROM,
      { id: "conn-2", label: "Outlook: brian@amylaidlaw.com", email: "brian@amylaidlaw.com" }
    ]);
    const sent = row({
      direction: "outbound",
      source: "owner_manual",
      from_email: "Amy <AMY@amylaidlaw.com>",
      to_email: "lead@example.com"
    });
    expect(rowMatchesMailbox(sent, "conn-1", options)).toBe(true);
    expect(rowMatchesMailbox(sent, "conn-2", options)).toBe(false);
  });

  it("keeps an unreadable address on the sole connected mailbox", () => {
    const options = mailboxOptionsFromSendFrom(SEND_FROM);
    // Legacy row with no sender recorded: there is only one mailbox it could
    // have used, so hiding it behind the filter would lose real mail.
    const legacy = row({ direction: "outbound", source: "dashboard_chat", from_email: null });
    expect(rowMatchesMailbox(legacy, "conn-1", options)).toBe(true);
  });

  it("does not guess between two connected mailboxes", () => {
    const options = mailboxOptionsFromSendFrom([
      ...SEND_FROM,
      { id: "conn-2", label: "Outlook: brian@amylaidlaw.com", email: "brian@amylaidlaw.com" }
    ]);
    const legacy = row({ direction: "outbound", source: "dashboard_chat", from_email: null });
    expect(rowMatchesMailbox(legacy, "conn-1", options)).toBe(false);
    expect(rowMatchesMailbox(legacy, "conn-2", options)).toBe(false);
  });

  it("does not steal a row that belongs to the other mailbox", () => {
    const options = mailboxOptionsFromSendFrom(SEND_FROM);
    const other = row({
      direction: "outbound",
      source: "owner_manual",
      from_email: "amy@amylaidlaw.com"
    });
    // Sole-connected fallback must not fire when the address DID resolve.
    expect(rowMatchesMailbox(other, "conn-1", options)).toBe(true);
  });

  it("returns false for a mailbox that is not on the list", () => {
    // A disconnected mailbox still named by the URL: show nothing rather than
    // fall through to "some other mailbox's row".
    expect(
      rowMatchesMailbox(
        row({ source: "email_trigger" }),
        "gone",
        mailboxOptionsFromSendFrom(SEND_FROM)
      )
    ).toBe(false);
  });

  it("maps each chip onto the sources worth fetching", () => {
    expect(mailboxSources("")).toBeNull();
    expect(mailboxSources(AI_MAILBOX_KEY)).toEqual(AI_MAILBOX_SOURCES);
    expect(mailboxSources("conn-1")).toEqual(CONNECTED_MAILBOX_SOURCES);
  });
});

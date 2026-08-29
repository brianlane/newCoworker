import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Telegram inbound: who is allowed to talk to the coworker at all.
 *
 * This is the security surface of the channel. Telegram tells us NOTHING
 * about a sender that the sender did not choose: `from.id` is an opaque
 * integer and `@username` is self-chosen and re-assignable. Anyone can find
 * a bot and message it. So the rule these tests exist to pin is that an
 * account the business has not connected gets no turn, and the only two
 * ways to become connected both prove something:
 *
 *   1. sharing the phone number Telegram verified at signup, which must be
 *      the sharer's OWN card, and which must then match the owner numbers
 *      or an ACTIVE roster row
 *   2. redeeming a single-use code minted by a dashboard session that
 *      already held manage_settings
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  handleTelegramMessage,
  type TelegramInboundDeps,
  type TelegramUpdate
} from "@/lib/telegram/inbound";
import type { CoworkerConnectionRow } from "@/lib/db/coworker-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";

const CONNECTION = {
  id: "conn-1",
  business_id: BIZ,
  channel: "telegram",
  external_workspace_id: "999",
  external_workspace_name: "@acme_bot",
  alert_target_id: null,
  alert_target_name: null,
  is_active: true,
  created_at: "",
  updated_at: "",
  credential: "123:AA",
  webhookSecret: "shh"
} as CoworkerConnectionRow;

function update(overrides: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: 5,
    message: {
      message_id: 11,
      from: { id: 4242, first_name: "Dana", last_name: "Ruiz" },
      chat: { id: 4242, type: "private" },
      text: "how many leads today?",
      ...overrides
    }
  };
}

function deps(overrides: TelegramInboundDeps = {}): TelegramInboundDeps {
  return {
    send: vi.fn(async () => ({ messageId: "1", chatId: "4242" })),
    findIdentity: vi.fn(async () => null),
    redeem: vi.fn(async () => ({ ok: false as const, reason: "unknown" as const })),
    upsertIdentity: vi.fn(async () => ({}) as never),
    resolveSpeaker: vi.fn(async () => ({
      kind: "customer" as const,
      name: null,
      readFailed: false
    })),
    getConversation: vi.fn(async () => ({
      id: "conv-1",
      user_display_name: null,
      user_email: null
    }) as never),
    insertMessage: vi.fn(async () => ({ messageId: 9, jobId: "job-1" })),
    listMessages: vi.fn(async () => [{ id: 1 }] as never),
    markHello: vi.fn(async () => true),
    updateIdentity: vi.fn(async () => undefined),
    locale: vi.fn(async () => "en" as const),
    ...overrides
  };
}

const LINKED = {
  id: "ident-1",
  business_id: BIZ,
  channel: "telegram" as const,
  external_user_id: "4242",
  employee_id: null,
  is_owner: true,
  verified_phone_e164: "+15145188192",
  verified_email: null,
  linked_via: "shared_contact" as const
};

beforeEach(() => vi.clearAllMocks());

describe("an unconnected account gets no turn", () => {
  it("explains how to connect and enqueues nothing", async () => {
    const d = deps();
    const out = await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(out).toEqual({ enqueued: false, reason: "not_linked" });
    expect(d.insertMessage).not.toHaveBeenCalled();
  });

  it("offers the share-contact button as the easy path", async () => {
    const d = deps();
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    const [, args] = vi.mocked(d.send!).mock.calls[0];
    expect(args.requestContact).toBeTruthy();
  });

  it("says nothing about which business the bot belongs to", async () => {
    // Whoever this is found a bot they were not given. Naming the business
    // would tell a stranger something they did not already know.
    const d = deps();
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    const [, args] = vi.mocked(d.send!).mock.calls[0];
    expect(args.text).not.toContain(BIZ);
    expect(args.text.toLowerCase()).not.toContain("acme");
  });

  it("ignores other bots, so two integrations cannot talk forever", async () => {
    const d = deps();
    const out = await handleTelegramMessage(
      {
        connection: CONNECTION,
        update: update({ from: { id: 1, is_bot: true, first_name: "Other" } })
      },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "bot_sender" });
    expect(d.send).not.toHaveBeenCalled();
  });

  it.each([
    ["an update with no message", { update_id: 1 } as TelegramUpdate, "unsupported_update"],
    [
      "a message with no sender",
      { update_id: 1, message: { message_id: 2, chat: { id: 3 } } } as TelegramUpdate,
      "no_sender"
    ]
  ])("drops %s", async (_label, u, reason) => {
    expect(await handleTelegramMessage({ connection: CONNECTION, update: u }, deps())).toEqual({
      enqueued: false,
      reason
    });
  });

  it("ignores an empty message rather than queueing a blank turn", async () => {
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: update({ text: "   " }) },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason: "no_text" });
  });
});

describe("enrolling by sharing a contact card", () => {
  const contactUpdate = (contact: Record<string, unknown>) =>
    update({ text: undefined, contact });

  it("refuses a card that is not the sharer's own", async () => {
    // THE trap on this channel. Telegram sets contact.user_id only when the
    // card belongs to the sharer, so without this check anyone could
    // forward a colleague's contact card and inherit that colleague's
    // powers. Same class of bug as trusting a self-asserted phone number in
    // a Messenger DM.
    const d = deps();
    const out = await handleTelegramMessage(
      {
        connection: CONNECTION,
        update: contactUpdate({ phone_number: "+15145188192", user_id: 9999 })
      },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "contact_not_own" });
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });

  it("refuses a contact card carrying no user id at all", async () => {
    const d = deps();
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: contactUpdate({ phone_number: "+15145188192" }) },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "contact_not_own" });
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });

  it("refuses a verified number that belongs to nobody we know", async () => {
    // Verified is not the same as ours. A real Telegram user with a real
    // number is still a stranger unless the number is the owner's or an
    // ACTIVE roster row, which resolveSurfaceSpeaker decides, fail-closed.
    const d = deps();
    const out = await handleTelegramMessage(
      {
        connection: CONNECTION,
        update: contactUpdate({ phone_number: "+15145188192", user_id: 4242 })
      },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "contact_not_staff" });
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });

  it("binds the owner and records what was actually proven", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({ kind: "owner" as const, name: "Amy", readFailed: false }))
    });
    const out = await handleTelegramMessage(
      {
        connection: CONNECTION,
        update: contactUpdate({ phone_number: "+1 (514) 518-8192", user_id: 4242 })
      },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "linked_by_contact" });
    expect(d.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        channel: "telegram",
        externalUserId: "4242",
        isOwner: true,
        // The PHONE is recorded and the roster row deliberately is not, so
        // the roster is consulted fresh on every turn and a roster edit
        // takes effect immediately.
        employeeId: null,
        verifiedPhoneE164: "+15145188192",
        linkedVia: "shared_contact"
      })
    );
  });

  it("binds a teammate as a teammate, not as the owner", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "teammate" as const,
        name: "Dana",
        readFailed: false
      }))
    });
    await handleTelegramMessage(
      {
        connection: CONNECTION,
        update: contactUpdate({ phone_number: "+15145188192", user_id: 4242 })
      },
      d
    );
    expect(d.upsertIdentity).toHaveBeenCalledWith(expect.objectContaining({ isOwner: false }));
  });

  it("ignores a contact card with an unusable number", async () => {
    const d = deps();
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: contactUpdate({ phone_number: "12", user_id: 4242 }) },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "contact_unusable" });
  });
});

describe("enrolling with a code", () => {
  it("binds the account when the code redeems", async () => {
    const d = deps({
      redeem: vi.fn(async () => ({ ok: true as const, identity: LINKED }))
    });
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: update({ text: "ABCD2345" }) },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "linked_by_code" });
    expect(d.redeem).toHaveBeenCalledWith({
      channel: "telegram",
      code: "ABCD2345",
      externalUserId: "4242"
    });
  });

  it("reports a rejected code without saying which way it was wrong", async () => {
    const d = deps({
      redeem: vi.fn(async () => ({ ok: false as const, reason: "expired" as const }))
    });
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: update({ text: "ABCD2345" }) },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "link_expired" });
    const [, args] = vi.mocked(d.send!).mock.calls[0];
    expect(args.text).toContain("not valid");
  });

  it("does NOT treat an eight-character question from a LINKED person as a code", async () => {
    // A connected teammate typing eight characters is asking their coworker
    // something. Redeeming it would swallow the message.
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: update({ text: "bookings" }) },
      d
    );
    expect(d.redeem).not.toHaveBeenCalled();
    expect(out).toEqual({ enqueued: true });
  });

  it.each([
    ["abcd2345", true],
    [" ABCD-2345 ", true],
    // Stripping hyphens and spaces is deliberate: codes get displayed
    // grouped and read off one screen onto another, sometimes from a
    // photograph.
    ["ABCD 2345", true],
    ["what are my bookings", false],
    ["hi", false]
  ])("treats %s as a code: %s", async (text, isCode) => {
    const d = deps();
    await handleTelegramMessage({ connection: CONNECTION, update: update({ text }) }, d);
    expect(Boolean(vi.mocked(d.redeem!).mock.calls.length)).toBe(isCode);
  });
});

describe("a connected account gets a turn", () => {
  it("stores the message and reports it enqueued", async () => {
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    const out = await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(out).toEqual({ enqueued: true });
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        businessId: BIZ,
        channel: "telegram",
        content: "how many leads today?",
        // Telegram redelivers an update it did not get a 200 for, and
        // update_id is stable across those retries. This is the dedupe.
        externalEventId: "u:5",
        externalTs: "11"
      })
    );
  });

  it("acks a redelivery instead of answering twice", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => LINKED),
      insertMessage: vi.fn(async () => null)
    });
    const out = await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(out).toEqual({ enqueued: false, reason: "duplicate_delivery" });
  });

  it("keys the conversation on the chat, with no thread anchor", async () => {
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(d.getConversation).toHaveBeenCalledWith({
      businessId: BIZ,
      channel: "telegram",
      externalWorkspaceId: "999",
      externalConversationId: "4242",
      // A Telegram DM has no thread anchor: the chat IS the thread.
      threadKey: null,
      externalUserId: "4242"
    });
  });

  it("greets exactly once, claimed through the unique index", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => LINKED),
      listMessages: vi.fn(async () => [] as never)
    });
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(d.markHello).toHaveBeenCalled();
    expect(vi.mocked(d.send!).mock.calls[0][1].text).toContain("New Coworker");
  });

  it("stays quiet when another delivery already claimed the greeting", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => LINKED),
      listMessages: vi.fn(async () => [] as never),
      markHello: vi.fn(async () => false)
    });
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("refreshes a display name that changed, best effort", async () => {
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ displayName: "Dana Ruiz", isOwner: true })
    );
  });

  it("falls back to the @username when there is no real name", async () => {
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    await handleTelegramMessage(
      { connection: CONNECTION, update: update({ from: { id: 4242, username: "dana" } }) },
      d
    );
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ displayName: "@dana" })
    );
  });

  it("survives a failed name refresh: a label is not worth a lost message", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => LINKED),
      updateIdentity: vi.fn(async () => {
        throw new Error("write failed");
      })
    });
    expect(await handleTelegramMessage({ connection: CONNECTION, update: update() }, d)).toEqual({
      enqueued: true
    });
  });

  it("skips the refresh when the name has not changed", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => LINKED),
      getConversation: vi.fn(async () => ({
        id: "conv-1",
        user_display_name: "Dana Ruiz",
        user_email: null
      }) as never)
    });
    await handleTelegramMessage({ connection: CONNECTION, update: update() }, d);
    expect(d.updateIdentity).not.toHaveBeenCalled();
  });

  it("carries a missing update id as a null event id rather than inventing one", async () => {
    // No update_id means no dedupe key. Making one up would defeat the
    // unique index; a null simply opts that row out of deduping.
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    await handleTelegramMessage(
      { connection: CONNECTION, update: { message: update().message } },
      d
    );
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: null })
    );
  });
});

describe("failures that must not become webhook errors", () => {
  it("survives every reply send failing", async () => {
    // A throw here would turn a stored message into a 500, which makes
    // Telegram redeliver a message we already have.
    const send = vi.fn(async () => {
      throw new Error("bot was blocked by the user");
    });
    const cases: [string, TelegramUpdate, TelegramInboundDeps][] = [
      ["not linked", update(), deps({ send })],
      [
        "contact not own",
        update({ text: undefined, contact: { phone_number: "+15145188192", user_id: 1 } }),
        deps({ send })
      ],
      [
        "contact not staff",
        update({ text: undefined, contact: { phone_number: "+15145188192", user_id: 4242 } }),
        deps({ send })
      ],
      [
        "contact accepted",
        update({ text: undefined, contact: { phone_number: "+15145188192", user_id: 4242 } }),
        deps({
          send,
          resolveSpeaker: vi.fn(async () => ({
            kind: "owner" as const,
            name: "Amy",
            readFailed: false
          }))
        })
      ],
      ["code rejected", update({ text: "ABCD2345" }), deps({ send })],
      [
        "greeting",
        update(),
        deps({ send, findIdentity: vi.fn(async () => LINKED), listMessages: vi.fn(async () => [] as never) })
      ]
    ];
    for (const [label, u, d] of cases) {
      await expect(
        handleTelegramMessage({ connection: CONNECTION, update: u }, d),
        label
      ).resolves.toBeDefined();
    }
  });

  it("treats a message with neither text nor a contact as nothing to do", async () => {
    const out = await handleTelegramMessage(
      { connection: CONNECTION, update: update({ text: undefined }) },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason: "no_text" });
  });

  it("has no display name to record when Telegram sent neither name nor username", async () => {
    const d = deps({ findIdentity: vi.fn(async () => LINKED) });
    await handleTelegramMessage(
      { connection: CONNECTION, update: update({ from: { id: 4242 } }) },
      d
    );
    expect(d.updateIdentity).not.toHaveBeenCalled();
  });
});

describe("normalising a shared phone number", () => {
  const share = async (phone: string | undefined) => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "owner" as const,
        name: "Amy",
        readFailed: false
      }))
    });
    const out = await handleTelegramMessage(
      {
        connection: CONNECTION,
        update: update({ text: undefined, contact: { phone_number: phone, user_id: 4242 } })
      },
      d
    );
    return { out, d };
  };

  it.each([
    ["+1 (514) 518-8192", "+15145188192"],
    ["15145188192", "+15145188192"],
    ["+852 9123 4567", "+85291234567"]
  ])("normalises %s to %s before matching it against the roster", async (raw, expected) => {
    const { d } = await share(raw);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(BIZ, { phoneE164: expected });
    expect(d.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedPhoneE164: expected })
    );
  });

  it.each([
    ["123", "too short"],
    ["", "empty"],
    [undefined, "absent"],
    ["1".repeat(16), "too long"]
  ])("refuses %s (%s) rather than matching a mangled number", async (raw, _why) => {
    const { out, d } = await share(raw as string | undefined);
    expect(out).toEqual({ enqueued: false, reason: "contact_unusable" });
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });
});

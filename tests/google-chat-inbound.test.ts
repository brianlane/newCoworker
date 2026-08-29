import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Google Chat inbound.
 *
 * Two things here are unlike every other channel, and both are pinned below.
 *
 * A CODE BINDS THE SPACE. There is no value the owner can paste to connect,
 * because a Chat space name is opaque and shown nowhere in the Chat UI, so
 * the connection is created from INSIDE the space when a code is redeemed.
 * That makes "no connection" a normal state to be handled rather than an
 * error to refuse, which is the opposite of Slack and Teams.
 *
 * THE REPLY IS THE RETURN VALUE. Chat posts whatever the webhook responds
 * with, so the immediate answers come back as `reply` rather than through
 * the API. A stranger in an unbound space therefore gets an answer without
 * our service-account credential being involved at all.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  handleGoogleChatEvent,
  type GoogleChatEvent,
  type GoogleChatInboundDeps
} from "@/lib/google-chat/inbound";
import type { CoworkerConnectionRow } from "@/lib/db/coworker-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";
const SPACE = "spaces/AAQA1234";
const THREAD = `${SPACE}/threads/T1`;
const USER = "users/108765";

const CONNECTION = {
  id: "conn-1",
  business_id: BIZ,
  channel: "google_chat",
  external_workspace_id: SPACE,
  external_workspace_name: "Acme Ops",
  is_active: true,
  credential: ""
} as unknown as CoworkerConnectionRow;

function event(overrides: Partial<GoogleChatEvent> = {}): GoogleChatEvent {
  return {
    type: "MESSAGE",
    space: { name: SPACE, type: "ROOM", displayName: "Acme Ops" },
    message: {
      name: `${SPACE}/messages/m1`,
      text: "@New Coworker how many leads today?",
      argumentText: "how many leads today?",
      thread: { name: THREAD },
      space: { name: SPACE },
      sender: {
        name: USER,
        displayName: "Dana Ruiz",
        email: "dana@acme.com",
        type: "HUMAN"
      }
    },
    ...overrides
  };
}

function deps(overrides: GoogleChatInboundDeps = {}): GoogleChatInboundDeps {
  return {
    findIdentity: vi.fn(async () => null),
    upsertIdentity: vi.fn(async () => ({ id: "ident-1" }) as never),
    redeem: vi.fn(async () => ({ ok: false as const, reason: "unknown" as const })),
    getConnection: vi.fn(async () => null),
    upsertConnection: vi.fn(async () => ({ id: "conn-1" }) as never),
    // Behaves like the real resolver rather than answering "teammate" to
    // anything: it places somebody by the ADDRESS it is handed, and knows
    // nobody without one. A fixture that said yes regardless would make
    // every assertion about which address we looked the speaker up by
    // vacuous.
    resolveSpeaker: vi.fn(async (_biz: string, identity: { email?: string | null }) =>
      identity.email === "dana@acme.com"
        ? { kind: "teammate" as const, name: "Dana Ruiz", readFailed: false }
        : { kind: "customer" as const, name: null, readFailed: false }
    ),
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

const run = (e: GoogleChatEvent, d: GoogleChatInboundDeps, connection = CONNECTION) =>
  handleGoogleChatEvent({ connection, event: e }, d);

beforeEach(() => vi.clearAllMocks());

describe("a space nobody has connected", () => {
  it("says how to connect, and names no business", async () => {
    // We do not know of one at this point, and could not name it safely if
    // we did: our Chat app can be added to any space in any Workspace that
    // can find it, so this is the reply to a complete stranger.
    const d = deps();
    const out = await handleGoogleChatEvent({ connection: null, event: event() }, d);
    expect(out.enqueued).toBe(false);
    expect(out.reason).toBe("unbound_space");
    expect(out.reply).toContain("connect code");
    expect(out.reply).not.toContain(BIZ);
    expect(d.insertMessage).not.toHaveBeenCalled();
  });

  it("binds the space to the business behind a redeemed code", async () => {
    // The whole connect flow. Redeeming says which business, which binds
    // the space, and says who sent it, which binds them.
    const d = deps({
      redeem: vi.fn(async () => ({
        ok: true as const,
        identity: { business_id: BIZ } as never
      }))
    });
    const out = await handleGoogleChatEvent(
      {
        connection: null,
        event: event({
          message: { ...event().message, text: "ABCD2345", argumentText: "ABCD2345" }
        })
      },
      d
    );
    expect(out.reason).toBe("linked_by_code");
    expect(d.upsertConnection).toHaveBeenCalledWith({
      businessId: BIZ,
      channel: "google_chat",
      externalWorkspaceId: SPACE,
      externalWorkspaceName: "Acme Ops",
      credential: ""
    });
    expect(out.reply).toContain("New Coworker");
  });

  it("REFUSES to move a business already bound to a different space", async () => {
    // Alerts go to the bound space. Moving it from inside a chat message
    // would send them somewhere the owner never chose and never sees, with
    // nothing in the dashboard to say what happened.
    const d = deps({
      redeem: vi.fn(async () => ({
        ok: true as const,
        identity: { business_id: BIZ } as never
      })),
      getConnection: vi.fn(async () => ({
        ...CONNECTION,
        external_workspace_id: "spaces/SOMEWHEREELSE"
      }))
    });
    const out = await handleGoogleChatEvent(
      {
        connection: null,
        event: event({
          message: { ...event().message, text: "ABCD2345", argumentText: "ABCD2345" }
        })
      },
      d
    );
    expect(out.reason).toBe("already_bound_elsewhere");
    expect(d.upsertConnection).not.toHaveBeenCalled();
    expect(out.reply).toContain("disconnect");
  });

  it("records a null space name rather than an empty one", async () => {
    // `external_workspace_name` is shown to the owner in the dashboard, so
    // a blank display name has to become null and let the card say
    // "your connected space" instead of rendering nothing at all.
    const d = deps({
      redeem: vi.fn(async () => ({
        ok: true as const,
        identity: { business_id: BIZ } as never
      }))
    });
    await handleGoogleChatEvent(
      {
        connection: null,
        event: event({
          space: { name: SPACE, displayName: "   " },
          message: { ...event().message, text: "ABCD2345", argumentText: "ABCD2345" }
        })
      },
      d
    );
    expect(d.upsertConnection).toHaveBeenCalledWith(
      expect.objectContaining({ externalWorkspaceName: null })
    );
  });

  it("re-binds the SAME space without complaint", async () => {
    // A second code in a space that is already this business's own is a
    // teammate enrolling, not a move. Refusing it would be a dead end.
    const d = deps({
      redeem: vi.fn(async () => ({
        ok: true as const,
        identity: { business_id: BIZ } as never
      })),
      getConnection: vi.fn(async () => CONNECTION)
    });
    const out = await handleGoogleChatEvent(
      {
        connection: null,
        event: event({
          message: { ...event().message, text: "ABCD2345", argumentText: "ABCD2345" }
        })
      },
      d
    );
    expect(out.reason).toBe("linked_by_code");
    expect(d.upsertConnection).toHaveBeenCalled();
  });

  it("binds anyway when the existing-connection read fails", async () => {
    // Fails toward completing setup. The alternative strands an owner who
    // is doing exactly the right thing behind a transient read error.
    const d = deps({
      redeem: vi.fn(async () => ({
        ok: true as const,
        identity: { business_id: BIZ } as never
      })),
      getConnection: vi.fn(async () => {
        throw new Error("down");
      })
    });
    const out = await handleGoogleChatEvent(
      {
        connection: null,
        event: event({
          message: { ...event().message, text: "ABCD2345", argumentText: "ABCD2345" }
        })
      },
      d
    );
    expect(out.reason).toBe("linked_by_code");
    expect(d.upsertConnection).toHaveBeenCalled();
  });

  it("tells a rejected code apart from a stranger saying anything else", async () => {
    const d = deps({ redeem: vi.fn(async () => ({ ok: false as const, reason: "expired" as const })) });
    const out = await handleGoogleChatEvent(
      {
        connection: null,
        event: event({
          message: { ...event().message, text: "ABCD2345", argumentText: "ABCD2345" }
        })
      },
      d
    );
    expect(out.reason).toBe("link_expired");
    expect(out.reply).toContain("valid");
  });

  it("greets a stranger's space on being added, without pretending to be set up", async () => {
    const out = await handleGoogleChatEvent(
      { connection: null, event: event({ type: "ADDED_TO_SPACE" }) },
      deps()
    );
    expect(out.reason).toBe("added_to_space");
    expect(out.reply).toContain("connect code");
  });

  it("greets a CONNECTED space on being added", async () => {
    const out = await run(event({ type: "ADDED_TO_SPACE" }), deps());
    expect(out.reason).toBe("added_to_space");
    expect(out.reply).toContain("New Coworker");
  });
});

describe("who is speaking", () => {
  it("resolves the speaker by the address on the event", async () => {
    // EASIER THAN TEAMS, where the address has to be fetched from the Bot
    // Connector: a Chat event carries `sender.email` for a human in the
    // app's own Workspace.
    const d = deps();
    await run(event(), d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(BIZ, {
      email: "dana@acme.com",
      externalRef: { channel: "google_chat", externalUserId: USER }
    });
  });

  it("case-folds the address, because it is matched against roster rows", async () => {
    const d = deps();
    const e = event();
    await run({ ...e, message: { ...e.message, sender: { ...e.message!.sender, email: "Dana@Acme.com" } } }, d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: "dana@acme.com" })
    );
  });

  it("falls back to the recorded binding when the Workspace exposes no address", async () => {
    // A Workspace can be configured so apps never see one, and an external
    // guest has none. The binding is what keeps those people working.
    const d = deps({
      findIdentity: vi.fn(async () => ({ id: "i", verified_email: "dana@acme.com" }) as never)
    });
    const e = event();
    await run({ ...e, message: { ...e.message, sender: { name: USER, type: "HUMAN" } } }, d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: "dana@acme.com" })
    );
  });

  it("prefers the LIVE address over a stale recorded one, and heals the binding", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => ({ id: "i", verified_email: "dana.old@acme.com" }) as never)
    });
    await run(event(), d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: "dana@acme.com" })
    );
    expect(d.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ verifiedEmail: "dana@acme.com", linkedVia: "directory" })
    );
  });

  it("does not rewrite a binding that already says the right thing", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => ({ id: "i", verified_email: "dana@acme.com" }) as never)
    });
    await run(event(), d);
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });

  it("records an owner as an owner", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async (_b: string, i: { email?: string | null }) =>
        i.email === "dana@acme.com"
          ? { kind: "owner" as const, name: "Dana", readFailed: false }
          : { kind: "customer" as const, name: null, readFailed: false }
      )
    });
    await run(event(), d);
    expect(d.upsertIdentity).toHaveBeenCalledWith(expect.objectContaining({ isOwner: true }));
  });

  it("records nothing for someone the roster does not place", async () => {
    // Otherwise the first stranger in a connected space gets a row
    // asserting a binding, and resolveSurfaceSpeaker is later handed an
    // externalRef that says somebody vouched for them.
    const d = deps();
    const e = event();
    await run(
      { ...e, message: { ...e.message, sender: { ...e.message!.sender, email: "nobody@else.com" } } },
      d
    );
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });

  it("answers the message even when the binding write fails", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => ({ id: "i", verified_email: "old@acme.com" }) as never),
      upsertIdentity: vi.fn(async () => {
        throw new Error("write down");
      })
    });
    expect(await run(event(), d)).toMatchObject({ enqueued: true });
  });

  it("gives an unplaceable account nothing but how to get connected", async () => {
    const d = deps();
    const e = event();
    const out = await run(
      { ...e, message: { ...e.message, sender: { name: USER, type: "HUMAN" } } },
      d
    );
    expect(out).toMatchObject({ enqueued: false, reason: "not_linked" });
    expect(out.reply).toContain("connect");
    expect(d.insertMessage).not.toHaveBeenCalled();
  });

  it("lets an unplaceable account in a connected space redeem a code", async () => {
    const d = deps({
      redeem: vi.fn(async () => ({ ok: true as const, identity: {} as never }))
    });
    const e = event();
    const out = await run(
      {
        ...e,
        message: {
          ...e.message,
          text: "ABCD2345",
          argumentText: "ABCD2345",
          sender: { name: USER, type: "HUMAN" }
        }
      },
      d
    );
    expect(out.reason).toBe("linked_by_code");
  });

  it("reports a rejected code in a connected space distinctly", async () => {
    const d = deps({
      redeem: vi.fn(async () => ({ ok: false as const, reason: "expired" as const }))
    });
    const e = event();
    const out = await run(
      {
        ...e,
        message: {
          ...e.message,
          text: "ABCD2345",
          argumentText: "ABCD2345",
          sender: { name: USER, type: "HUMAN" }
        }
      },
      d
    );
    expect(out.reason).toBe("link_expired");
    expect(out.reply).toContain("valid");
  });

  it("never treats a PLACED teammate's eight-character message as a code", async () => {
    const d = deps();
    const e = event();
    const out = await run(
      { ...e, message: { ...e.message, text: "bookings", argumentText: "bookings" } },
      d
    );
    expect(d.redeem).not.toHaveBeenCalled();
    expect(out.enqueued).toBe(true);
  });
});

describe("queueing the turn", () => {
  it("keys the conversation on the THREAD, not the space", async () => {
    // A Chat space holds many threads at once. Keying on the space would
    // splice two unrelated discussions into one history and feed the model
    // a conversation that never happened.
    const d = deps();
    await run(event(), d);
    expect(d.getConversation).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "google_chat",
        externalConversationId: SPACE,
        threadKey: THREAD,
        externalUserId: USER
      })
    );
  });

  it("treats a threadless message as its own conversation", async () => {
    const d = deps();
    const e = event();
    await run({ ...e, message: { ...e.message, thread: undefined } }, d);
    expect(d.getConversation).toHaveBeenCalledWith(
      expect.objectContaining({ threadKey: null })
    );
  });

  it("stores the message keyed on the message name, which is the dedupe", async () => {
    const d = deps();
    expect(await run(event(), d)).toMatchObject({ enqueued: true });
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "google_chat",
        externalEventId: `m:${SPACE}/messages/m1`
      })
    );
  });

  it("acks a redelivery instead of answering twice", async () => {
    const d = deps({ insertMessage: vi.fn(async () => null) });
    expect(await run(event(), d)).toEqual({ enqueued: false, reason: "duplicate_delivery" });
  });

  it("carries a missing message name as a null event id", async () => {
    const d = deps();
    const e = event();
    await run({ ...e, message: { ...e.message, name: undefined } }, d);
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: null })
    );
  });

  it("uses argumentText, so the app's own @mention is not part of the question", async () => {
    // Left in, the model answers the mention as though it were part of what
    // was asked.
    const d = deps();
    await run(event(), d);
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "how many leads today?" })
    );
  });

  it("falls back to text in a DM, where Chat sends no argumentText", async () => {
    const d = deps();
    const e = event();
    await run(
      { ...e, message: { ...e.message, argumentText: undefined, text: "how many leads?" } },
      d
    );
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "how many leads?" })
    );
  });

  it("greets once, claimed through the unique index", async () => {
    const d = deps({ listMessages: vi.fn(async () => [] as never) });
    const out = await run(event(), d);
    expect(d.markHello).toHaveBeenCalled();
    expect(out.reply).toContain("New Coworker");
    expect(out.enqueued).toBe(true);
  });

  it("stays quiet when another delivery already claimed the greeting", async () => {
    const d = deps({
      listMessages: vi.fn(async () => [] as never),
      markHello: vi.fn(async () => false)
    });
    const out = await run(event(), d);
    expect(out.reply).toBeUndefined();
  });

  it("writes the address onto the conversation, for liveness", async () => {
    const d = deps();
    await run(event(), d);
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ email: "dana@acme.com", displayName: "Dana Ruiz" })
    );
  });

  it("skips the identity write when nothing changed", async () => {
    const d = deps({
      getConversation: vi.fn(async () => ({
        id: "conv-1",
        user_display_name: "Dana Ruiz",
        user_email: "dana@acme.com"
      }) as never)
    });
    await run(event(), d);
    expect(d.updateIdentity).not.toHaveBeenCalled();
  });

  it("keeps a stored name when the event carries none", async () => {
    const d = deps({
      getConversation: vi.fn(async () => ({
        id: "conv-1",
        user_display_name: "Dana Ruiz",
        user_email: null
      }) as never)
    });
    const e = event();
    await run(
      { ...e, message: { ...e.message, sender: { name: USER, email: "dana@acme.com", type: "HUMAN" } } },
      d
    );
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ displayName: "Dana Ruiz", email: "dana@acme.com" })
    );
  });

  it("keeps the stored address for somebody placed by a CODE, not an address", async () => {
    const d = deps({
      findIdentity: vi.fn(async () => ({ id: "i", verified_email: null }) as never),
      resolveSpeaker: vi.fn(async () => ({
        kind: "teammate" as const,
        name: "Dana Ruiz",
        readFailed: false
      })),
      getConversation: vi.fn(async () => ({
        id: "conv-1",
        user_display_name: "Someone Else",
        user_email: "dana@acme.com"
      }) as never)
    });
    const e = event();
    await run({ ...e, message: { ...e.message, sender: { name: USER, type: "HUMAN" } } }, d);
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ email: "dana@acme.com" })
    );
  });

  it("survives a failed identity write", async () => {
    const d = deps({
      updateIdentity: vi.fn(async () => {
        throw new Error("down");
      })
    });
    expect(await run(event(), d)).toMatchObject({ enqueued: true });
  });
});

describe("events that are not questions", () => {
  it("never answers another app", async () => {
    // Chat is a place other apps live too, and a bot answering a bot is a
    // loop that runs until somebody notices the bill.
    const d = deps();
    const e = event();
    const out = await run(
      { ...e, message: { ...e.message, sender: { name: "users/bot", type: "BOT" } } },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "bot_sender" });
    expect(out.reply).toBeUndefined();
  });

  it.each([
    ["a card click", { type: "CARD_CLICKED" }, "unsupported_event"],
    ["being removed", { type: "REMOVED_FROM_SPACE" }, "unsupported_event"]
  ])("drops %s", async (_label, overrides, reason) => {
    expect(await run(event(overrides as Partial<GoogleChatEvent>), deps())).toEqual({
      enqueued: false,
      reason
    });
  });

  it.each([
    ["no sender", { name: `${SPACE}/messages/m1`, text: "hi" }, "no_sender"],
    [
      "no text",
      { name: `${SPACE}/messages/m1`, text: "   ", sender: { name: USER, type: "HUMAN" } },
      "no_text"
    ]
  ])("drops a message with %s", async (_label, message, reason) => {
    const out = await run(
      { ...event(), message: message as GoogleChatEvent["message"] },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason });
  });

  it.each([
    ["nothing at all", ""],
    ["a path traversal", "spaces/../../v1/spaces/theirs"],
    ["a whole URL", "https://evil.test/spaces/x"]
  ])("refuses an event whose space is %s", async (_label, name) => {
    // Checked here as well as in the client, and not redundantly: this
    // value is the TENANT KEY, so a shape we did not expect must not reach
    // a connection lookup either.
    const e = event();
    const out = await run(
      { ...e, space: { name }, message: { ...e.message, space: { name } } },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason: "no_space" });
  });

  it("refuses an event with no space ANYWHERE, rather than reading undefined", async () => {
    const e = event();
    const out = await run(
      { ...e, space: undefined, message: { ...e.message, space: undefined } },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason: "no_space" });
  });

  it("drops a message with neither argumentText nor text", async () => {
    const e = event();
    const out = await run(
      {
        ...e,
        message: {
          ...e.message,
          text: undefined,
          argumentText: undefined
        }
      },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason: "no_text" });
  });

  it("reads the space off the message when the event has none at the top", async () => {
    const d = deps();
    const e = event();
    await run({ ...e, space: undefined }, d);
    expect(d.getConversation).toHaveBeenCalledWith(
      expect.objectContaining({ externalConversationId: SPACE })
    );
  });
});

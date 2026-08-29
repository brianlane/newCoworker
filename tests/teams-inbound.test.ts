import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Teams inbound.
 *
 * Identity is easier here than on Telegram, and the tests say why: an
 * activity carries a directory address, so `resolveSurfaceSpeaker` answers
 * owner / teammate / customer the way it already does for Slack. What is
 * NOT easier is delivery, because Teams cannot start a conversation: the
 * first conversation the bot sees has to be captured or an alert has
 * nowhere to go, and that capture is pinned below.
 */

vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import {
  handleTeamsActivity,
  type TeamsActivity,
  type TeamsInboundDeps
} from "@/lib/teams/inbound";
import type { CoworkerConnectionRow } from "@/lib/db/coworker-connections";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TENANT = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

const CONNECTION = {
  id: "conn-1",
  business_id: BIZ,
  channel: "teams",
  external_workspace_id: TENANT,
  alert_target_id: null,
  alert_target_name: null,
  is_active: true,
  credential: "",
  webhookSecret: null
} as unknown as CoworkerConnectionRow;

function activity(overrides: Partial<TeamsActivity> = {}): TeamsActivity {
  return {
    type: "message",
    id: "act-1",
    text: "how many leads today?",
    serviceUrl: "https://smba.trafficmanager.net/amer/",
    conversation: { id: "19:abc@thread.tacv2" },
    from: { id: "29:xyz", name: "Dana Ruiz", aadObjectId: "obj-1" },
    channelData: { tenant: { id: TENANT } },
    entities: [{ type: "clientInfo", email: "dana@acme.com" }],
    ...overrides
  };
}

function deps(overrides: TeamsInboundDeps = {}): TeamsInboundDeps {
  return {
    send: vi.fn(async () => ({ activityId: "1" })),
    findIdentity: vi.fn(async () => null),
    redeem: vi.fn(async () => ({ ok: false as const, reason: "unknown" as const })),
    resolveSpeaker: vi.fn(async () => ({
      kind: "teammate" as const,
      name: "Dana Ruiz",
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
    setAlertTarget: vi.fn(async () => undefined),
    locale: vi.fn(async () => "en" as const),
    ...overrides
  };
}

beforeEach(() => vi.clearAllMocks());

describe("identity comes from the directory", () => {
  it("resolves the speaker by the address Teams supplies", async () => {
    const d = deps();
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(BIZ, {
      email: "dana@acme.com",
      // The Entra object id, not the channel account id: it survives renames
      // and address changes, which is what a binding must key on.
      externalRef: { channel: "teams", externalUserId: "obj-1" }
    });
  });

  it.each([
    ["an email entity", [{ type: "clientInfo", email: "dana@acme.com" }], "dana@acme.com"],
    // Teams does not put this in one fixed place: which one arrives depends
    // on the client and the tenant's settings. Both are directory-owned
    // rather than self-asserted, which is what makes either safe to match a
    // roster row on.
    [
      "a userPrincipalName, case-folded",
      [{ type: "clientInfo", userPrincipalName: "Dana@Acme.com" }],
      "dana@acme.com"
    ],
    ["no entities at all", [], null],
    ["an entity carrying neither", [{ type: "clientInfo" }], null]
  ])("reads the sender address from %s", async (_label, entities, expected) => {
    const d = deps();
    await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ entities: entities as never }) },
      d
    );
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: expected })
    );
  });

  it("falls back to the channel account id when there is no Entra object id", async () => {
    const d = deps();
    await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ from: { id: "29:xyz", name: "Dana" } }) },
      d
    );
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ externalRef: { channel: "teams", externalUserId: "29:xyz" } })
    );
  });

  it("gives an unplaceable account nothing but how to get connected", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "customer" as const,
        name: null,
        readFailed: false
      }))
    });
    const out = await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(out).toEqual({ enqueued: false, reason: "not_linked" });
    expect(d.insertMessage).not.toHaveBeenCalled();
    // Our Azure registration is multi-tenant, so an unbound tenant can
    // install the app. Naming the business would tell them something.
    const [, sent] = vi.mocked(d.send!).mock.calls[0];
    expect(sent.text).not.toContain(BIZ);
  });

  it("honours a connect code from an unplaceable, unbound account", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "customer" as const,
        name: null,
        readFailed: false
      })),
      redeem: vi.fn(async () => ({ ok: true as const, identity: {} as never }))
    });
    const out = await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ text: "ABCD2345" }) },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "linked_by_code" });
  });

  it("does not treat an eight-character message from a BOUND account as a code", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "customer" as const,
        name: null,
        readFailed: false
      })),
      findIdentity: vi.fn(async () => ({ id: "ident-1" }) as never)
    });
    await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ text: "bookings" }) },
      d
    );
    expect(d.redeem).not.toHaveBeenCalled();
  });
});

describe("capturing where a proactive alert can go", () => {
  it("records the FIRST conversation and its regional service url", async () => {
    // Teams has no "message this user" call: an alert can only continue a
    // conversation the bot has already seen. Without this capture the
    // channel is connected and undeliverable.
    const d = deps();
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.setAlertTarget).toHaveBeenCalledWith(BIZ, "teams", {
      id: "19:abc@thread.tacv2",
      name: "https://smba.trafficmanager.net/amer/"
    });
  });

  it("does not move a target the owner already has", async () => {
    const d = deps();
    await handleTeamsActivity(
      {
        connection: { ...CONNECTION, alert_target_id: "19:other@thread.tacv2" },
        activity: activity()
      },
      d
    );
    expect(d.setAlertTarget).not.toHaveBeenCalled();
  });

  it("survives a failed capture rather than dropping the message", async () => {
    const d = deps({
      setAlertTarget: vi.fn(async () => {
        throw new Error("write down");
      })
    });
    expect(
      await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d)
    ).toEqual({ enqueued: true });
  });
});

describe("queueing the turn", () => {
  it("stores the message keyed on the activity id, which is the dedupe", async () => {
    const d = deps();
    expect(await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d)).toEqual({
      enqueued: true
    });
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "teams", externalEventId: "a:act-1" })
    );
  });

  it("acks a redelivery instead of answering twice", async () => {
    const d = deps({ insertMessage: vi.fn(async () => null) });
    expect(await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d)).toEqual({
      enqueued: false,
      reason: "duplicate_delivery"
    });
  });

  it("strips the bot's own @mention out of a channel message", async () => {
    // Left in, the model answers the mention as part of the question.
    const d = deps();
    await handleTeamsActivity(
      {
        connection: CONNECTION,
        activity: activity({ text: "<at>New Coworker</at> how many leads?" })
      },
      d
    );
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ content: "how many leads?" })
    );
  });

  it("writes the directory address onto the conversation, for liveness", async () => {
    const d = deps();
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ email: "dana@acme.com", displayName: "Dana Ruiz" })
    );
  });

  it("greets once, claimed through the unique index", async () => {
    const d = deps({ listMessages: vi.fn(async () => [] as never) });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.markHello).toHaveBeenCalled();
    expect(vi.mocked(d.send!).mock.calls[0][1].text).toContain("New Coworker");
  });

  it("stays quiet when another delivery already claimed the greeting", async () => {
    const d = deps({
      listMessages: vi.fn(async () => [] as never),
      markHello: vi.fn(async () => false)
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.send).not.toHaveBeenCalled();
  });

  it("skips the identity write when nothing changed", async () => {
    const d = deps({
      getConversation: vi.fn(async () => ({
        id: "conv-1",
        user_display_name: "Dana Ruiz",
        user_email: "dana@acme.com"
      }) as never)
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.updateIdentity).not.toHaveBeenCalled();
  });

  it("survives a failed identity write", async () => {
    const d = deps({
      updateIdentity: vi.fn(async () => {
        throw new Error("down");
      })
    });
    expect(
      await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d)
    ).toEqual({ enqueued: true });
  });

  it("carries a missing activity id as a null event id", async () => {
    const d = deps();
    await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ id: undefined }) },
      d
    );
    expect(d.insertMessage).toHaveBeenCalledWith(
      expect.objectContaining({ externalEventId: null })
    );
  });
});

describe("failures that must not become webhook errors", () => {
  it("survives every reply send failing", async () => {
    // A throw here would turn a stored message into a 500, which makes Bot
    // Framework redeliver a message we already have.
    const send = vi.fn(async () => {
      throw new Error("forbidden");
    });
    const stranger = () => ({
      kind: "customer" as const,
      name: null,
      readFailed: false
    });
    const cases: [string, TeamsInboundDeps, TeamsActivity][] = [
      ["not linked", deps({ send, resolveSpeaker: vi.fn(async () => stranger()) }), activity()],
      [
        "code rejected",
        deps({ send, resolveSpeaker: vi.fn(async () => stranger()) }),
        activity({ text: "ABCD2345" })
      ],
      [
        "code accepted",
        deps({
          send,
          resolveSpeaker: vi.fn(async () => stranger()),
          redeem: vi.fn(async () => ({ ok: true as const, identity: {} as never }))
        }),
        activity({ text: "ABCD2345" })
      ],
      ["greeting", deps({ send, listMessages: vi.fn(async () => [] as never) }), activity()]
    ];
    for (const [label, d, act] of cases) {
      await expect(
        handleTeamsActivity({ connection: CONNECTION, activity: act }, d),
        label
      ).resolves.toBeDefined();
    }
  });

  it("tells a rejected code apart from a plain unrecognised account", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "customer" as const,
        name: null,
        readFailed: false
      })),
      redeem: vi.fn(async () => ({ ok: false as const, reason: "expired" as const }))
    });
    const out = await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ text: "ABCD2345" }) },
      d
    );
    expect(out).toEqual({ enqueued: false, reason: "link_expired" });
  });

  it("copes with an activity carrying no entities at all", async () => {
    const d = deps();
    await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ entities: undefined }) },
      d
    );
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: null })
    );
  });

  it("keeps a stored name when the activity carries none", async () => {
    const d = deps({
      getConversation: vi.fn(async () => ({
        id: "conv-1",
        user_display_name: "Dana Ruiz",
        user_email: null
      }) as never)
    });
    await handleTeamsActivity(
      {
        connection: CONNECTION,
        activity: activity({ from: { id: "29:xyz", aadObjectId: "obj-1" } })
      },
      d
    );
    expect(d.updateIdentity).toHaveBeenCalledWith(
      "conv-1",
      expect.objectContaining({ displayName: "Dana Ruiz", email: "dana@acme.com" })
    );
  });
});

describe("activities that are not questions", () => {
  it.each([
    ["a typing indicator", { type: "typing" }, "unsupported_activity"],
    ["a roster update", { type: "conversationUpdate" }, "unsupported_activity"],
    ["a message with no conversation", { conversation: undefined }, "incomplete_activity"],
    ["a message with no sender", { from: undefined }, "incomplete_activity"],
    ["a message with no service url", { serviceUrl: undefined }, "incomplete_activity"],
    ["an empty message", { text: "   " }, "no_text"],
    ["a message with no text field at all", { text: undefined }, "no_text"],
    ["a message that was only a mention", { text: "<at>New Coworker</at>" }, "no_text"]
  ])("drops %s", async (_label, overrides, reason) => {
    const out = await handleTeamsActivity(
      { connection: CONNECTION, activity: activity(overrides as Partial<TeamsActivity>) },
      deps()
    );
    expect(out).toEqual({ enqueued: false, reason });
  });
});

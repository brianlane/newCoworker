import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Teams inbound.
 *
 * Identity is easier here than on Telegram, and the tests say why: the
 * tenant's own directory answers who is speaking, so `resolveSurfaceSpeaker`
 * answers owner / teammate / customer the way it already does for Slack.
 *
 * The tests below pin WHERE that address comes from, because the obvious
 * answer is wrong and its failure is silent. It is not on the activity: it
 * is fetched from the Bot Connector's members endpoint. An implementation
 * that reads `activity.entities` or `activity.from` gets undefined every
 * time, raises nothing, and quietly treats every colleague as a stranger.
 *
 * What is NOT easier is delivery, because Teams cannot start a
 * conversation: the first conversation the bot sees has to be captured or
 * an alert has nowhere to go, and that capture is pinned below.
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
    ...overrides
  };
}

function deps(overrides: TeamsInboundDeps = {}): TeamsInboundDeps {
  return {
    send: vi.fn(async () => ({ activityId: "1" })),
    findIdentity: vi.fn(async () => null),
    fetchMember: vi.fn(async () => ({
      aadObjectId: "obj-1",
      email: "dana@acme.com",
      name: "Dana Ruiz"
    })),
    upsertIdentity: vi.fn(async () => ({ id: "ident-1" }) as never),
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
  it("resolves the speaker by the address the DIRECTORY returns", async () => {
    const d = deps();
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    // The lookup is made against the CHANNEL ACCOUNT id, which is what the
    // members endpoint keys on, while the binding and the speaker are keyed
    // on the Entra object id, which survives a rename or an address change.
    expect(d.fetchMember).toHaveBeenCalledWith(
      { serviceUrl: "https://smba.trafficmanager.net/amer/", conversationId: "19:abc@thread.tacv2" },
      "29:xyz"
    );
    expect(d.resolveSpeaker).toHaveBeenCalledWith(BIZ, {
      email: "dana@acme.com",
      externalRef: { channel: "teams", externalUserId: "obj-1" }
    });
  });

  it("does not go looking for the address on the activity", async () => {
    // The regression this pins. `from` and `entities` never carry it, so an
    // implementation that reads them resolves EVERY sender as a stranger,
    // with no error anywhere. Here the directory withholds the address and
    // the activity is stuffed with plausible-looking ones; the only correct
    // answer is null.
    const d = deps({ fetchMember: vi.fn(async () => null) });
    await handleTeamsActivity(
      {
        connection: CONNECTION,
        activity: {
          ...activity(),
          from: { id: "29:xyz", name: "Dana Ruiz", aadObjectId: "obj-1" },
          ...({
            entities: [{ type: "clientInfo", email: "dana@acme.com" }]
          } as object)
        } as TeamsActivity
      },
      d
    );
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: null })
    );
  });

  it.each([
    ["the directory answers with an address", { email: "dana@acme.com" }, "dana@acme.com"],
    ["the directory withholds it", { email: null }, null]
  ])("carries the address through when %s", async (_label, member, expected) => {
    const d = deps({
      fetchMember: vi.fn(async () => ({ aadObjectId: null, name: null, ...member }))
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: expected })
    );
  });

  it("costs a directory lookup ONCE, then reads the recorded binding", async () => {
    // A lookup per message would put a Microsoft round trip inside every
    // webhook ack window, and would hand a flaky directory the power to
    // tell somebody mid-conversation that we no longer know who they are.
    const d = deps({
      findIdentity: vi.fn(async () => ({
        id: "ident-1",
        verified_email: "dana@acme.com"
      }) as never)
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.fetchMember).not.toHaveBeenCalled();
    expect(d.upsertIdentity).not.toHaveBeenCalled();
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: "dana@acme.com" })
    );
  });

  it("records the binding as `directory`, not as an act by the person", async () => {
    // `linked_via` is an audit column about how somebody came to hold staff
    // powers. Filing a directory answer under `shared_contact` would
    // overstate the evidence behind the grant.
    const d = deps();
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.upsertIdentity).toHaveBeenCalledWith({
      businessId: BIZ,
      channel: "teams",
      externalUserId: "obj-1",
      employeeId: null,
      isOwner: false,
      verifiedEmail: "dana@acme.com",
      linkedVia: "directory"
    });
  });

  it("records nothing for someone the roster does not place", async () => {
    // Otherwise the first stranger to message the bot gets a row asserting
    // a binding, and `resolveSurfaceSpeaker` is handed an externalRef that
    // says somebody vouched for them.
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "customer" as const,
        name: null,
        readFailed: false
      }))
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.upsertIdentity).not.toHaveBeenCalled();
  });

  it("records an owner as an owner", async () => {
    const d = deps({
      resolveSpeaker: vi.fn(async () => ({
        kind: "owner" as const,
        name: "Dana",
        readFailed: false
      }))
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.upsertIdentity).toHaveBeenCalledWith(
      expect.objectContaining({ isOwner: true })
    );
  });

  it("answers the message even when the binding write fails", async () => {
    const d = deps({
      upsertIdentity: vi.fn(async () => {
        throw new Error("write down");
      })
    });
    expect(
      await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d)
    ).toEqual({ enqueued: true });
  });

  it("writes no binding when the directory withheld the address", async () => {
    const d = deps({ fetchMember: vi.fn(async () => null) });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.upsertIdentity).not.toHaveBeenCalled();
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
        connection: {
          ...CONNECTION,
          alert_target_id: "19:other@thread.tacv2",
          alert_target_name: "https://smba.trafficmanager.net/amer/"
        },
        activity: activity()
      },
      d
    );
    expect(d.setAlertTarget).not.toHaveBeenCalled();
  });

  it("follows the service url when Microsoft moves it, keeping the target", async () => {
    // Both replies and alerts POST to the STORED url. Microsoft varies it
    // by region and relocates tenants, so a pinned one keeps failing after
    // a move until somebody disconnects and starts over. The conversation
    // id is deliberately not re-claimed, so a later thread cannot quietly
    // move where alerts land.
    const d = deps();
    await handleTeamsActivity(
      {
        connection: {
          ...CONNECTION,
          alert_target_id: "19:other@thread.tacv2",
          alert_target_name: "https://smba.trafficmanager.net/emea/"
        },
        activity: activity()
      },
      d
    );
    expect(d.setAlertTarget).toHaveBeenCalledWith(BIZ, "teams", {
      id: "19:other@thread.tacv2",
      name: "https://smba.trafficmanager.net/amer/"
    });
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

  it("strips mentions in linear time on hostile text", async () => {
    // The character class is `[^<]*` rather than `.*?` on purpose. This
    // endpoint is public and the text is attacker-controlled, and `.*?`
    // backtracks quadratically on many unclosed `<at>`s: measured, 60k of
    // them takes under a millisecond with the right class and about five
    // seconds with `.*?`, so the threshold below has three orders of
    // magnitude of headroom and cannot flake on a slow CI box.
    const d = deps();
    const started = process.hrtime.bigint();
    await handleTeamsActivity(
      { connection: CONNECTION, activity: activity({ text: `${"<at>".repeat(60000)}x` }) },
      d
    );
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    expect(elapsedMs).toBeLessThan(1000);
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

  it("falls back to the recorded address when the directory is down", async () => {
    // teamsFetchMember returns null on any failure, so a Microsoft outage
    // and a tenant that hides addresses look identical from here. A bound
    // teammate must keep working through both.
    const d = deps({
      findIdentity: vi.fn(async () => ({
        id: "ident-1",
        verified_email: "dana@acme.com"
      }) as never),
      fetchMember: vi.fn(async () => null)
    });
    await handleTeamsActivity({ connection: CONNECTION, activity: activity() }, d);
    expect(d.resolveSpeaker).toHaveBeenCalledWith(
      BIZ,
      expect.objectContaining({ email: "dana@acme.com" })
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

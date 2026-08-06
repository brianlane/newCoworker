import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REACH_RING_SECONDS,
  MAX_REACH_RING_SECONDS,
  MIN_REACH_RING_SECONDS,
  clampReachRingSeconds,
  encodeReachClientState,
  nextReachDecision,
  parseReachClientState,
  type ReachTarget
} from "../supabase/functions/_shared/voice_reach";
import { parseOutboundClientState } from "../supabase/functions/_shared/voice_outbound";
import { telnyxBridgeCall } from "../supabase/functions/_shared/telnyx_call_actions";

const A_LEG = "v3:abc123";
const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

describe("reach client_state", () => {
  it("round-trips through the plain form", () => {
    const state = { businessId: BIZ, aLegCallControlId: "abc", attempt: 1 };
    expect(parseReachClientState(encodeReachClientState(state))).toEqual(state);
  });

  it("round-trips through base64, which is how Telnyx returns it", () => {
    const state = { businessId: BIZ, aLegCallControlId: "abc", attempt: 0 };
    const encoded = Buffer.from(encodeReachClientState(state)).toString("base64");
    expect(parseReachClientState(encoded)).toEqual(state);
  });

  // The four client_state prefixes in this codebase each have their own
  // parser, and every parser must reject the others. A reach B leg misread as
  // an outbound origination would attach an AI bridge to the TEAMMATE's phone.
  it("is mutually exclusive with the outbound origination state", () => {
    const reach = encodeReachClientState({
      businessId: BIZ,
      aLegCallControlId: "abc",
      attempt: 0
    });
    expect(parseOutboundClientState(reach)).toBeNull();
    expect(parseReachClientState(`vob:${BIZ}:session-1`)).toBeNull();
    expect(parseReachClientState(`hl:${BIZ}:abc:0`)).toBeNull();
    expect(parseReachClientState(`wt:${BIZ}:+15551234567:+15559876543`)).toBeNull();
  });

  it("rejects malformed states rather than guessing", () => {
    expect(parseReachClientState(null)).toBeNull();
    expect(parseReachClientState(undefined)).toBeNull();
    expect(parseReachClientState("")).toBeNull();
    expect(parseReachClientState("rt:")).toBeNull();
    expect(parseReachClientState(`rt:${BIZ}:abc`)).toBeNull();
    expect(parseReachClientState(`rt:${BIZ}::0`)).toBeNull();
    // A non-numeric or negative attempt would make a late webhook
    // unattributable to a rung, so it is refused rather than coerced.
    expect(parseReachClientState(`rt:${BIZ}:abc:x`)).toBeNull();
    expect(parseReachClientState(`rt:${BIZ}:abc:-1`)).toBeNull();
    // A digit run long enough to exceed MAX_SAFE_INTEGER satisfies the regex
    // but would make attempt attribution meaningless, so it is refused too.
    expect(parseReachClientState(`rt:${BIZ}:abc:99999999999999999999`)).toBeNull();
    expect(parseReachClientState("!!!not base64 and not rt")).toBeNull();
  });
});

describe("nextReachDecision", () => {
  const dave: ReachTarget = { toE164: "+16025245719", name: "Dave Lane" };
  const amy: ReachTarget = { toE164: "+16026951142", name: "Amy Laidlaw" };
  const ladder = [dave, amy];

  it("dials the first target before anything has been tried", () => {
    expect(nextReachDecision(ladder, 0)).toEqual({ kind: "dial", target: dave, attempt: 0 });
  });

  it("falls through to the next target after a miss", () => {
    expect(nextReachDecision(ladder, 1, "no_answer")).toEqual({
      kind: "dial",
      target: amy,
      attempt: 1
    });
  });

  // The whole point of the ladder: when nobody picks up, the assistant is
  // still on the line and must be told so it can say so honestly.
  it("reports exhausted once every target has missed", () => {
    expect(nextReachDecision(ladder, 2, "no_answer")).toEqual({ kind: "exhausted" });
  });

  // Continuing to ring the next person after someone answered would put two
  // teammates on one caller.
  it("short-circuits to bridge on an answer, even with targets left", () => {
    expect(nextReachDecision(ladder, 1, "answered")).toEqual({ kind: "bridge" });
    expect(nextReachDecision(ladder, 0, "answered")).toEqual({ kind: "bridge" });
  });

  // A dial that never happened still consumes its rung: the number is bad and
  // retrying it would just stall the caller again.
  it("advances past a target that could not be dialed", () => {
    expect(nextReachDecision(ladder, 1, "not_dialed")).toEqual({
      kind: "dial",
      target: amy,
      attempt: 1
    });
  });

  it("skips targets with no number rather than dialing an empty string", () => {
    const withGap = [{ toE164: "  ", name: "Vacant" }, dave];
    expect(nextReachDecision(withGap, 0)).toEqual({ kind: "dial", target: dave, attempt: 0 });
    expect(nextReachDecision(withGap, 1, "no_answer")).toEqual({ kind: "exhausted" });
  });

  it("is exhausted with no usable targets at all", () => {
    expect(nextReachDecision([], 0)).toEqual({ kind: "exhausted" });
    expect(nextReachDecision([{ toE164: "", name: "Nobody" }], 0)).toEqual({ kind: "exhausted" });
  });

  // Total by construction: a live call must never reach an undefined state
  // with a person waiting on the line.
  it("resolves a nonsensical attempt count instead of throwing", () => {
    expect(nextReachDecision(ladder, -1)).toEqual({ kind: "exhausted" });
    expect(nextReachDecision(ladder, 99)).toEqual({ kind: "exhausted" });
  });
});

describe("clampReachRingSeconds", () => {
  it("defaults when unset or unusable", () => {
    expect(clampReachRingSeconds(undefined)).toBe(DEFAULT_REACH_RING_SECONDS);
    expect(clampReachRingSeconds("20")).toBe(DEFAULT_REACH_RING_SECONDS);
    expect(clampReachRingSeconds(NaN)).toBe(DEFAULT_REACH_RING_SECONDS);
  });

  // A caller is holding a live conversation while this runs, so neither bound
  // is cosmetic: too short never reaches anyone, too long reads as the
  // assistant having abandoned them.
  it("clamps to the supported range", () => {
    expect(clampReachRingSeconds(1)).toBe(MIN_REACH_RING_SECONDS);
    expect(clampReachRingSeconds(600)).toBe(MAX_REACH_RING_SECONDS);
    expect(clampReachRingSeconds(30)).toBe(30);
    expect(clampReachRingSeconds(20.7)).toBe(20);
  });
});

describe("telnyxBridgeCall", () => {
  const okFetch = () =>
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: () => Promise.resolve({}) });

  it("posts the bridge command with the OTHER leg in the body", async () => {
    const fetchMock = okFetch();
    await telnyxBridgeCall(
      "key",
      "leg-a",
      { otherCallControlId: "leg-b" },
      fetchMock as unknown as typeof fetch
    );
    const [url, init] = fetchMock.mock.calls[0];
    // The path id is the leg the command runs ON; the body id is the leg it
    // joins TO. Swapping them bridges the wrong pair.
    expect(url).toBe("https://api.telnyx.com/v2/calls/leg-a/actions/bridge");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ call_control_id: "leg-b" });
  });

  it("url-encodes a leg id", async () => {
    const fetchMock = okFetch();
    await telnyxBridgeCall(
      "key",
      "v3:abc/def",
      { otherCallControlId: "leg-b" },
      fetchMock as unknown as typeof fetch
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://api.telnyx.com/v2/calls/v3%3Aabc%2Fdef/actions/bridge"
    );
  });

  // Park-after-unbridge is what keeps a caller connected if their teammate
  // drops, so it must only be sent when explicitly asked for.
  it("sends park_after_unbridge and command_id only when given", async () => {
    const bare = okFetch();
    await telnyxBridgeCall(
      "key",
      A_LEG,
      { otherCallControlId: "leg-b" },
      bare as unknown as typeof fetch
    );
    const bareBody = JSON.parse(bare.mock.calls[0][1].body as string);
    expect(bareBody).not.toHaveProperty("park_after_unbridge");
    expect(bareBody).not.toHaveProperty("command_id");

    const full = okFetch();
    await telnyxBridgeCall(
      "key",
      A_LEG,
      { otherCallControlId: "leg-b", parkAfterUnbridge: true, commandId: "cmd-1" },
      full as unknown as typeof fetch
    );
    const fullBody = JSON.parse(full.mock.calls[0][1].body as string);
    expect(fullBody.park_after_unbridge).toBe(true);
    // Telnyx ignores a repeat of the same command_id on the same leg, so this
    // is what stops a retried bridge from double-joining.
    expect(fullBody.command_id).toBe("cmd-1");
  });

  it("base64-encodes client_state like every other call command", async () => {
    const fetchMock = okFetch();
    await telnyxBridgeCall(
      "key",
      A_LEG,
      { otherCallControlId: "leg-b", clientState: "rt:biz:abc:0" },
      fetchMock as unknown as typeof fetch
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(Buffer.from(body.client_state as string, "base64").toString()).toBe("rt:biz:abc:0");
  });
});

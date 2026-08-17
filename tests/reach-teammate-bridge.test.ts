import { describe, expect, it, vi } from "vitest";
import {
  clampReachRingSeconds,
  encodeReachClientState,
  parseReachLadderConfig,
  pollReachOutcome,
  readReachOutcome,
  runReachLadder,
  type ReachLadderConfig,
  type ReachTelnyxDeps
} from "../vps/voice-bridge/src/reach-teammate";
import { parseReachClientState } from "../supabase/functions/_shared/voice_reach";

/**
 * The bridge side of reach_teammate. The client-state format and the
 * outcome-stamp shape are lockstep with _shared/voice_reach.ts, so the first
 * test round-trips one through the OTHER side's parser: if either half
 * drifts, this file fails before a live call does.
 */

const A_LEG = "v3:abcDEF123";
const BIZ = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";

const CONFIG: ReachLadderConfig = {
  targets: [
    { name: "Dave Lane", e164: "+16025245719" },
    { name: "Amy Laidlaw", e164: "+16026951142" }
  ],
  ringSeconds: 5,
  preSmsBody: "Seller on the line NOW. Pick up!",
  connectionId: "conn-1",
  fromE164: "+16232633832"
};

/** A supabase stub whose session context.reach is scripted per read. */
function reachSession(stamps: Array<Record<string, unknown> | null>) {
  let i = 0;
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const reach = stamps[Math.min(i, stamps.length - 1)];
            i += 1;
            return { data: { context: reach ? { reach } : {} }, error: null };
          }
        })
      })
    })
  } as never;
}

function deps(overrides: Partial<ReachTelnyxDeps> = {}): {
  telnyx: ReachTelnyxDeps;
  calls: { dial: unknown[]; bridge: unknown[]; hangup: string[]; sms: string[] };
} {
  const calls = {
    dial: [] as unknown[],
    bridge: [] as unknown[],
    hangup: [] as string[],
    sms: [] as string[]
  };
  const telnyx: ReachTelnyxDeps = {
    dial: async (opts) => {
      calls.dial.push(opts);
      return { ok: true, status: 200, callControlId: `b-leg-${calls.dial.length}` };
    },
    bridge: async (leg, opts) => {
      calls.bridge.push({ leg, ...opts });
      return { ok: true, status: 200 };
    },
    hangup: async (leg) => {
      calls.hangup.push(leg);
      return { ok: true, status: 200 };
    },
    sendPreSms: async (to) => {
      calls.sms.push(to);
    },
    ...overrides
  };
  return { telnyx, calls };
}

describe("lockstep with the webhook side", () => {
  it("the bridge's client_state parses through the webhook's parser", () => {
    const encoded = encodeReachClientState(BIZ, A_LEG, 1);
    // The A leg id itself contains a colon; the webhook parser must recover
    // it exactly, or outcomes land on the wrong session.
    expect(parseReachClientState(encoded)).toEqual({
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      attempt: 1
    });
  });
});

describe("parseReachLadderConfig", () => {
  const RAW = {
    targets: [
      { name: "Dave Lane", e164: "+16025245719" },
      { name: "", e164: "  " },
      { name: "Amy Laidlaw", e164: "+16026951142" }
    ],
    ring_seconds: 12,
    pre_sms_body: " ping ",
    connection_id: "conn-1",
    from_e164: "+16232633832"
  };

  it("parses, drops numberless rungs, trims, clamps", () => {
    expect(parseReachLadderConfig(RAW)).toEqual({
      targets: [
        { name: "Dave Lane", e164: "+16025245719" },
        { name: "Amy Laidlaw", e164: "+16026951142" }
      ],
      ringSeconds: 12,
      preSmsBody: "ping",
      connectionId: "conn-1",
      fromE164: "+16232633832"
    });
  });

  it("defaults and clamps the ring window", () => {
    expect(clampReachRingSeconds(undefined)).toBe(20);
    expect(clampReachRingSeconds(1)).toBe(5);
    expect(clampReachRingSeconds(500)).toBe(45);
    expect(clampReachRingSeconds(20.9)).toBe(20);
  });

  it("refuses a ladder it cannot dial: no connection, no DID, no targets", () => {
    expect(parseReachLadderConfig(null)).toBeNull();
    expect(parseReachLadderConfig({ ...RAW, connection_id: " " })).toBeNull();
    expect(parseReachLadderConfig({ ...RAW, from_e164: undefined })).toBeNull();
    expect(parseReachLadderConfig({ ...RAW, targets: [] })).toBeNull();
    expect(parseReachLadderConfig({ ...RAW, targets: [{ name: "x" }] })).toBeNull();
  });
});

describe("readReachOutcome", () => {
  it("ignores a stamp from a DIFFERENT attempt: a late event is not this answer", async () => {
    const supa = reachSession([{ attempt: 0, status: "answered", b_leg: "old-b" }]);
    expect(await readReachOutcome(supa, A_LEG, 1)).toBeNull();
  });

  it("reads the current attempt's stamp", async () => {
    const supa = reachSession([{ attempt: 1, status: "answered", b_leg: "b-1" }]);
    expect(await readReachOutcome(supa, A_LEG, 1)).toEqual({ status: "answered", bLeg: "b-1" });
  });

  it("returns null on a read error or an unstamped session", async () => {
    const failing = {
      from: () => ({
        select: () => ({
          eq: () => ({ maybeSingle: async () => ({ data: null, error: { message: "x" } }) })
        })
      })
    } as never;
    expect(await readReachOutcome(failing, A_LEG, 0)).toBeNull();
    expect(await readReachOutcome(reachSession([null]), A_LEG, 0)).toBeNull();
  });
});

describe("pollReachOutcome", () => {
  it("resolves no_answer when the window elapses silently, so the ladder always advances", async () => {
    const supa = reachSession([null]);
    const sleep = vi.fn(async () => undefined);
    const out = await pollReachOutcome(supa, A_LEG, 0, 1, { pollMs: 400, sleep });
    expect(out).toEqual({ status: "no_answer", bLeg: "" });
    expect(sleep).toHaveBeenCalled();
  });
});

describe("runReachLadder", () => {
  it("bridges the first target who answers, pre-alerting them first", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([{ attempt: 0, status: "answered", b_leg: "b-leg-1" }]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result).toEqual({ ok: true, connectedName: "Dave Lane", bLeg: "b-leg-1" });
    expect(calls.sms).toEqual(["+16025245719"]);
    expect(calls.dial).toHaveLength(1);
    // The A leg is bridged TO the B leg and parked when the bridge later
    // ends, so a dropping teammate never hangs up on the caller.
    expect(calls.bridge).toEqual([
      {
        leg: A_LEG,
        otherCallControlId: "b-leg-1",
        parkAfterUnbridge: true,
        commandId: `reach-bridge-${A_LEG}-0`
      }
    ]);
    expect(calls.hangup).toEqual([]);
  });

  it("hangs up a missed B leg BEFORE dialing the next target", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([
      { attempt: 0, status: "no_answer", b_leg: "b-leg-1" },
      { attempt: 1, status: "answered", b_leg: "b-leg-2" }
    ]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result).toEqual({ ok: true, connectedName: "Amy Laidlaw", bLeg: "b-leg-2" });
    // Dave's leg was torn down before Amy's phone rang: without this, a
    // late voicemail answer holds a zombie leg while the next phone rings.
    expect(calls.hangup).toEqual(["b-leg-1"]);
    expect(calls.dial).toHaveLength(2);
    expect(calls.sms).toEqual(["+16025245719", "+16026951142"]);
  });

  it("reports nobody_answered honestly when the whole ladder rings out", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([
      { attempt: 0, status: "no_answer", b_leg: "b-leg-1" },
      { attempt: 1, status: "no_answer", b_leg: "b-leg-2" }
    ]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result).toEqual({ ok: false, detail: "nobody_answered" });
    expect(calls.hangup).toEqual(["b-leg-1", "b-leg-2"]);
  });

  it("skips straight past a refused dial without waiting the ring window", async () => {
    const { telnyx, calls } = deps({
      dial: async (opts) => {
        calls.dial.push(opts);
        return calls.dial.length === 1
          ? { ok: false, status: 422, body: "invalid number" }
          : { ok: true, status: 200, callControlId: "b-leg-2" };
      }
    });
    const supa = reachSession([{ attempt: 1, status: "answered", b_leg: "b-leg-2" }]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result).toEqual({ ok: true, connectedName: "Amy Laidlaw", bLeg: "b-leg-2" });
    // Nothing to hang up for a leg that never existed.
    expect(calls.hangup).toEqual([]);
  });

  it("releases a teammate the bridge could not join, then keeps trying", async () => {
    const { telnyx, calls } = deps({
      bridge: async (leg, opts) => {
        calls.bridge.push({ leg, ...opts });
        return calls.bridge.length === 1
          ? { ok: false, status: 500, body: "bridge failed" }
          : { ok: true, status: 200 };
      }
    });
    const supa = reachSession([
      { attempt: 0, status: "answered", b_leg: "b-leg-1" },
      { attempt: 1, status: "answered", b_leg: "b-leg-2" }
    ]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result).toEqual({ ok: true, connectedName: "Amy Laidlaw", bLeg: "b-leg-2" });
    // Dave answered but could not be joined: he was released rather than
    // left holding a silent line while the assistant reported success.
    expect(calls.hangup).toEqual(["b-leg-1"]);
  });

  it("a dial-window timeout with no stamp still advances (client-state tagged per attempt)", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([null]);
    const shortConfig = { ...CONFIG, ringSeconds: 5, targets: [CONFIG.targets[0]!] };
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: shortConfig,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result).toEqual({ ok: false, detail: "nobody_answered" });
    const dialOpts = calls.dial[0] as { clientState?: string; timeoutSecs?: number };
    expect(dialOpts.timeoutSecs).toBe(5);
    expect(parseReachClientState(dialOpts.clientState)).toEqual({
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      attempt: 0
    });
  });
});

/**
 * B-leg dial refusals become telemetry (2026-08-16 incident review): a
 * Telnyx capacity 403 on every rung used to be stdout-only and read to the
 * caller as "nobody answered". The ladder still advances identically; the
 * refusal is now queryable.
 */
describe("runReachLadder: dial-failure telemetry", () => {
  it("emits voice_reach_dial_failed per refused rung and voice_reach_exhausted at the end", async () => {
    const { telnyx } = deps({
      dial: async () => ({ ok: false, status: 403, body: "User channel limit exceeded D1" })
    });
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    const supa = reachSession([null]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined },
      telemetry: (type, payload) => events.push({ type, payload })
    });
    expect(result).toEqual({ ok: false, detail: "nobody_answered" });
    expect(events).toEqual([
      {
        type: "voice_reach_dial_failed",
        payload: {
          attempt: 0,
          to: "+16025245719",
          http_status: 403,
          error_snippet: "User channel limit exceeded D1"
        }
      },
      {
        type: "voice_reach_dial_failed",
        payload: {
          attempt: 1,
          to: "+16026951142",
          http_status: 403,
          error_snippet: "User channel limit exceeded D1"
        }
      },
      { type: "voice_reach_exhausted", payload: { targets: 2 } }
    ]);
  });

  it("emits nothing on a bridged success and stays safe with no callback", async () => {
    const { telnyx } = deps();
    const events: string[] = [];
    const supa = reachSession([{ attempt: 0, status: "answered", b_leg: "b-leg-1" }]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined },
      telemetry: (type) => events.push(type)
    });
    expect(result.ok).toBe(true);
    expect(events).toEqual([]);

    // No callback at all: the refused path must not throw.
    const { telnyx: refusing } = deps({
      dial: async () => ({ ok: false, status: 403, body: undefined })
    });
    const out = await runReachLadder(reachSession([null]), refusing, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(out.ok).toBe(false);
  });
});

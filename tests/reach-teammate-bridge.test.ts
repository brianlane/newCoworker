import { describe, expect, it, vi } from "vitest";
import {
  awaitReachAmdClearance,
  clampReachRingSeconds,
  encodeReachClientState,
  parseReachLadderConfig,
  pollReachOutcome,
  readReachAmd,
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

/**
 * A supabase stub whose session CONTEXT is scripted per read (last repeats).
 *
 * Both readReachOutcome (context.reach) and readReachAmd (context.reach_amd)
 * read the same row, and the ladder interleaves them: outcome poll first,
 * then the AMD clearance gate once an answer lands. Scripts therefore carry
 * whole context objects, and an answered rung that should BRIDGE must also
 * carry a human reach_amd (or the test pays the clearance cap).
 */
function reachSession(contexts: Array<Record<string, unknown> | null>) {
  let i = 0;
  const rpcCalls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const stub = {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: async () => {
            const context = contexts[Math.min(i, contexts.length - 1)];
            i += 1;
            return { data: { context: context ?? {} }, error: null };
          }
        })
      })
    }),
    // The ladder stamps context.reach_bridged via this RPC right before it
    // bridges, so the webhook's late machine verdict can tell a bridged leg
    // from a skippable one.
    rpc: async (fn: string, args: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { data: null, error: null };
    }
  };
  return Object.assign(stub, { rpcCalls }) as unknown as Parameters<typeof runReachLadder>[0] & {
    rpcCalls: typeof rpcCalls;
  };
}

/** Shorthand: a context whose rung answered AND cleared AMD as human. */
function answeredHuman(attempt: number, bLeg: string): Record<string, unknown> {
  return {
    reach: { attempt, status: "answered", b_leg: bLeg },
    reach_amd: { attempt, verdict: "human" }
  };
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
    const supa = reachSession([{ reach: { attempt: 0, status: "answered", b_leg: "old-b" } }]);
    expect(await readReachOutcome(supa, A_LEG, 1)).toBeNull();
  });

  it("reads the current attempt's stamp", async () => {
    const supa = reachSession([{ reach: { attempt: 1, status: "answered", b_leg: "b-1" } }]);
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
  it("bridges the first target who answers, pre-alerting them as the dial goes out", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([answeredHuman(0, "b-leg-1")]);
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
      { reach: { attempt: 0, status: "no_answer", b_leg: "b-leg-1" } },
      answeredHuman(1, "b-leg-2")
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
      { reach: { attempt: 0, status: "no_answer", b_leg: "b-leg-1" } },
      { reach: { attempt: 1, status: "no_answer", b_leg: "b-leg-2" } }
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
    const supa = reachSession([answeredHuman(1, "b-leg-2")]);
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
      answeredHuman(0, "b-leg-1"),
      answeredHuman(0, "b-leg-1"),
      answeredHuman(1, "b-leg-2")
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
describe("runReachLadder: dial-failure telemetry and honesty", () => {
  it("all rungs refused: dials_refused, no pre-alerts, telemetry per rung", async () => {
    const { telnyx, calls } = deps({
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
    // Nobody was rung, so the result must NOT read as the team ignoring the
    // call, and nobody gets hyped by a pre-alert for a phone that never
    // rings (2026-08-16 incident review).
    expect(result).toEqual({ ok: false, detail: "dials_refused" });
    expect(calls.sms).toEqual([]);
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
      { type: "voice_reach_exhausted", payload: { targets: 2, detail: "dials_refused" } }
    ]);
  });

  it("a mix of refused and rang-out rungs stays nobody_answered, pre-alerting only who rang", async () => {
    let dialCount = 0;
    const { telnyx, calls } = deps({
      dial: async () => {
        dialCount += 1;
        if (dialCount === 1) return { ok: false, status: 403, body: "channel limit" };
        return { ok: true, status: 200, callControlId: "b-leg-2" };
      }
    });
    const supa = reachSession([
      { reach: { attempt: 1, status: "no_answer", b_leg: "b-leg-2" } }
    ]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    // Amy's phone really rang and rang out; Dave was never rung. One phone
    // ringing makes "nobody answered" the truthful summary, and only the
    // teammate whose phone rang got the heads-up text.
    expect(result).toEqual({ ok: false, detail: "nobody_answered" });
    expect(calls.sms).toEqual(["+16026951142"]);
  });

  it("sends the pre-alert only AFTER the dial goes out", async () => {
    const sequence: string[] = [];
    const { telnyx } = deps({
      dial: async () => {
        sequence.push("dial");
        return { ok: true, status: 200, callControlId: "b-leg-1" };
      },
      sendPreSms: async () => {
        sequence.push("sms");
      }
    });
    const supa = reachSession([answeredHuman(0, "b-leg-1")]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result.ok).toBe(true);
    expect(sequence).toEqual(["dial", "sms"]);
  });

  it("emits nothing on a bridged success and stays safe with no callback", async () => {
    const { telnyx } = deps();
    const events: string[] = [];
    const supa = reachSession([answeredHuman(0, "b-leg-1")]);
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

/**
 * The AMD clearance gate. A teammate's voicemail ANSWERS the leg (a phone
 * that is off reaches it in seconds, inside any ring window), and bridging on
 * the answer alone put the caller inside the greeting. The ladder now dials
 * with premium AMD, holds the bridge until the verdict clears, skips a
 * machine rung silently, and fails OPEN on a missing verdict so a live
 * teammate is never left holding a silent line.
 */
describe("runReachLadder: AMD clearance", () => {
  it("every rung dials with premium answering-machine detection", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([answeredHuman(0, "b-leg-1")]);
    await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    const dialOpts = calls.dial[0] as { answeringMachineDetection?: string };
    expect(dialOpts.answeringMachineDetection).toBe("premium");
  });

  it("a machine verdict skips the rung silently: hang up, no bridge, next target", async () => {
    const { telnyx, calls } = deps();
    const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
    // The stub serves contexts sequentially (outcome read, then the clearance
    // read), so the machine context appears twice: once for each reader.
    const machineCtx = {
      reach: { attempt: 0, status: "answered", b_leg: "b-leg-1" },
      reach_amd: { attempt: 0, verdict: "machine" }
    };
    const supa = reachSession([
      machineCtx,
      machineCtx,
      { reach: { attempt: 1, status: "no_answer", b_leg: "b-leg-2" } }
    ]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined },
      telemetry: (type, payload) => events.push({ type, payload })
    });
    expect(result).toEqual({ ok: false, detail: "nobody_answered" });
    // The voicemail leg was released and the caller was NEVER bridged to it.
    expect(calls.bridge).toEqual([]);
    expect(calls.hangup).toContain("b-leg-1");
    expect(calls.dial).toHaveLength(2);
    expect(events.map((e) => e.type)).toContain("voice_reach_vm_skipped");
  });

  it("fails open: an answer with no verdict bridges once the cap elapses", async () => {
    const { telnyx, calls } = deps();
    const supa = reachSession([{ reach: { attempt: 0, status: "answered", b_leg: "b-leg-1" } }]);
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined, capMs: 5 }
    });
    expect(result).toEqual({ ok: true, connectedName: "Dave Lane", bLeg: "b-leg-1" });
    expect(calls.bridge).toHaveLength(1);
  });
});

describe("readReachAmd / awaitReachAmdClearance", () => {
  it("ignores a verdict from a different attempt, exactly like the outcome reader", async () => {
    const supa = reachSession([{ reach_amd: { attempt: 0, verdict: "machine" } }]);
    expect(await readReachAmd(supa, A_LEG, 1)).toBeNull();
  });

  it("reads only the two actionable verdicts and drops anything else", async () => {
    expect(
      await readReachAmd(reachSession([{ reach_amd: { attempt: 2, verdict: "human" } }]), A_LEG, 2)
    ).toBe("human");
    expect(
      await readReachAmd(
        reachSession([{ reach_amd: { attempt: 2, verdict: "machine" } }]),
        A_LEG,
        2
      )
    ).toBe("machine");
    expect(
      await readReachAmd(
        reachSession([{ reach_amd: { attempt: 2, verdict: "surprise" } }]),
        A_LEG,
        2
      )
    ).toBeNull();
  });

  it("resolves timeout when no verdict ever lands, without throwing", async () => {
    const supa = reachSession([null]);
    const verdict = await awaitReachAmdClearance(supa, A_LEG, 0, {
      pollMs: 1,
      sleep: async () => undefined,
      capMs: 5
    });
    expect(verdict).toBe("timeout");
  });
});

/**
 * The late-verdict shield. Premium classification can land AFTER the 3s
 * clearance cap failed open and the caller was bridged; hanging the leg up
 * then would cut a live conversation on a verdict that may be wrong. The
 * ladder therefore stamps context.reach_bridged BEFORE issuing the bridge
 * command, and the webhook's machine hangup checks it first.
 */
describe("runReachLadder: reach_bridged stamp", () => {
  it("stamps the attempt via the context merge BEFORE the bridge command", async () => {
    const order: string[] = [];
    const { telnyx } = deps({
      bridge: async () => {
        order.push("bridge");
        return { ok: true, status: 200 };
      }
    });
    const supa = reachSession([answeredHuman(0, "b-leg-1")]);
    const origRpc = (supa as unknown as { rpc: (fn: string, a: unknown) => Promise<unknown> }).rpc;
    (supa as unknown as { rpc: (fn: string, a: unknown) => Promise<unknown> }).rpc = async (
      fn,
      a
    ) => {
      order.push("stamp");
      return origRpc(fn, a as Record<string, unknown>);
    };
    const result = await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(result.ok).toBe(true);
    expect(order).toEqual(["stamp", "bridge"]);
    expect(supa.rpcCalls).toEqual([
      {
        fn: "voice_session_context_merge",
        args: { p_call_control_id: A_LEG, p_patch: { reach_bridged: { attempt: 0 } } }
      }
    ]);
  });

  it("a machine skip never stamps: nothing was bridged", async () => {
    const machineCtx = {
      reach: { attempt: 0, status: "answered", b_leg: "b-leg-1" },
      reach_amd: { attempt: 0, verdict: "machine" }
    };
    const { telnyx } = deps();
    const supa = reachSession([
      machineCtx,
      machineCtx,
      { reach: { attempt: 1, status: "no_answer", b_leg: "b-leg-2" } }
    ]);
    await runReachLadder(supa, telnyx, {
      businessId: BIZ,
      aLegCallControlId: A_LEG,
      config: CONFIG,
      poll: { pollMs: 1, sleep: async () => undefined }
    });
    expect(supa.rpcCalls).toEqual([]);
  });
});

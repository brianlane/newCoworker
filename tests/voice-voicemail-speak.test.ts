import { describe, expect, it } from "vitest";
import {
  speakVoicemailDeterministic,
  VOICEMAIL_SPEAK_VOICE,
  type VoicemailSpeakDeps
} from "../supabase/functions/_shared/voice_voicemail_speak.ts";

/**
 * The deterministic voicemail speaker, shared by the greeting handler in
 * telnyx-voice-call-end and the AMD resolution sweep. The claim decides who
 * speaks; the honesty change under test is the stamp: a successful speak
 * writes `voicemail_speak_started_at` (command ACCEPTED), never
 * `voicemail_spoken` (playout confirmed), which is `call.speak.ended`'s or
 * the hangup fallback's job.
 */

type RpcCall = { fn: string; args: Record<string, unknown> | undefined };
type HttpCall = { url: string; body: unknown };

function makeDeps(opts: {
  rpcResults?: Record<string, { data?: unknown; error: { message: string } | null }[]>;
  httpFail?: (url: string) => boolean;
} = {}): {
  deps: VoicemailSpeakDeps;
  rpcCalls: RpcCall[];
  httpCalls: HttpCall[];
} {
  const rpcCalls: RpcCall[] = [];
  const httpCalls: HttpCall[] = [];
  const queues = new Map(Object.entries(opts.rpcResults ?? {}));
  const deps: VoicemailSpeakDeps = {
    rpc: (fn, args) => {
      rpcCalls.push({ fn, args });
      const queue = queues.get(fn);
      const result = queue?.shift() ?? { data: undefined, error: null };
      return Promise.resolve(result);
    },
    apiKey: "test-key",
    fetchImpl: ((url: string, init?: RequestInit) => {
      httpCalls.push({ url, body: init?.body });
      const failed = opts.httpFail?.(url) === true;
      return Promise.resolve(
        new Response(failed ? "nope" : "{}", { status: failed ? 422 : 200 })
      );
    }) as unknown as typeof fetch,
    nowIso: () => "2026-08-27T15:35:34.000Z"
  };
  return { deps, rpcCalls, httpCalls };
}

const action = (url: string) => url.split("/").pop();

describe("speakVoicemailDeterministic", () => {
  it("claims, stops the stream, speaks, and stamps started_at (not spoken)", async () => {
    const { deps, rpcCalls, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ data: true, error: null }] }
    });
    const outcome = await speakVoicemailDeterministic(
      deps,
      "v3:leg",
      "Call us back at 602-695-1142",
      { trigger: "beep" }
    );
    expect(outcome).toBe("speaking");
    expect(httpCalls.map((c) => action(c.url))).toEqual(["streaming_stop", "speak"]);
    const speakBody = JSON.parse(String(httpCalls[1]!.body));
    expect(speakBody.voice).toBe(VOICEMAIL_SPEAK_VOICE);
    expect(VOICEMAIL_SPEAK_VOICE).toBe("female");
    const merge = rpcCalls.find((c) => c.fn === "voice_session_context_merge");
    expect(merge?.args?.p_patch).toEqual({
      voicemail_speak_started_at: "2026-08-27T15:35:34.000Z",
      voicemail_speak_script_chars: "Call us back at 602-695-1142".length,
      voicemail_speak_trigger: "beep"
    });
    // The honest stamp is NOT written here: acceptance is not delivery.
    expect(JSON.stringify(rpcCalls)).not.toContain("voicemail_spoken");
  });

  it("still reports speaking when the started_at stamp fails to land", async () => {
    // The message IS going out; a lost stamp only understates it later.
    const { deps } = makeDeps({
      rpcResults: {
        voice_claim_voicemail_speak: [{ data: true, error: null }],
        voice_session_context_merge: [{ error: { message: "merge down" } }]
      }
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("speaking");
  });

  it("hangs the leg up when the claim RPC errors", async () => {
    // The machine verdict is already stamped; leaving the leg up means the
    // bridge keeps talking into the recording.
    const { deps, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ error: { message: "db down" } }] }
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("claim_failed");
    expect(httpCalls.map((c) => action(c.url))).toEqual(["streaming_stop", "hangup"]);
  });

  it("leaves the leg entirely alone when another caller holds the claim", async () => {
    // The claim holder owns the leg's ending; hanging up would cut a
    // message that is mid-playout.
    const { deps, httpCalls, rpcCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ data: false, error: null }] }
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("already_claimed");
    expect(httpCalls).toEqual([]);
    expect(rpcCalls.map((c) => c.fn)).toEqual(["voice_claim_voicemail_speak"]);
  });

  it("releases the claim and hangs up when the stream stop is refused", async () => {
    // Speaking under the still-attached bridge would record the script
    // beneath the assistant's chatter.
    const { deps, httpCalls, rpcCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ data: true, error: null }] },
      httpFail: (url) => url.endsWith("streaming_stop")
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("stream_stop_failed");
    expect(rpcCalls.map((c) => c.fn)).toContain("voice_release_voicemail_claim");
    // First stop failed; the give-up path stops again and hangs up.
    expect(httpCalls.map((c) => action(c.url))).toEqual([
      "streaming_stop",
      "streaming_stop",
      "hangup"
    ]);
  });

  it("releases the claim and hangs up when the speak is refused", async () => {
    const { deps, httpCalls, rpcCalls } = makeDeps({
      rpcResults: {
        voice_claim_voicemail_speak: [{ data: true, error: null }],
        voice_release_voicemail_claim: [{ error: { message: "release down" } }]
      },
      httpFail: (url) => url.endsWith("speak")
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("speak_failed");
    // The failed release is logged and does not change the outcome.
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "voice_claim_voicemail_speak",
      "voice_release_voicemail_claim"
    ]);
    expect(httpCalls.map((c) => action(c.url))).toEqual([
      "streaming_stop",
      "speak",
      "streaming_stop",
      "hangup"
    ]);
  });

  it("claims the retry, skips the stream-stop, speaks, and stamps restarted", async () => {
    // cancelled_amd retry: re-claiming the first-speak bit would return
    // already_claimed and the message would never go out a second time. The
    // retry claim is a separate compare-and-set so two in-flight handlers
    // cannot both speak.
    const { deps, rpcCalls, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_retry: [{ data: true, error: null }] }
    });
    const outcome = await speakVoicemailDeterministic(deps, "v3:leg", "retry script", {
      trigger: "cancelled_retry",
      alreadyClaimed: true
    });
    expect(outcome).toBe("speaking");
    expect(httpCalls.map((c) => action(c.url))).toEqual(["speak"]);
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "voice_claim_voicemail_retry",
      "voice_session_context_merge"
    ]);
    expect(rpcCalls[1]?.args?.p_patch).toEqual({
      voicemail_speak_started_at: "2026-08-27T15:35:34.000Z",
      voicemail_speak_script_chars: "retry script".length,
      voicemail_speak_trigger: "cancelled_retry",
      voicemail_speak_restarted: true
    });
  });

  it("leaves the leg alone when another handler already claimed the retry", async () => {
    const { deps, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_retry: [{ data: false, error: null }] }
    });
    expect(
      await speakVoicemailDeterministic(deps, "v3:leg", "retry script", { alreadyClaimed: true })
    ).toBe("already_claimed");
    expect(httpCalls).toEqual([]);
  });

  it("does not hang up when the retry claim RPC errors", async () => {
    // The other in-flight handler may already be speaking. Cutting the leg
    // would drop the message we are trying to save.
    const { deps, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_retry: [{ error: { message: "db down" } }] }
    });
    expect(
      await speakVoicemailDeterministic(deps, "v3:leg", "retry script", { alreadyClaimed: true })
    ).toBe("claim_failed");
    expect(httpCalls).toEqual([]);
  });
});

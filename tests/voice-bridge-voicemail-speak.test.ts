import { describe, expect, it } from "vitest";
import {
  speakVoicemailDeterministic,
  VOICEMAIL_SPEAK_VOICE,
  type VoicemailSpeakDeps
} from "../vps/voice-bridge/src/voicemail-speak";

type RpcCall = { fn: string; args: Record<string, unknown> | undefined };
type HttpCall = { url: string; body: unknown };

function makeDeps(opts: {
  rpcResults?: Record<string, { data?: unknown; error: { message: string } | null }[]>;
  httpFail?: (url: string) => boolean;
}): {
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
    nowIso: () => "2026-09-01T16:17:34.000Z"
  };
  return { deps, rpcCalls, httpCalls };
}

const action = (url: string) => url.split("/").pop();

describe("bridge speakVoicemailDeterministic", () => {
  it("claims, stops the stream, speaks female, and stamps bridge_beep", async () => {
    const { deps, rpcCalls, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ data: true, error: null }] }
    });
    expect(
      await speakVoicemailDeterministic(deps, "v3:leg", "Call us back at 602-695-1142", {
        trigger: "bridge_beep"
      })
    ).toBe("speaking");
    expect(httpCalls.map((c) => action(c.url))).toEqual(["streaming_stop", "speak"]);
    expect(JSON.parse(String(httpCalls[1]!.body)).voice).toBe(VOICEMAIL_SPEAK_VOICE);
    expect(rpcCalls.find((c) => c.fn === "voice_session_context_merge")?.args?.p_patch).toEqual({
      voicemail_speak_started_at: "2026-09-01T16:17:34.000Z",
      voicemail_speak_script_chars: "Call us back at 602-695-1142".length,
      voicemail_speak_trigger: "bridge_beep"
    });
  });

  it("leaves the leg alone when another caller holds the claim", async () => {
    const { deps, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ data: false, error: null }] }
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("already_claimed");
    expect(httpCalls).toEqual([]);
  });

  it("hangs up when the claim RPC errors", async () => {
    const { deps, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ error: { message: "db down" } }] }
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("claim_failed");
    expect(httpCalls.map((c) => action(c.url))).toEqual(["streaming_stop", "hangup"]);
  });

  it("releases the claim and hangs up when the stream stop is refused", async () => {
    const { deps, rpcCalls, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_speak: [{ data: true, error: null }] },
      httpFail: (url) => url.endsWith("streaming_stop")
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("stream_stop_failed");
    expect(rpcCalls.map((c) => c.fn)).toContain("voice_release_voicemail_claim");
    expect(httpCalls.map((c) => action(c.url))).toEqual([
      "streaming_stop",
      "streaming_stop",
      "hangup"
    ]);
  });

  it("releases the claim and hangs up when the speak is refused", async () => {
    const { deps, httpCalls } = makeDeps({
      rpcResults: {
        voice_claim_voicemail_speak: [{ data: true, error: null }],
        voice_release_voicemail_claim: [{ error: { message: "release down" } }]
      },
      httpFail: (url) => url.endsWith("speak")
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("speak_failed");
    expect(httpCalls.map((c) => action(c.url))).toEqual([
      "streaming_stop",
      "speak",
      "streaming_stop",
      "hangup"
    ]);
  });

  it("still reports speaking when the started_at stamp fails to land", async () => {
    const { deps } = makeDeps({
      rpcResults: {
        voice_claim_voicemail_speak: [{ data: true, error: null }],
        voice_session_context_merge: [{ error: { message: "merge down" } }]
      }
    });
    expect(await speakVoicemailDeterministic(deps, "v3:leg", "script")).toBe("speaking");
  });

  it("claims the retry without stopping the stream again", async () => {
    const { deps, rpcCalls, httpCalls } = makeDeps({
      rpcResults: { voice_claim_voicemail_retry: [{ data: true, error: null }] }
    });
    expect(
      await speakVoicemailDeterministic(deps, "v3:leg", "retry script", {
        trigger: "cancelled_retry",
        alreadyClaimed: true
      })
    ).toBe("speaking");
    expect(httpCalls.map((c) => action(c.url))).toEqual(["speak"]);
    expect(rpcCalls.map((c) => c.fn)).toEqual([
      "voice_claim_voicemail_retry",
      "voice_session_context_merge"
    ]);
  });
});

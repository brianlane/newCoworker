import { describe, expect, it, vi } from "vitest";
import {
  isRunsOnlyRequest,
  KICK_ABANDON_MS,
  kickAiFlowWorker,
  RUNS_ONLY_BODY,
  wantsImmediateStart
} from "../supabase/functions/_shared/ai_flows/worker_kick";

const DEPS = { supabaseUrl: "https://proj.supabase.co", cronSecret: "cron-secret" };

function okFetch() {
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) =>
    Promise.resolve({ ok: true, status: 200 } as Response)
  );
}

describe("wantsImmediateStart", () => {
  it("is true when any queued flow opted in", () => {
    expect(
      wantsImmediateStart([{ options: { startImmediately: false } }, { options: { startImmediately: true } }])
    ).toBe(true);
  });

  it("is false for everything else, so the default costs nothing", () => {
    expect(wantsImmediateStart([])).toBe(false);
    expect(wantsImmediateStart([{}, { options: null }, null])).toBe(false);
    expect(wantsImmediateStart([{ options: { startImmediately: false } }])).toBe(false);
  });

  it("only accepts the literal true, not a truthy value", () => {
    // The option arrives from stored JSON, so a stray string must not silently
    // enable a per-message worker invocation.
    expect(
      wantsImmediateStart([{ options: { startImmediately: "yes" as unknown as boolean } }])
    ).toBe(false);
  });
});

describe("kickAiFlowWorker", () => {
  it("posts runsOnly to the worker with the cron bearer", async () => {
    const fetchImpl = okFetch();
    const ok = await kickAiFlowWorker({ ...DEPS, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(ok).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("https://proj.supabase.co/functions/v1/ai-flow-worker");
    expect((init as RequestInit).method).toBe("POST");
    expect((init as RequestInit).body).toBe(RUNS_ONLY_BODY);
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ runsOnly: true });
    const headers = (init as RequestInit).headers as Record<string, string>;
    // The cron secret, never the service-role key: the worker's own auth.
    expect(headers.Authorization).toBe("Bearer cron-secret");
  });

  it("tolerates a trailing slash on the project url", async () => {
    const fetchImpl = okFetch();
    await kickAiFlowWorker({
      ...DEPS,
      supabaseUrl: "https://proj.supabase.co/",
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(fetchImpl.mock.calls[0]![0]).toBe("https://proj.supabase.co/functions/v1/ai-flow-worker");
  });

  it("does nothing when it is not configured", async () => {
    const fetchImpl = okFetch();
    const impl = fetchImpl as unknown as typeof fetch;
    expect(await kickAiFlowWorker({ ...DEPS, supabaseUrl: "  ", fetchImpl: impl })).toBe(false);
    expect(await kickAiFlowWorker({ ...DEPS, cronSecret: "", fetchImpl: impl })).toBe(false);
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it("counts an abandoned wait as success, because the run is already under way", async () => {
    // The whole point is not to wait: once the worker accepts the request it
    // keeps running server-side, so aborting our side is the normal path.
    const aborted = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      (init?.signal as AbortSignal | undefined)?.throwIfAborted?.();
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const ok = await kickAiFlowWorker({
      ...DEPS,
      fetchImpl: aborted as unknown as typeof fetch,
      // Fire the abort immediately so the signal is already aborted.
      setTimeoutImpl: ((fn: () => void) => {
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout
    });
    expect(ok).toBe(true);
  });

  it("reports a genuine transport failure without throwing", async () => {
    // A webhook's reply to the carrier must never depend on this.
    const dead = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    const ok = await kickAiFlowWorker({
      ...DEPS,
      fetchImpl: dead as unknown as typeof fetch
    });
    expect(ok).toBe(false);
  });

  it("falls back to the platform fetch when none is injected", async () => {
    // Exercises the real default against a port nothing listens on, so it stays
    // offline and deterministic: a refused connection is the failure path.
    const ok = await kickAiFlowWorker({
      supabaseUrl: "http://127.0.0.1:1",
      cronSecret: "cron-secret",
      // A no-op timer so the 1.5s abort timer cannot outlive the test.
      setTimeoutImpl: (() => 0 as unknown as ReturnType<typeof setTimeout>) as unknown as typeof setTimeout
    });
    expect(ok).toBe(false);
  });

  it("bounds how long it will wait", () => {
    // Sized so a slow worker cannot stretch the Telnyx webhook's own reply.
    expect(KICK_ABANDON_MS).toBeLessThanOrEqual(2000);
    expect(KICK_ABANDON_MS).toBeGreaterThan(0);
  });
});

describe("isRunsOnlyRequest", () => {
  const post = (body: string) => new Request("https://x/", { method: "POST", body });

  it("recognizes the kick", async () => {
    expect(await isRunsOnlyRequest(post(RUNS_ONLY_BODY))).toBe(true);
  });

  it("treats a cron tick as a full tick", async () => {
    // The scheduler posts an empty body; a full tick must keep running the
    // overdue sweeps and the mailbox polls.
    expect(await isRunsOnlyRequest(post(""))).toBe(false);
    expect(await isRunsOnlyRequest(post("   "))).toBe(false);
    expect(await isRunsOnlyRequest(post("{}"))).toBe(false);
    expect(await isRunsOnlyRequest(post('{"runsOnly":false}'))).toBe(false);
  });

  it("fails safe on anything unreadable, rather than skipping the sweeps", async () => {
    expect(await isRunsOnlyRequest(post("not json"))).toBe(false);
    expect(await isRunsOnlyRequest(post("null"))).toBe(false);
    expect(await isRunsOnlyRequest(post('{"runsOnly":"true"}'))).toBe(false);
    const unreadable = {
      text: () => Promise.reject(new Error("stream already consumed"))
    } as unknown as Request;
    expect(await isRunsOnlyRequest(unreadable)).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  QUEUE_RPC_ERROR_AFTER,
  QUEUE_RPC_RETRY_MS,
  classifyQueueRpcFailure,
  createQueueRpcFailureTracker,
  describeQueueRpcError,
  isTransientRpcError
} from "../vps/chat-worker/queue-rpc-errors.mjs";

/**
 * The chat-worker's sweep RPCs fail for two very different reasons and the
 * admin System Errors feed only wants to hear about one of them. See the
 * header comment in queue-rpc-errors.mjs for the policy; these tests pin the
 * classification, which used to be a regex over the error prose and so missed
 * every proxy-generated failure.
 */

/**
 * The literal body Supabase's edge gateway (Envoy) returned to Scar Fairy's
 * box on 2026-08-14, which surfaced as a red `reclaim_failed`. 111 is
 * ECONNREFUSED: the gateway could not reach PostgREST behind it.
 */
const ENVOY_503_BODY =
  "upstream connect error or disconnect/reset before headers. retried and the " +
  "latest reset reason: remote connection failure, transport failure reason: " +
  "delayed connect error: 111";

/** postgrest-js hands back the raw body as `message` when it is not JSON. */
const envoyResult = {
  error: { message: ENVOY_503_BODY },
  status: 503,
  statusText: "Service Unavailable"
};

describe("classifyQueueRpcFailure", () => {
  it("treats the gateway's 503 as transient (the 2026-08-14 regression)", () => {
    expect(classifyQueueRpcFailure(envoyResult)).toBe("transient");
  });

  it("treats a 502 with an HTML body and no code as transient", () => {
    expect(
      classifyQueueRpcFailure({
        error: { message: "<html><body><h1>502 Bad Gateway</h1></body></html>" },
        status: 502,
        statusText: "Bad Gateway"
      })
    ).toBe("transient");
  });

  it("treats a 504 as transient", () => {
    expect(
      classifyQueueRpcFailure({ error: { message: "gateway timeout" }, status: 504 })
    ).toBe("transient");
  });

  it("treats an undici throw (status 0) as transient", () => {
    expect(
      classifyQueueRpcFailure({
        error: { message: "TypeError: fetch failed (ETIMEDOUT)", code: "" },
        status: 0,
        statusText: ""
      })
    ).toBe("transient");
  });

  it("treats an aborted request (status 0, empty code) as transient", () => {
    expect(
      classifyQueueRpcFailure({
        error: { message: "AbortError: The user aborted a request.", code: "" },
        status: 0
      })
    ).toBe("transient");
  });

  it("treats a missing RPC as a defect so it goes red immediately", () => {
    expect(
      classifyQueueRpcFailure({
        error: {
          code: "PGRST202",
          message: "Could not find the function public.reclaim_stale_chat_jobs"
        },
        status: 404,
        statusText: "Not Found"
      })
    ).toBe("defect");
  });

  it("treats permission denied as a defect", () => {
    expect(
      classifyQueueRpcFailure({
        error: { code: "42501", message: "permission denied for function" },
        status: 403
      })
    ).toBe("defect");
  });

  it("treats an undefined-function SQLSTATE as a defect", () => {
    expect(
      classifyQueueRpcFailure({
        error: { code: "42883", message: "function does not exist" },
        status: 404
      })
    ).toBe("defect");
  });

  it("treats a 4xx with neither code nor network wording as a defect", () => {
    // A bad service-role key is an auth problem, not weather.
    expect(
      classifyQueueRpcFailure({
        error: { message: "Invalid API key" },
        status: 401,
        statusText: "Unauthorized"
      })
    ).toBe("defect");
  });

  it("falls back to the message when no status is present", () => {
    expect(classifyQueueRpcFailure({ error: { message: "TypeError: fetch failed" } })).toBe(
      "transient"
    );
    expect(classifyQueueRpcFailure({ error: { message: ENVOY_503_BODY } })).toBe("transient");
    expect(classifyQueueRpcFailure({ error: { message: "row-level security violation" } })).toBe(
      "defect"
    );
  });

  it("survives a missing or malformed result", () => {
    expect(classifyQueueRpcFailure(null)).toBe("defect");
    expect(classifyQueueRpcFailure(undefined)).toBe("defect");
    expect(classifyQueueRpcFailure({})).toBe("defect");
    expect(classifyQueueRpcFailure({ error: "socket hang up" })).toBe("transient");
    expect(classifyQueueRpcFailure({ error: { message: "x", code: null } })).toBe("defect");
  });
});

describe("isTransientRpcError", () => {
  it("matches the socket-level failures undici throws", () => {
    for (const message of [
      "TypeError: fetch failed",
      "read ECONNRESET",
      "connect ETIMEDOUT 1.2.3.4:443",
      "connect ECONNREFUSED",
      "getaddrinfo EAI_AGAIN db.supabase.co",
      "getaddrinfo ENOTFOUND db.supabase.co",
      "connect ENETUNREACH",
      "connect EHOSTUNREACH",
      "write EPIPE",
      "UND_ERR_SOCKET",
      "socket hang up",
      "network error",
      "The operation was aborted"
    ]) {
      expect(isTransientRpcError(message), message).toBe(true);
    }
  });

  it("matches the proxy-generated failures the old regex missed", () => {
    for (const message of [
      ENVOY_503_BODY,
      "upstream connect error",
      "delayed connect error: 111",
      "disconnect/reset before headers",
      "no healthy upstream",
      "upstream request timeout",
      "connection refused",
      "remote connection failure",
      "connection reset by peer",
      "connection timed out"
    ]) {
      expect(isTransientRpcError(message), message).toBe(true);
    }
  });

  it("does not match a real database error", () => {
    for (const message of [
      "Could not find the function public.reclaim_stale_chat_jobs",
      "permission denied for function reclaim_stale_chat_jobs",
      "new row violates row-level security policy",
      "",
      null,
      undefined
    ]) {
      expect(isTransientRpcError(message), String(message)).toBe(false);
    }
  });
});

describe("describeQueueRpcError", () => {
  it("prefers the error message", () => {
    expect(describeQueueRpcError({ error: { message: "boom" }, statusText: "Bad" })).toBe("boom");
  });

  it("accepts a bare string error", () => {
    expect(describeQueueRpcError({ error: "boom" })).toBe("boom");
  });

  it("falls back to statusText, then to a placeholder", () => {
    expect(describeQueueRpcError({ error: {}, statusText: "Service Unavailable" })).toBe(
      "Service Unavailable"
    );
    expect(describeQueueRpcError(null)).toBe("unknown error");
  });
});

describe("createQueueRpcFailureTracker", () => {
  it("holds a transient failure at warn until it has failed ERROR_AFTER times", () => {
    const tracker = createQueueRpcFailureTracker();
    expect(QUEUE_RPC_ERROR_AFTER).toBe(3);

    const first = tracker.record("reclaim_failed", envoyResult);
    expect(first).toEqual({
      level: "warn",
      event: "reclaim_failed_transient",
      data: { error: ENVOY_503_BODY, consecutiveFailures: 1 }
    });

    expect(tracker.record("reclaim_failed", envoyResult).level).toBe("warn");

    // Third strike: escalate under the original event name so the existing
    // System Errors alerting still fires on sustained connectivity loss.
    expect(tracker.record("reclaim_failed", envoyResult)).toEqual({
      level: "error",
      event: "reclaim_failed",
      data: { error: ENVOY_503_BODY, consecutiveFailures: 3 }
    });
  });

  it("resets the streak when the RPC succeeds", () => {
    const tracker = createQueueRpcFailureTracker();
    tracker.record("reclaim_failed", envoyResult);
    tracker.record("reclaim_failed", envoyResult);
    tracker.clear("reclaim_failed");
    expect(tracker.record("reclaim_failed", envoyResult).level).toBe("warn");
  });

  it("counts each RPC separately", () => {
    const tracker = createQueueRpcFailureTracker();
    tracker.record("reclaim_failed", envoyResult);
    tracker.record("reclaim_failed", envoyResult);
    expect(tracker.record("claim_failed", envoyResult).data.consecutiveFailures).toBe(1);
  });

  it("logs a defect at error on the very first failure, and clears the streak", () => {
    const tracker = createQueueRpcFailureTracker();
    const defect = {
      error: { code: "PGRST202", message: "Could not find the function" },
      status: 404
    };
    tracker.record("reclaim_failed", envoyResult);
    expect(tracker.record("reclaim_failed", defect)).toEqual({
      level: "error",
      event: "reclaim_failed",
      data: { error: "Could not find the function" }
    });
    // The defect reset the counter, so the next transient starts over at warn.
    expect(tracker.record("reclaim_failed", envoyResult).data.consecutiveFailures).toBe(1);
  });

  it("honors nonTransientLevel, which the webchat RPCs set to warn", () => {
    const tracker = createQueueRpcFailureTracker();
    const missingRpc = {
      error: { code: "PGRST202", message: "Could not find the function" },
      status: 404
    };
    expect(
      tracker.record("webchat_claim_failed", missingRpc, { nonTransientLevel: "warn" })
    ).toEqual({
      level: "warn",
      event: "webchat_claim_failed",
      data: { error: "Could not find the function" }
    });
  });

  it("takes a custom escalation threshold", () => {
    const tracker = createQueueRpcFailureTracker({ errorAfter: 1 });
    expect(tracker.record("reclaim_failed", envoyResult).level).toBe("error");
  });
});

describe("queue RPC retry pacing", () => {
  it("keeps the inline retry short enough to stay inside one sweep", () => {
    // WORKER_SWEEP_INTERVAL_MS defaults to 30s; the single retry must not
    // stretch a sweep into the next one.
    expect(QUEUE_RPC_RETRY_MS).toBe(2000);
    expect(QUEUE_RPC_RETRY_MS).toBeLessThan(30_000);
  });
});

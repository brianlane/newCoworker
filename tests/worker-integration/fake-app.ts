/**
 * Minimal fake of the Next.js platform app for worker→app bridge calls made
 * by the served ai-flow-worker. The suite points the worker's
 * AIFLOW_PLATFORM_URL at this server (bound on 0.0.0.0 so the edge runtime
 * container can reach it — same host-gateway mechanics as fake-rowboat).
 *
 * Endpoints:
 *   - POST /api/internal/aiflow-booking-precheck — scripted per test (FIFO):
 *     answer `{ booked }` in the route's success envelope, or an HTTP error
 *     status for the fail-open path. Unscripted calls answer booked:false so
 *     unrelated scenarios never hang on this gate.
 *   - POST /api/internal/aiflow-email-poll / aiflow-calendar-poll — the
 *     worker kicks these fire-and-forget every tick once AIFLOW_PLATFORM_URL
 *     is set; answered 200 so the logs stay quiet.
 */
import { createServer, type Server } from "node:http";

export type RecordedPrecheckCall = {
  authorization: string | null;
  body: { businessId?: string; runId?: string };
};

export type FakeApp = {
  port: number;
  precheckCalls: RecordedPrecheckCall[];
  /** Queue the NEXT precheck answer (FIFO). */
  scriptPrecheck(booked: boolean): void;
  /** Queue an HTTP failure for the NEXT precheck call (FIFO, shared queue). */
  scriptPrecheckError(status: number): void;
  pendingScripts(): number;
  clearScript(): void;
  close(): Promise<void>;
};

/** Fixed port so CI can precompute the container-reachable URL. */
export const FAKE_APP_PORT = Number(process.env.ITEST_FAKE_APP_PORT ?? 8978);

type Scripted = { booked: boolean } | { status: number };

export async function startFakeApp(port = FAKE_APP_PORT): Promise<FakeApp> {
  const precheckCalls: RecordedPrecheckCall[] = [];
  const scripted: Scripted[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const answer = (status: number, payload: unknown) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== "POST") return answer(200, { ok: true });
      if (req.url === "/api/internal/aiflow-booking-precheck") {
        let body: RecordedPrecheckCall["body"] = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          return answer(400, { ok: false });
        }
        precheckCalls.push({ authorization: req.headers.authorization ?? null, body });
        const next = scripted.shift() ?? { booked: false };
        if ("status" in next) {
          return answer(next.status, { ok: false, error: { code: "INTERNAL_SERVER_ERROR" } });
        }
        return answer(200, {
          ok: true,
          data: { booked: next.booked, jumpedRuns: 0, reason: next.booked ? "booked" : "no_booking_found" }
        });
      }
      // Poll kicks and anything else the worker fires at the platform.
      return answer(200, { ok: true, data: {} });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 0.0.0.0: the caller is the supabase edge-runtime CONTAINER.
    server.listen(port, "0.0.0.0", resolve);
  });

  return {
    port,
    precheckCalls,
    scriptPrecheck: (booked: boolean) => {
      scripted.push({ booked });
    },
    scriptPrecheckError: (status: number) => {
      scripted.push({ status });
    },
    pendingScripts: () => scripted.length,
    clearScript: () => {
      scripted.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}

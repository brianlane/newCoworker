/**
 * Minimal fake of a per-tenant Rowboat gateway's POST /chat, spoken exactly
 * per the §10 SMS contract the real sms-inbound-worker consumes
 * (`_shared/sms_rowboat.ts::callRowboatChatOnce` / `parseRowboatChatJson`):
 *
 *   request : { messages: [{role, content}...], stream, conversationId?,
 *               state?, startAgent? } + Authorization bearer
 *   response: { turn: { output: [{ role: "assistant", content }] },
 *               conversationId, state }
 *
 * The integration suite points the served worker's
 * ROWBOAT_CHAT_URL_TEMPLATE at this server (bound on 0.0.0.0 so the edge
 * runtime container can reach it), scripts each turn's assistant reply, and
 * then asserts on BOTH sides: what the worker sent (system preamble, flow
 * context, the [SMS] user line, bearer) and what it persisted after the
 * reply came back (trailer strip, reasoning capture, escalation).
 *
 * Rowboat itself runs per-tenant on fleet VPSes and cannot run in CI; this
 * fake covers the worker↔Rowboat WIRE both ways, while the live-AI e2e
 * suite covers what a real model puts inside the reply.
 */
import { createServer, type Server } from "node:http";

export type RecordedChatCall = {
  authorization: string | null;
  body: {
    messages: Array<{ role: string; content: string }>;
    conversationId?: string;
    state?: unknown;
    startAgent?: string;
    stream?: boolean;
  };
};

export type FakeRowboat = {
  port: number;
  calls: RecordedChatCall[];
  /** Queue the assistant reply for the NEXT /chat call (FIFO). */
  scriptReply(content: string): void;
  close(): Promise<void>;
};

/** Fixed port so CI can precompute the container-reachable URL. */
export const FAKE_ROWBOAT_PORT = Number(process.env.ITEST_FAKE_ROWBOAT_PORT ?? 8977);

const DEFAULT_REPLY = "Thanks! A licensed broker will follow up shortly.";

export async function startFakeRowboat(port = FAKE_ROWBOAT_PORT): Promise<FakeRowboat> {
  const calls: RecordedChatCall[] = [];
  const scripted: string[] = [];
  let turn = 0;

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      // Health probe (GET /) used by the suite's readiness check.
      if (req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      let body: RecordedChatCall["body"];
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400).end("bad json");
        return;
      }
      calls.push({ authorization: req.headers.authorization ?? null, body });
      turn += 1;
      const content = scripted.shift() ?? DEFAULT_REPLY;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          turn: { output: [{ role: "assistant", content }] },
          conversationId: `fake-conv-${turn}`,
          state: { fake: true, turn }
        })
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 0.0.0.0: the caller is the supabase edge-runtime CONTAINER, not
    // localhost — the suite passes the host's container-reachable address
    // via ROWBOAT_CHAT_URL_TEMPLATE.
    server.listen(port, "0.0.0.0", resolve);
  });

  return {
    port,
    calls,
    scriptReply: (content: string) => {
      scripted.push(content);
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve()))
      )
  };
}

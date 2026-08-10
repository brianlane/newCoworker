/**
 * The Slack Events API receiver (/api/webhooks/slack).
 *
 * Signature verification runs against REAL HMACs here (no mocking of the
 * webhook lib): what's pinned is the boundary itself: unsigned traffic is
 * refused, authentic-but-unknown payloads answer 200 so Slack never backs
 * off, url_verification echoes the raw challenge, and an uninstall wipes
 * the tenant's dead token (with a 500 asking for redelivery if that write
 * fails).
 */
import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/db/slack-connections", () => ({
  markSlackConnectionDeauthorizedByTeamId: vi.fn()
}));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { POST } from "@/app/api/webhooks/slack/route";
import { markSlackConnectionDeauthorizedByTeamId } from "@/lib/db/slack-connections";
import { SLACK_WEBHOOK_MAX_BODY_BYTES } from "@/lib/slack/webhook";

const SECRET = "signing-secret-abc";

function signedRequest(rawBody: string, opts?: { timestampSec?: number; signature?: string }) {
  const ts = opts?.timestampSec ?? Math.floor(Date.now() / 1000);
  const signature =
    opts?.signature ??
    `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${rawBody}`).digest("hex")}`;
  return new Request("https://x/api/webhooks/slack", {
    method: "POST",
    headers: {
      "x-slack-request-timestamp": String(ts),
      "x-slack-signature": signature
    },
    body: rawBody
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("SLACK_SIGNING_SECRET", SECRET);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("POST /api/webhooks/slack", () => {
  it("refuses unsigned and mis-signed deliveries", async () => {
    const body = JSON.stringify({ type: "event_callback" });
    const unsigned = new Request("https://x/api/webhooks/slack", { method: "POST", body });
    expect((await POST(unsigned)).status).toBe(401);

    const misSigned = signedRequest(body, { signature: "v0=deadbeef" });
    expect((await POST(misSigned)).status).toBe(401);
  });

  it("413s an oversized body before any parsing", async () => {
    const big = "x".repeat(SLACK_WEBHOOK_MAX_BODY_BYTES + 1);
    expect((await POST(signedRequest(big))).status).toBe(413);
  });

  it("400s signed-but-not-JSON, 200s signed-but-unknown shapes", async () => {
    expect((await POST(signedRequest("not json"))).status).toBe(400);

    const unknown = await POST(signedRequest(JSON.stringify({ type: "weird" })));
    expect(unknown.status).toBe(200);
    expect(await unknown.json()).toMatchObject({ data: { ignored: true } });
  });

  it("echoes the url_verification challenge as raw text", async () => {
    const res = await POST(
      signedRequest(JSON.stringify({ type: "url_verification", challenge: "ch-42" }))
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/plain/);
    expect(await res.text()).toBe("ch-42");
  });

  it.each(["app_uninstalled", "tokens_revoked"])(
    "wipes the workspace token on %s",
    async (type) => {
      const res = await POST(
        signedRequest(
          JSON.stringify({
            type: "event_callback",
            team_id: "T-1",
            event_id: "Ev-1",
            event: { type }
          })
        )
      );
      expect(res.status).toBe(200);
      expect(vi.mocked(markSlackConnectionDeauthorizedByTeamId)).toHaveBeenCalledWith("T-1");
    }
  );

  it("answers 500 when the deauthorize write fails, so Slack redelivers", async () => {
    vi.mocked(markSlackConnectionDeauthorizedByTeamId).mockRejectedValue(new Error("db down"));
    const res = await POST(
      signedRequest(
        JSON.stringify({
          type: "event_callback",
          team_id: "T-1",
          event: { type: "app_uninstalled" }
        })
      )
    );
    expect(res.status).toBe(500);
  });

  it("200-noops chat events until the two-way-chat PR gives them handlers", async () => {
    const res = await POST(
      signedRequest(
        JSON.stringify({
          type: "event_callback",
          team_id: "T-1",
          event: { type: "message", channel_type: "im", text: "hi" }
        })
      )
    );
    expect(res.status).toBe(200);
    expect(vi.mocked(markSlackConnectionDeauthorizedByTeamId)).not.toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { ElevenLabsClient } from "@/lib/elevenlabs/client";

describe("elevenlabs client", () => {
  it("creates secret", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ secret_id: "sec_1" })));
    const client = new ElevenLabsClient("api-key", fetchMock as any);
    await expect(client.createSecret("openclaw_gateway_token", "abc")).resolves.toEqual({
      secret_id: "sec_1"
    });
  });

  it("creates agent", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ agent_id: "ag_1" })));
    const client = new ElevenLabsClient("api-key", fetchMock as any);
    await expect(client.createAgent("https://mock/v1/chat/completions", "sec_1")).resolves.toEqual({
      agent_id: "ag_1"
    });
  });

  it("throws on api error", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new ElevenLabsClient("api-key", fetchMock as any);
    await expect(client.createSecret("a", "b")).rejects.toThrow("ElevenLabs API error: 401");
  });
});

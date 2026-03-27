import { describe, expect, it, vi } from "vitest";
import { InworldClient, INWORLD_TTS_MODEL } from "@/lib/inworld/client";

describe("inworld client", () => {
  it("createVoiceAgent returns agent_id", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ agent_id: "inworld-agent-1" }))
    );
    const client = new InworldClient("api-key", fetchMock as any);
    const result = await client.createVoiceAgent("TestAgent");
    expect(result).toEqual({ agent_id: "inworld-agent-1" });
  });

  it("createVoiceAgent sends correct model and default voice", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ agent_id: "ag_2" }))
    );
    const client = new InworldClient("api-key", fetchMock as any);
    await client.createVoiceAgent("MyAgent");

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe(INWORLD_TTS_MODEL);
    expect(body.voice_id).toBe("default");
    expect(body.name).toBe("MyAgent");
  });

  it("createVoiceAgent uses provided voiceId", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ agent_id: "ag_3" }))
    );
    const client = new InworldClient("api-key", fetchMock as any);
    await client.createVoiceAgent("MyAgent", "voice-xyz");

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.voice_id).toBe("voice-xyz");
  });

  it("synthesize returns ArrayBuffer on success", async () => {
    const buffer = new ArrayBuffer(8);
    const fetchMock = vi.fn(async () => {
      const response = new Response(buffer);
      Object.defineProperty(response, "ok", { value: true });
      Object.defineProperty(response, "arrayBuffer", {
        value: async () => buffer
      });
      return response;
    });
    const client = new InworldClient("api-key", fetchMock as any);
    const result = await client.synthesize("Hello world", "voice-1");
    expect(result).toBe(buffer);
  });

  it("synthesize uses default model when not provided", async () => {
    const buffer = new ArrayBuffer(4);
    const fetchMock = vi.fn(async () => {
      const response = new Response(buffer);
      Object.defineProperty(response, "ok", { value: true });
      Object.defineProperty(response, "arrayBuffer", {
        value: async () => buffer
      });
      return response;
    });
    const client = new InworldClient("api-key", fetchMock as any);
    await client.synthesize("Hi", "voice-1");

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe(INWORLD_TTS_MODEL);
  });

  it("synthesize uses custom model when provided", async () => {
    const buffer = new ArrayBuffer(4);
    const fetchMock = vi.fn(async () => {
      const response = new Response(buffer);
      Object.defineProperty(response, "ok", { value: true });
      Object.defineProperty(response, "arrayBuffer", {
        value: async () => buffer
      });
      return response;
    });
    const client = new InworldClient("api-key", fetchMock as any);
    await client.synthesize("Hi", "voice-1", "inworld-tts-1.5-mini");

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse((options as RequestInit).body as string);
    expect(body.model).toBe("inworld-tts-1.5-mini");
  });

  it("synthesize throws on api error", async () => {
    const fetchMock = vi.fn(async () => new Response("nope", { status: 401 }));
    const client = new InworldClient("api-key", fetchMock as any);
    await expect(client.synthesize("text", "voice-1")).rejects.toThrow(
      "inworld.ai API error: 401"
    );
  });

  it("createVoiceAgent throws on api error", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("unauthorized", { status: 403 })
    );
    const client = new InworldClient("api-key", fetchMock as any);
    await expect(client.createVoiceAgent("BadAgent")).rejects.toThrow(
      "inworld.ai API error: 403"
    );
  });

  it("streamWebSocket returns endpoint url", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ endpoint: "wss://stream.inworld.ai/v1/agent-1" })
      )
    );
    const client = new InworldClient("api-key", fetchMock as any);
    const result = await client.streamWebSocket("agent-1");
    expect(result).toBe("wss://stream.inworld.ai/v1/agent-1");
  });

  it("streamWebSocket throws on api error", async () => {
    const fetchMock = vi.fn(async () =>
      new Response("not found", { status: 404 })
    );
    const client = new InworldClient("api-key", fetchMock as any);
    await expect(client.streamWebSocket("bad-agent")).rejects.toThrow(
      "inworld.ai API error: 404"
    );
  });

  it("sends Authorization header with api key", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ agent_id: "ag_auth" }))
    );
    const client = new InworldClient("my-secret-key", fetchMock as any);
    await client.createVoiceAgent("Agent");

    const [, options] = fetchMock.mock.calls[0];
    const headers = (options as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer my-secret-key");
  });

  it("INWORLD_TTS_MODEL is the mini model", () => {
    expect(INWORLD_TTS_MODEL).toBe("inworld-tts-1.5-mini");
  });
});

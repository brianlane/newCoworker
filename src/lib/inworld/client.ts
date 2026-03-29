type FetchLike = typeof fetch;

export const INWORLD_TTS_MODEL = "inworld-tts-1.5-mini";

export type InworldVoiceAgent = {
  agent_id: string;
};

export type InworldSynthesisResult = ArrayBuffer;

export class InworldClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async createVoiceAgent(
    name: string,
    voiceId?: string
  ): Promise<InworldVoiceAgent> {
    const response = await this.fetchImpl(
      "https://api.inworld.ai/v1/voice/agents",
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          name,
          model: INWORLD_TTS_MODEL,
          voice_id: voiceId ?? "default"
        })
      }
    );

    return this.parseJson<InworldVoiceAgent>(response);
  }

  async synthesize(
    text: string,
    voiceId: string,
    model?: string
  ): Promise<InworldSynthesisResult> {
    const response = await this.fetchImpl(
      "https://api.inworld.ai/v1/voice/synthesize",
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          text,
          voice_id: voiceId,
          model: model ?? INWORLD_TTS_MODEL
        })
      }
    );

    if (!response.ok) {
      throw new Error(`inworld.ai API error: ${response.status}`);
    }

    return response.arrayBuffer();
  }

  async streamWebSocket(agentId: string): Promise<string> {
    // Returns the WebSocket endpoint URL for real-time voice streaming
    // The caller connects to this URL directly (browser or Twilio media stream)
    const response = await this.fetchImpl(
      `https://api.inworld.ai/v1/voice/agents/${agentId}/stream`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ protocol: "twilio" })
      }
    );

    const json = await this.parseJson<{ endpoint: string }>(response);
    return json.endpoint;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json"
    };
  }

  private async parseJson<T>(response: Response): Promise<T> {
    if (!response.ok) {
      throw new Error(`inworld.ai API error: ${response.status}`);
    }
    return (await response.json()) as T;
  }
}

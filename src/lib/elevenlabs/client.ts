type FetchLike = typeof fetch;

export class ElevenLabsClient {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async createSecret(name: string, value: string): Promise<{ secret_id: string }> {
    const response = await this.fetchImpl("https://api.elevenlabs.io/v1/convai/secrets", {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ type: "new", name, value })
    });

    return this.parseJson(response);
  }

  async createAgent(customLlmUrl: string, secretId: string): Promise<{ agent_id: string }> {
    const response = await this.fetchImpl(
      "https://api.elevenlabs.io/v1/convai/agents/create",
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          conversation_config: {
            agent: {
              language: "en",
              prompt: {
                llm: "custom-llm",
                prompt: "You are a helpful AI coworker.",
                custom_llm: {
                  url: customLlmUrl,
                  api_key: { secret_id: secretId }
                }
              }
            }
          }
        })
      }
    );

    return this.parseJson(response);
  }

  private headers() {
    return {
      "xi-api-key": this.apiKey,
      "Content-Type": "application/json"
    };
  }

  private async parseJson(response: Response) {
    if (!response.ok) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    return (await response.json()) as any;
  }
}

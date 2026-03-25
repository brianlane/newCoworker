export type HostingerMetrics = {
  cpuPercent: number;
  ramPercent: number;
};

type FetchLike = typeof fetch;

export class HostingerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async provisionVps(plan: string, snapshotId: string): Promise<{ vpsId: string }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/vps/provision`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({ plan, snapshotId })
    });
    return this.parseJson(response);
  }

  async rebootVps(vpsId: string): Promise<{ ok: true }> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/vps/${vpsId}/reboot`, {
      method: "POST",
      headers: this.headers()
    });
    return this.parseJson(response);
  }

  async getMetrics(vpsId: string): Promise<HostingerMetrics> {
    const response = await this.fetchImpl(`${this.baseUrl}/v1/vps/${vpsId}/metrics`, {
      method: "GET",
      headers: this.headers()
    });
    return this.parseJson(response);
  }

  private headers() {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "application/json"
    };
  }

  private async parseJson(response: Response) {
    if (!response.ok) {
      throw new Error(`Hostinger API error: ${response.status}`);
    }

    return (await response.json()) as any;
  }
}

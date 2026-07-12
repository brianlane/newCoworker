/**
 * Telnyx account balance (GET /v2/balance) for the admin Costs page
 * header — the number the operator otherwise opens the Telnyx portal for.
 * Read-only and best-effort: any failure returns null and the page renders
 * without it.
 */

export type TelnyxBalance = {
  balanceUsd: number;
  pendingUsd: number | null;
  currency: string;
};

export async function fetchTelnyxBalance(
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxBalance | null> {
  if (!apiKey) return null;
  try {
    const res = await fetchImpl("https://api.telnyx.com/v2/balance", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: { balance?: string | number; pending?: string | number; currency?: string };
    };
    const balance = Number(body.data?.balance);
    if (!Number.isFinite(balance)) return null;
    const pending = Number(body.data?.pending);
    return {
      balanceUsd: balance,
      pendingUsd: Number.isFinite(pending) ? pending : null,
      currency: typeof body.data?.currency === "string" ? body.data.currency : "USD"
    };
  } catch {
    return null;
  }
}

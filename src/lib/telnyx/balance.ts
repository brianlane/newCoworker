/**
 * Telnyx account balance (GET /v2/balance) and auto-recharge prefs
 * (GET /v2/payment/auto_recharge_prefs) for the admin Costs page header.
 * The balance is the number the operator otherwise opens the Telnyx portal
 * for; the prefs explain why a charge hits the card after a quiet week
 * (it is a $2 floor on a $28 prepaid bucket, not a weekly bill).
 * Read-only and best-effort: any failure returns null and the page renders
 * without that piece.
 */

export type TelnyxBalance = {
  balanceUsd: number;
  pendingUsd: number | null;
  currency: string;
};

export type TelnyxAutoRechargePrefs = {
  enabled: boolean;
  thresholdUsd: number;
  rechargeUsd: number;
  /** Telnyx `preference`, e.g. `credit_paypal`. Null when absent. */
  preference: string | null;
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

export async function fetchTelnyxAutoRechargePrefs(
  apiKey: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<TelnyxAutoRechargePrefs | null> {
  if (!apiKey) return null;
  try {
    const res = await fetchImpl("https://api.telnyx.com/v2/payment/auto_recharge_prefs", {
      headers: { Authorization: `Bearer ${apiKey}` }
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      data?: {
        enabled?: boolean;
        threshold_amount?: string | number;
        recharge_amount?: string | number;
        preference?: string;
      };
    };
    const thresholdUsd = Number(body.data?.threshold_amount);
    const rechargeUsd = Number(body.data?.recharge_amount);
    if (!Number.isFinite(thresholdUsd) || !Number.isFinite(rechargeUsd)) return null;
    return {
      enabled: body.data?.enabled === true,
      thresholdUsd,
      rechargeUsd,
      preference: typeof body.data?.preference === "string" ? body.data.preference : null
    };
  } catch {
    return null;
  }
}

/** One-line Costs-page caption for live auto-recharge prefs. */
export function formatAutoRechargeLine(prefs: TelnyxAutoRechargePrefs): string {
  if (!prefs.enabled) return "auto-recharge off";
  const via =
    prefs.preference === "credit_paypal"
      ? " via PayPal"
      : prefs.preference === "credit_card"
        ? " via card"
        : "";
  return (
    `auto-recharge $${prefs.rechargeUsd.toFixed(2)} when below ` +
    `$${prefs.thresholdUsd.toFixed(2)}${via}`
  );
}

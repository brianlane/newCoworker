/**
 * International SMS gateway helpers (Deno lockstep copy).
 *
 * Mirror of `src/lib/telnyx/international-gateway.ts` plus the two helpers
 * only the edge workers need: recipient partitioning for group MMS (which
 * must stay domestic; the P2P gateway cannot carry MMS) and the inbound
 * resolver that maps a reply arriving AT the shared gateway number back to
 * its tenant. See the src file for the full rationale.
 */

import { smsDestinationCountry } from "./sms_destination_rates.ts";

/** Environment read that works in both Deno (edge) and Node (vitest). */
function readEnvVar(name: string): string | undefined {
  const deno = (globalThis as { Deno?: { env?: { get?: (n: string) => string | undefined } } })
    .Deno;
  if (deno?.env?.get) return deno.env.get(name);
  return (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
    name
  ];
}

/** Domestic = US/CA, the countries A2P long codes can originate to. */
export function isInternationalSmsDestination(country: string | null): boolean {
  return country !== "US" && country !== "CA";
}

/** The dedicated P2P gateway from-number, or null when not configured. */
export function internationalGatewayFrom(
  env?: Record<string, string | undefined>
): string | null {
  const v = (env ? env.TELNYX_INTL_GATEWAY_E164 : readEnvVar("TELNYX_INTL_GATEWAY_E164"))?.trim() ?? "";
  return v.length > 0 ? v : null;
}

/**
 * From-number for one outbound send: the gateway when the destination is
 * international and a gateway is configured, otherwise the tenant's own
 * number. Central rule for every sender, raw-fetch sites included.
 */
export function resolveInternationalFrom(
  toE164: string,
  tenantFrom: string | null | undefined,
  env?: Record<string, string | undefined>
): string | null {
  if (isInternationalSmsDestination(smsDestinationCountry(toE164))) {
    const gateway = internationalGatewayFrom(env);
    if (gateway) return gateway;
  }
  return tenantFrom ?? null;
}

/**
 * Machine-readable skip reason for a step that could only deliver as an
 * international MMS (the gateway is text-only; A2P numbers cannot reach the
 * destination). Surfaced in step results and flow autopsies.
 */
export const INTERNATIONAL_MMS_SKIP_REASON = "international_mms_unsupported";

/**
 * Machine-readable skip reason for a text whose destination is international
 * while no P2P gateway is configured: the send has no route at all (tenant
 * A2P long codes are domestic-only, Telnyx ticket #557577), so the step
 * skips instead of dying on the carrier's guaranteed permanent rejection.
 * Surfaced in step results, flow autopsies, and the per-business system log.
 */
export const INTERNATIONAL_SMS_NO_GATEWAY_SKIP_REASON = "international_sms_no_gateway";

/**
 * Split group-send recipients into domestic (can ride the tenant's group
 * MMS) and international (cannot: group sends are MMS-billed and the
 * gateway is text-only). Unresolvable numbers count as international so a
 * bad entry can never sneak into a billed group leg.
 */
export function partitionInternationalSmsRecipients(recipients: string[]): {
  domestic: string[];
  international: string[];
} {
  const domestic: string[] = [];
  const international: string[] = [];
  for (const r of recipients) {
    if (isInternationalSmsDestination(smsDestinationCountry(r))) international.push(r);
    else domestic.push(r);
  }
  return { domestic, international };
}

type Row = { data: unknown; error: { message: string } | null };

export interface GatewayInboundSupabase {
  from(table: string): {
    select(columns: string): {
      eq(
        column: string,
        value: string
      ): {
        maybeSingle(): PromiseLike<Row>;
        order(
          column: string,
          opts: { ascending: boolean }
        ): { limit(n: number): PromiseLike<Row> };
      };
    };
  };
}

export type GatewayInboundMatch = {
  businessId: string;
  matchedBy: "forward_to_e164" | "notification_phone" | "business_phone" | "recent_outbound";
};

/**
 * Map an inbound message arriving AT the shared gateway number back to its
 * tenant, from the SENDER's number. Owner columns first (a reply from an
 * international owner, the primary use), then the most recent outbound
 * conversation with that number. Null when nothing matches; the caller
 * parks the message and writes an ops log instead of guessing.
 *
 * Known limit, accepted for the shared-gateway v1: when two tenants both
 * text the same foreign number, recent_outbound picks the most recent
 * conversation. Tenants with real international customer volume get a
 * dedicated P2P number, which restores exact per-number routing.
 */
export async function resolveGatewayInboundBusiness(
  supabase: GatewayInboundSupabase,
  fromE164: string
): Promise<GatewayInboundMatch | null> {
  const { data: fwd } = await supabase
    .from("business_telnyx_settings")
    .select("business_id")
    .eq("forward_to_e164", fromE164)
    .maybeSingle();
  const fwdRow = fwd as { business_id?: string } | null;
  if (fwdRow?.business_id) {
    return { businessId: fwdRow.business_id, matchedBy: "forward_to_e164" };
  }

  const { data: prefs } = await supabase
    .from("notification_preferences")
    .select("business_id")
    .eq("phone_number", fromE164)
    .maybeSingle();
  const prefsRow = prefs as { business_id?: string } | null;
  if (prefsRow?.business_id) {
    return { businessId: prefsRow.business_id, matchedBy: "notification_phone" };
  }

  const { data: biz } = await supabase
    .from("businesses")
    .select("id")
    .eq("phone", fromE164)
    .maybeSingle();
  const bizRow = biz as { id?: string } | null;
  if (bizRow?.id) {
    return { businessId: bizRow.id, matchedBy: "business_phone" };
  }

  const { data: log } = await supabase
    .from("sms_outbound_log")
    .select("business_id")
    .eq("to_e164", fromE164)
    .order("created_at", { ascending: false })
    .limit(1);
  const rows = (log as Array<{ business_id?: string }> | null) ?? [];
  if (rows[0]?.business_id) {
    return { businessId: rows[0].business_id, matchedBy: "recent_outbound" };
  }

  return null;
}

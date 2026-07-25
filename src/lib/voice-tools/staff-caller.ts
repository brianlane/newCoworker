/**
 * Is this caller the business's own staff (owner or an active team member)?
 *
 * Voice tools that act on the BUSINESS rather than for the caller (starting an
 * automation, for instance) must never be usable by a customer who simply asks
 * for them on the phone. The voice tool envelope carries `callerE164`
 * (src/lib/voice-tools/common.ts), so unlike the Rowboat webhook the platform
 * can resolve caller identity server-side and refuse anyone who is not staff.
 *
 * Mirrors the two other gates that answer this same question, deliberately
 * using the same number sources so the three cannot disagree:
 *   - telnyx-sms-inbound's staff gate (owner-configured numbers + roster), and
 *   - the voice bridge's own `resolveCallerIdentity` (which withholds the tool
 *     DECLARATION from customers; this is the server-side half of that pair).
 *
 * Fails CLOSED: an unknown number, a missing caller id, or any read error
 * answers false. Refusing a real owner's request is recoverable (they hear an
 * honest "I can't start that from a call"); letting a stranger start a tenant's
 * automations is not.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { coerceOwnerPhoneToE164 } from "@/lib/phone/e164";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type StaffCaller = { kind: "owner" | "team"; name: string | null };

/**
 * Resolve a caller to staff, or null when they are not (or cannot be proven to
 * be) staff. Owner precedence matches every other surface: a number that is
 * both an owner number and a roster row reads as "owner".
 */
export async function resolveStaffCaller(
  businessId: string,
  callerE164: string | null | undefined,
  client?: SupabaseClient
): Promise<StaffCaller | null> {
  const caller = coerceOwnerPhoneToE164(callerE164 ?? "");
  if (!caller) return null;
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const [bizRes, telnyxRes, prefsRes, teamRes] = await Promise.all([
      db.from("businesses").select("owner_name, phone").eq("id", businessId).maybeSingle(),
      db
        .from("business_telnyx_settings")
        .select("forward_to_e164")
        .eq("business_id", businessId)
        .maybeSingle(),
      db
        .from("notification_preferences")
        .select("phone_number")
        .eq("business_id", businessId)
        .maybeSingle(),
      db
        .from("ai_flow_team_members")
        .select("name, phone_e164")
        .eq("business_id", businessId)
        .eq("active", true)
    ]);
    for (const res of [bizRes, telnyxRes, prefsRes, teamRes]) {
      if (res.error) throw new Error(res.error.message);
    }
    const biz = bizRes.data as { owner_name?: string | null; phone?: string | null } | null;
    const ownerNumbers = [
      biz?.phone,
      (telnyxRes.data as { forward_to_e164?: string | null } | null)?.forward_to_e164,
      (prefsRes.data as { phone_number?: string | null } | null)?.phone_number
    ]
      .map((n) => coerceOwnerPhoneToE164(n ?? ""))
      .filter((n): n is string => Boolean(n));
    if (ownerNumbers.includes(caller)) {
      return { kind: "owner", name: biz?.owner_name?.trim() || null };
    }
    const roster = (teamRes.data as Array<{ name?: string | null; phone_e164?: string | null }>) ?? [];
    for (const member of roster) {
      if (coerceOwnerPhoneToE164(member.phone_e164 ?? "") === caller) {
        return { kind: "team", name: member.name?.trim() || null };
      }
    }
    return null;
  } catch (err) {
    logger.warn("resolveStaffCaller failed; treating caller as not staff", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

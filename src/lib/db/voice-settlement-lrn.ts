/**
 * Apply Terminating LRN / zone-weight stamps from Telnyx sip-trunking MDRs
 * onto `voice_settlements`. Hangup usually omits LRN, so the daily cost
 * sync is the honest fill path. Prefer call_control_id; fall back to
 * call_leg_id. Never fuzzy-match on dialed number + time.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { VoiceSettlementLrnUpdate } from "@/lib/admin/cost-sync";
import { VOICE_ALLOWANCE_WEIGHT_STORE_MAX } from "@/lib/plans/voice-zone-rates";

type SettlementLrnClient = {
  from: (table: string) => {
    select: (columns: string) => {
      eq: (
        column: string,
        value: string
      ) => {
        maybeSingle: () => Promise<{
          data: { call_control_id: string } | null;
          error: { message: string } | null;
        }>;
      };
    };
  };
  rpc: (
    fn: string,
    args: Record<string, unknown>
  ) => Promise<{ data: unknown; error: { message: string } | null }>;
};

export async function applyVoiceSettlementLrnUpdates(
  updates: VoiceSettlementLrnUpdate[],
  client?: SettlementLrnClient
): Promise<{ applied: number; skipped: number }> {
  if (updates.length === 0) return { applied: 0, skipped: 0 };
  const db = client ?? (await createSupabaseServiceClient());
  let applied = 0;
  let skipped = 0;
  for (const update of updates) {
    let callControlId = update.callControlId;
    if (!callControlId && update.callLegId) {
      const { data, error } = await db
        .from("voice_settlements")
        .select("call_control_id")
        .eq("telnyx_call_leg_id", update.callLegId)
        .maybeSingle();
      if (error || !data?.call_control_id) {
        skipped += 1;
        continue;
      }
      callControlId = data.call_control_id;
    }
    if (!callControlId) {
      skipped += 1;
      continue;
    }
    const { error } = await db.rpc("voice_apply_settlement_lrn", {
      p_call_control_id: callControlId,
      p_terminating_lrn: update.terminatingLrn,
      p_zone_weight: Math.min(
        VOICE_ALLOWANCE_WEIGHT_STORE_MAX,
        Math.max(1, update.zoneWeight)
      )
    });
    if (error) {
      skipped += 1;
      continue;
    }
    applied += 1;
  }
  return { applied, skipped };
}

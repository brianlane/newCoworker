type RpcSupabase = {
  // PromiseLike (not Promise) so supabase-js's thenable PostgrestFilterBuilder
  // satisfies the interface structurally (same approach as _shared/cap_alerts.ts).
  rpc: (
    fn: string,
    args?: Record<string, unknown>
  ) => PromiseLike<{ error: { message: string } | null }>;
};

export async function telemetryRecord(
  supabase: RpcSupabase,
  eventType: string,
  payload?: Record<string, unknown>
): Promise<void> {
  const { error } = await supabase.rpc("telemetry_record", {
    p_event_type: eventType,
    p_payload: payload ?? {}
  });
  if (error) {
    console.error("telemetry_record", eventType, error);
  }
}

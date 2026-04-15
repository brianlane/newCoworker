type RpcSupabase = {
  rpc: (
    fn: string,
    args?: Record<string, unknown>
  ) => Promise<{ error: { message: string } | null }>;
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

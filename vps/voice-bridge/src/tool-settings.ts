/**
 * Settings → Coworker tools enforcement for BRIDGE-LOCAL voice tools.
 *
 * Most voice tools are HTTP-proxied to `/api/voice/tools/*`, where
 * `agentToolDisabledResponse` already gates them on the owner's
 * `agent_tool_settings` row. A bridge-local tool (handled on the box, never
 * leaving it) has no such chokepoint, so without this read the Settings toggle
 * would be decoration: the page would offer a switch that changed nothing.
 *
 * Semantics deliberately mirror `isAgentToolEnabled`
 * (src/lib/db/agent-tool-settings.ts): a MISSING row means "use the registry
 * default", and a READ ERROR also resolves to the registry default, so a
 * transient DB blip never flips behavior away from what the owner expects
 * mid-call. The default is passed in rather than imported, because the bridge is
 * rsynced to the VPS standalone and cannot import the app's registry.
 *
 * Kept dependency-free in its own module so repo-root tests and typecheck can
 * import it without the bridge's VPS-only runtime deps.
 */

// Minimal structural client, mirroring the other bridge helpers.
type AnyClient = any;

export async function isBridgeToolEnabled(
  supabase: AnyClient,
  input: {
    businessId: string;
    /** Registry surface key. Bridge-local voice tools are always "voice". */
    agentKey: string;
    toolKey: string;
    /** The registry's `defaultEnabled` for this tool. */
    defaultEnabled: boolean;
  }
): Promise<boolean> {
  try {
    const { data, error } = await supabase
      .from("agent_tool_settings")
      .select("enabled")
      .eq("business_id", input.businessId)
      .eq("agent_key", input.agentKey)
      .eq("tool_key", input.toolKey)
      .maybeSingle();
    if (error) {
      console.error("tool-settings: read failed, using registry default", error);
      return input.defaultEnabled;
    }
    const row = data as { enabled?: boolean | null } | null;
    if (row === null || typeof row.enabled !== "boolean") return input.defaultEnabled;
    return row.enabled;
  } catch (e) {
    console.error("tool-settings: read threw, using registry default", e);
    return input.defaultEnabled;
  }
}

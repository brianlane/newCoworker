/**
 * Everything an owner-surface turn needs to know about the business before
 * it can build a prompt: the tool toggles, the grounding blocks, the MCP
 * bridge, and the spend fuse.
 *
 * Extracted when WhatsApp became the third caller. owner-sms-turn and
 * slack/worker each assemble this themselves today; the shape here is
 * theirs, so they can adopt it without changing behavior.
 *
 * Every grounding read is best-effort by construction (the underlying
 * builders return null on failure), because a missing context block costs
 * the model some grounding while a failed turn costs the owner their
 * answer.
 */

import { getAgentToolStates } from "@/lib/db/agent-tool-settings";
import { getPublicWhatsAppConnection } from "@/lib/db/whatsapp-connections";
import { getChatSpendSnapshotForBusiness } from "@/lib/db/chat-usage";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  buildBusinessContextBlock,
  buildIntegrationsStatusLine
} from "@/lib/dashboard-chat/context-blocks";
import { buildMcpBridgeExtraTools } from "@/lib/dashboard-chat/mcp-bridge";
import { bookingLinkPromptLine } from "@/lib/booking-page/prompt-line";
import type { PlanTier } from "@/lib/plans/tier";
import type { OwnerSurfaceToolStates } from "./gates";
import type { SurfaceSpeaker } from "./speaker";
import type { OwnerTurnSurface } from "./turn-surfaces";

/** The settings keys every owner surface reads, in one batched query. */
export const OWNER_SURFACE_SETTING_KEYS = [
  "business_knowledge_lookup",
  "send_sms",
  "send_whatsapp",
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist",
  "run_aiflow",
  "edit_aiflow",
  "update_notification_preferences",
  "flag_contact_spam",
  "set_contact_reply_mode",
  "manage_employee",
  "custom_table_read",
  "custom_table_write",
  "custom_table_manage",
  "send_email",
  "read_business_data",
  "manage_contacts",
  "manage_flows",
  "manage_agents",
  "update_business_profile",
  "update_business_knowledge",
  "manage_coworker_tools"
] as const;

export type OwnerSurfaceContext = {
  timezone: string | null;
  tier: PlanTier | null;
  ownerEmail: string | null;
  knowledgeToolEnabled: boolean;
  emailToolEnabled: boolean;
  toolStates: OwnerSurfaceToolStates;
  whatsappConnected: boolean;
  integrationsLine: string | null;
  bookingLinkLine: string | null;
  businessContextBlock: string | null;
  bridgeExtraTools: ReturnType<typeof buildMcpBridgeExtraTools> | null;
  /** True when the business is over its shared AI spend cap. */
  overCap: boolean;
};

export type OwnerSurfaceContextDeps = {
  fetchToolStates?: typeof getAgentToolStates;
  fetchWhatsAppConnection?: typeof getPublicWhatsAppConnection;
  fetchSpend?: typeof getChatSpendSnapshotForBusiness;
  fetchMeta?: (businessId: string) => Promise<BusinessMetaRow>;
  buildIntegrations?: typeof buildIntegrationsStatusLine;
  buildContextBlock?: typeof buildBusinessContextBlock;
  buildBookingLink?: typeof bookingLinkPromptLine;
  buildBridge?: typeof buildMcpBridgeExtraTools;
};

export type BusinessMetaRow = {
  timezone: string | null;
  tier: PlanTier | null;
  ownerEmail: string | null;
};

/** Business timezone (date line), tier (cap sizing), owner email (bridge). */
export async function readOwnerSurfaceMeta(businessId: string): Promise<BusinessMetaRow> {
  try {
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("timezone, tier, owner_email")
      .eq("id", businessId)
      .maybeSingle();
    const row = data as
      | { timezone?: unknown; tier?: unknown; owner_email?: unknown }
      | null;
    return {
      timezone: typeof row?.timezone === "string" ? row.timezone : null,
      tier: typeof row?.tier === "string" ? (row.tier as PlanTier) : null,
      ownerEmail:
        typeof row?.owner_email === "string" && row.owner_email.trim() !== ""
          ? row.owner_email
          : null
    };
  } catch {
    return { timezone: null, tier: null, ownerEmail: null };
  }
}

export type OwnerSurfaceContextOptions = {
  /**
   * The business row this load needs, when the caller has already read it.
   * Slack reads `businesses` for the owner's UI locale before the turn
   * starts; without this the load below would read the very same row a
   * second time on every message.
   */
  meta?: BusinessMetaRow;
  /**
   * Audit identity recorded against MCP-bridged tool calls. Slack has a
   * real per-user id (`slack:U123`) and passing it keeps the bridge's
   * attribution specific; surfaces with no such id get the generic
   * `<surface>-owner-operator` below.
   */
  bridgeUserId?: string;
};

export async function loadOwnerSurfaceContext(
  businessId: string,
  surface: OwnerTurnSurface,
  speaker: SurfaceSpeaker,
  deps: OwnerSurfaceContextDeps = {},
  opts: OwnerSurfaceContextOptions = {}
): Promise<OwnerSurfaceContext> {
  /* c8 ignore start -- production defaults; tests inject */
  const fetchToolStates = deps.fetchToolStates ?? getAgentToolStates;
  const fetchWhatsAppConnection = deps.fetchWhatsAppConnection ?? getPublicWhatsAppConnection;
  const fetchSpend = deps.fetchSpend ?? getChatSpendSnapshotForBusiness;
  const fetchMeta = deps.fetchMeta ?? readOwnerSurfaceMeta;
  const buildIntegrations = deps.buildIntegrations ?? buildIntegrationsStatusLine;
  const buildContextBlock = deps.buildContextBlock ?? buildBusinessContextBlock;
  const buildBookingLink = deps.buildBookingLink ?? bookingLinkPromptLine;
  const buildBridge = deps.buildBridge ?? buildMcpBridgeExtraTools;
  /* c8 ignore stop */

  const meta = opts.meta ?? (await fetchMeta(businessId));

  const [states, integrationsLine, businessContextBlock, bookingLinkLine, connection, spend] =
    await Promise.all([
      fetchToolStates(businessId, surface.toolGateAgentKey, OWNER_SURFACE_SETTING_KEYS),
      buildIntegrations(businessId),
      buildContextBlock(businessId, {}, { includeCustomTables: true }),
      buildBookingLink(businessId),
      fetchWhatsAppConnection(businessId).catch(() => null),
      // The read fails OPEN: quality over fuse on a transient blip.
      fetchSpend(businessId, undefined, meta.tier).catch(() => null)
    ]);

  // MCP-bridge tools are OWNER-only, the same double gate the other
  // surfaces apply. A teammate never sees the declarations, and the
  // handlers still re-check the caller's role per call. No owner email on
  // record means no bridge, because the handlers could only refuse.
  const bridgeExtraTools =
    speaker.kind === "owner" && meta.ownerEmail
      ? buildBridge(
          businessId,
          {
            userId: opts.bridgeUserId ?? `${surface.key}-owner-operator`,
            email: meta.ownerEmail
          },
          {
            read_business_data: states.read_business_data,
            manage_contacts: states.manage_contacts,
            manage_flows: states.manage_flows,
            manage_agents: states.manage_agents,
            update_business_profile: states.update_business_profile,
            update_business_knowledge: states.update_business_knowledge,
            manage_coworker_tools: states.manage_coworker_tools
          },
          "owner"
        )
      : null;

  return {
    timezone: meta.timezone,
    tier: meta.tier,
    ownerEmail: meta.ownerEmail,
    knowledgeToolEnabled: states.business_knowledge_lookup,
    emailToolEnabled: states.send_email,
    toolStates: {
      send_sms: states.send_sms,
      send_whatsapp: states.send_whatsapp,
      calendar_find_slots: states.calendar_find_slots,
      calendar_book_appointment: states.calendar_book_appointment,
      calendar_reschedule_appointment: states.calendar_reschedule_appointment,
      calendar_cancel_appointment: states.calendar_cancel_appointment,
      calendar_join_waitlist: states.calendar_join_waitlist,
      run_aiflow: states.run_aiflow,
      edit_aiflow: states.edit_aiflow,
      update_notification_preferences: states.update_notification_preferences,
      flag_contact_spam: states.flag_contact_spam,
      set_contact_reply_mode: states.set_contact_reply_mode,
      manage_employee: states.manage_employee,
      custom_table_read: states.custom_table_read,
      custom_table_write: states.custom_table_write,
      custom_table_manage: states.custom_table_manage
    },
    whatsappConnected: connection?.is_active === true,
    integrationsLine,
    bookingLinkLine,
    businessContextBlock,
    bridgeExtraTools,
    overCap: spend !== null && spend.spendMicros >= spend.effectiveCapMicros
  };
}

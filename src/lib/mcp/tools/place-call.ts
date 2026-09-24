/**
 * place_call: an outside assistant asks the coworker to dial.
 *
 * The assistant writes a short brief. This tool dials from the business's
 * own number and the coworker speaks that brief. The other assistant never
 * gets the audio. The call is an outbound voice origination, same path as
 * Dashboard → Place call, gated on Standard+ outbound AI calls.
 *
 * Origination requires an enabled flow row. The first call creates one
 * named "Assistant calls" so a tenant's real outbound flows are not reused
 * as a shell. Later calls reuse that row and pass this brief as the persona
 * for this dial only.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId
} from "@/lib/mcp/auth";
import { defineMcpTool, TOOL_BEHAVIOR } from "@/lib/mcp/tooling";
import { normalizePhoneArg } from "@/lib/mcp/tools/read";
import { rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getNotificationPreferences } from "@/lib/db/notification-preferences";
import { createAiFlow } from "@/lib/ai-flows/db";
import { outboundAiCallsAllowedForBusiness, OUTBOUND_AI_CALLS_UPGRADE_MESSAGE } from "@/lib/plans/outbound-ai-calls";
import { restoreContentRows } from "@/lib/residency/row-delete";
import type { SupabaseClient } from "@supabase/supabase-js";

const PLACE_CALL_RATE = { interval: 60 * 1000, maxRequests: 10 };

/** Stable flow name. Searched and created with this exact string. */
const ASSISTANT_CALL_FLOW_NAME = "Assistant calls";

const PERSONA_PREFIX =
  "You are the phone coworker for this business, placing this one call. Purpose: ";
const PERSONA_SUFFIX =
  " Speak as the business, in your own words. Do not invent prices, promises, or callback numbers.";

const BRIEF_MAX = 500 - PERSONA_PREFIX.length - PERSONA_SUFFIX.length;

function personaForBrief(brief: string): string {
  return `${PERSONA_PREFIX}${brief.trim()}${PERSONA_SUFFIX}`;
}

type AssistantCallFlowRow = {
  id: string;
  enabled: boolean;
  deleted_at: string | null;
};

/**
 * Pick the flow this tool dials through.
 *
 * Names are not unique, and a delete only stamps deleted_at (and forces
 * enabled off). A hidden deleted row must not count as "turned off": the
 * AiFlows list does not show it, so the owner could never turn it back on.
 * Restore that row instead. When several live rows share the name, use the
 * oldest enabled one so a double-create does not make every later call fail.
 */
function chooseAssistantCallFlow(rows: AssistantCallFlowRow[]): {
  flowId: string;
  restore: boolean;
} | "create" | "disabled" {
  const live = rows.filter((row) => !row.deleted_at);
  const enabled = live.find((row) => row.enabled);
  if (enabled) return { flowId: enabled.id, restore: false };
  if (live.length > 0) return "disabled";
  const deleted = rows.find((row) => row.deleted_at);
  if (deleted) return { flowId: deleted.id, restore: true };
  return "create";
}

async function loadAssistantCallFlows(
  db: SupabaseClient,
  businessId: string
): Promise<AssistantCallFlowRow[]> {
  const { data, error } = await db
    .from("ai_flows")
    .select("id, enabled, deleted_at")
    .eq("business_id", businessId)
    .eq("name", ASSISTANT_CALL_FLOW_NAME)
    .order("created_at", { ascending: true })
    .limit(10);
  if (error) throw new McpToolError("Could not look up the call flow. Try again.");
  return (data ?? []) as AssistantCallFlowRow[];
}

function originateFailureMessage(reason: string): string {
  if (reason === "tier_blocked") return OUTBOUND_AI_CALLS_UPGRADE_MESSAGE;
  if (reason === "quota_exhausted") return "Out of voice minutes for this billing period.";
  if (
    reason === "concurrent_limit" ||
    reason === "carrier_channel_limit" ||
    reason === "platform_capacity"
  ) {
    return "Too many calls in progress right now. Try again shortly.";
  }
  if (reason === "invalid_callee") return "That phone number cannot be dialed.";
  if (reason === "no_caller_id" || reason === "no_telnyx_connection") {
    return "This account has no voice number configured to call from.";
  }
  return "Could not place the call. Try again.";
}

const placeCallTool = defineMcpTool({
  name: "place_call",
  title: "Place a call",
  annotations: TOOL_BEHAVIOR.writeExternal,
  outputSchema: z.object({
    dialed: z.boolean(),
    to: z.string(),
    call_control_id: z.string()
  }),
  description:
    "Place a phone call from the business's number. You write a short brief. The coworker dials and speaks that brief in its own voice. You do not speak on the line, and this does not return the live audio. When the call ends, the transcript is in call history (list_call_transcripts). A text summary goes to the business's alert phone. Standard plan and up. Managers and owners only. The first call creates an outbound flow named \"Assistant calls\" so later calls reuse it.",
  schema: {
    business_id: z
      .string()
      .uuid()
      .optional()
      .describe("Business to call from. Optional when the account has exactly one business."),
    to: z.string().describe("Number to dial (any common format)."),
    brief: z
      .string()
      .trim()
      .min(1)
      .max(BRIEF_MAX)
      .describe(
        "What the coworker should accomplish on this call, in plain language. The coworker speaks as the business. Do not include a script of exact sentences."
      )
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "manage_aiflows");
    const to = normalizePhoneArg(args.to);

    const limiter = rateLimit(`mcp-place-call:${businessId}`, PLACE_CALL_RATE);
    if (!limiter.success) {
      throw new McpToolError("Call rate limit exceeded. Retry in a minute.");
    }

    if (!(await outboundAiCallsAllowedForBusiness(businessId))) {
      throw new McpToolError(OUTBOUND_AI_CALLS_UPGRADE_MESSAGE);
    }

    const prefs = await getNotificationPreferences(businessId);
    const notifyE164 = prefs?.phone_number?.trim() ?? "";
    if (!notifyE164) {
      throw new McpToolError(
        "Set an alert phone in Settings, Notifications, before placing a call. That number receives the summary when the call ends."
      );
    }

    const db = await createSupabaseServiceClient();
    const choice = chooseAssistantCallFlow(await loadAssistantCallFlows(db, businessId));
    let flowId = "";
    if (choice === "disabled") {
      throw new McpToolError(
        `The "${ASSISTANT_CALL_FLOW_NAME}" flow is turned off. Turn it on in AiFlows, then try again.`
      );
    }
    if (choice === "create") {
      const created = await createAiFlow(
        {
          businessId,
          name: ASSISTANT_CALL_FLOW_NAME,
          enabled: true,
          createdBy: auth.userId,
          definition: {
            version: 1,
            trigger: { channel: "voice", direction: "outbound" },
            steps: [
              {
                id: "call",
                type: "outbound_call",
                notifyE164,
                persona: "You are the phone coworker for this business, placing a call the owner asked for."
              }
            ]
          }
        },
        db
      );
      flowId = created.id;
    } else if (choice.restore) {
      await restoreContentRows(
        businessId,
        "ai_flows",
        [{ column: "id", op: "eq", value: choice.flowId }],
        { client: db },
        { enabled: true }
      );
      flowId = choice.flowId;
    } else {
      flowId = choice.flowId;
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const cronSecret = process.env.INTERNAL_CRON_SECRET?.trim();
    if (!supabaseUrl || !cronSecret) {
      throw new McpToolError("Voice origination is not configured.");
    }

    const persona = personaForBrief(args.brief);
    const res = await fetch(`${supabaseUrl}/functions/v1/telnyx-voice-originate`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cronSecret}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        businessId,
        flowId,
        toE164: to,
        call: {
          toE164: to,
          notifyE164,
          persona
        }
      })
    });
    const result = (await res.json().catch(() => null)) as
      | { ok?: boolean; error?: string; reason?: string; callControlId?: string; to?: string }
      | null;
    if (!res.ok || !result?.ok || !result.callControlId) {
      const reason = result?.reason ?? result?.error ?? "place_call_failed";
      throw new McpToolError(originateFailureMessage(reason));
    }

    return { dialed: true, to: result.to ?? to, call_control_id: result.callControlId };
  }
});

export const placeCallTools = [placeCallTool];

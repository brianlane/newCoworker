/**
 * Live smoke for the MCP bridge on the inline engine: run ONE read-only
 * companion turn against the HQ tenant with the real production assembly
 * (OWNER_PREAMBLE + bridge ladder + real declarations + real executor) and
 * print the tool-call trace plus the reply.
 *
 *   tsx debug/smoke-companion-bridge.ts [--business-id <uuid>] [--ask "..."]
 *
 * Defaults to the HQ tenant (test spend lands on our own box) and a
 * read-only ask, so a smoke run can never text a customer: the executor is
 * the REAL one, so only run write asks deliberately. Requires .env
 * (GOOGLE_API_KEY + Supabase service key), same resolution as every debug
 * script; safe from a worktree.
 */
import { loadEnv } from "./_shared";

loadEnv();

const HQ_BUSINESS_ID = "8f3a5c21-7e94-4b6a-9d02-c4e8b1f6a37d";

function argValue(flag: string): string | null {
  const idx = process.argv.indexOf(flag);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

async function main() {
  const businessId = argValue("--business-id") ?? HQ_BUSINESS_ID;
  const ask =
    argValue("--ask") ??
    "Who did we text most recently, and what did they say? Use your tools; do not guess.";

  const [{ runInlineChatTurn }, bridge, { OWNER_PREAMBLE }, { buildBusinessContextBlock }, { createSupabaseServiceClient }] =
    await Promise.all([
      import("../src/lib/dashboard-chat/inline-turn"),
      import("../src/lib/dashboard-chat/mcp-bridge"),
      import("../src/app/api/dashboard/chat/route"),
      import("../src/lib/dashboard-chat/context-blocks"),
      import("../src/lib/supabase/server")
    ]);

  const db = await createSupabaseServiceClient();
  const { data: biz, error } = await db
    .from("businesses")
    .select("id, name, owner_email")
    .eq("id", businessId)
    .maybeSingle();
  if (error || !biz) {
    console.error("business lookup failed:", error?.message ?? "not found");
    process.exit(1);
  }
  const ownerEmail = String((biz as { owner_email?: string }).owner_email ?? "");
  if (!ownerEmail) {
    console.error("business has no owner_email; the bridge caller needs one");
    process.exit(1);
  }
  console.log(`business: ${(biz as { name?: string }).name} (${businessId})`);
  console.log(`caller:   ${ownerEmail}`);
  console.log(`ask:      ${ask}\n`);

  const gates = Object.fromEntries(
    bridge.MCP_BRIDGE_GATE_KEYS.map((key) => [key, true])
  ) as import("../src/lib/dashboard-chat/mcp-bridge").McpBridgeGates;

  const extraTools = bridge.buildMcpBridgeExtraTools(
    businessId,
    { userId: "smoke-companion-bridge", email: ownerEmail },
    gates,
    "owner"
  );
  if (!extraTools) {
    console.error("bridge declared nothing (gates off?)");
    process.exit(1);
  }
  const baseExecute = extraTools.execute;
  extraTools.execute = async (call) => {
    console.log(`→ tool ${call.name} ${JSON.stringify(call.args).slice(0, 300)}`);
    const result = await baseExecute(call);
    console.log(`← ${JSON.stringify(result).slice(0, 500)}\n`);
    return result;
  };

  const contextBlock = await buildBusinessContextBlock(businessId);
  const systemInstruction = [
    OWNER_PREAMBLE,
    bridge.mcpBridgeToolsPreamble({ creationToolsDeclared: false }),
    ...(contextBlock ? [contextBlock] : [])
  ].join("\n\n");

  const result = await runInlineChatTurn({
    businessId,
    systemInstruction,
    userMessage: `[Dashboard] ${ask}`,
    knowledgeToolEnabled: false,
    includeCreationTools: false,
    actionToolGates: null,
    extraTools,
    maxToolSteps: 6,
    spendSurface: "dashboard_chat"
  });

  console.log("=== RESULT ===");
  console.log(JSON.stringify(result, null, 2).slice(0, 4000));
  process.exit(result.ok ? 0 : 1);
}

void main();

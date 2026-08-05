#!/usr/bin/env tsx
/**
 * One-shot: stop KYP's assistant from canceling a customer's appointment on
 * its own, which the account's own intake says it must never do.
 *
 * White-glove intake §7, "When a human takes over", lists what the assistant
 * hands off and never improvises on. "Cancellations or refunds" is on that
 * list. On 2026-08-05 the assistant canceled Reem's booking directly through
 * Calendly (host-side cancel at 12:55:04Z, reason "Canceled at the customer's
 * request via the business's assistant") two seconds before texting her that
 * it had. It also quoted her a price, which is likewise on that list.
 *
 * It could do that because KYP has ZERO rows in `agent_tool_settings`, and a
 * missing row does not mean off: it means "use the registry default", which
 * for `calendar_cancel_appointment` is ENABLED. Nothing in the product says
 * so, which is the trap `src/lib/agent-tools/channel-divergence.ts` was
 * written about.
 *
 * What this writes: explicit `enabled = false` rows for
 * `calendar_cancel_appointment` on the CUSTOMER-facing surfaces that expose
 * it. Per the registry that is `sms` and `email`; voice and webchat do not
 * offer the tool at all, so a row there would be noise.
 *
 * `dashboard` is deliberately LEFT ENABLED. That surface is James asking his
 * own assistant to cancel something, not the AI canceling at a customer
 * unprompted, and it is the exact distinction OWNER_OPERATED_AGENT_KEYS
 * draws. Amy Laidlaw's account keeps dashboard on for the same reason.
 *
 * What this deliberately does NOT do: the price-quoting half of §7. That is
 * prompt behavior rather than a tool, and the figure the assistant gave was
 * substantively correct ($200/wk is the new-lead rate). Changing how the
 * account talks about pricing is James's call, not a silent patch.
 *
 * Idempotent: rows already set to the target value are reported and skipped.
 * Dry-run by default, ledger-recorded.
 *
 * Verify after applying with:
 *   npx tsx debug/audit-agent-tool-channels.ts
 *
 * Usage:
 *   npx tsx scripts/oneshot/patch-kyp-cancel-tool-policy.ts --business <uuid>
 *   npx tsx scripts/oneshot/patch-kyp-cancel-tool-policy.ts --business <uuid> --apply
 */
import { createClient } from "@supabase/supabase-js";
import { pathToFileURL } from "node:url";
import { AGENT_TOOL_REGISTRY } from "../../src/lib/agent-tools/registry";
import { OWNER_OPERATED_AGENT_KEYS } from "../../src/lib/agent-tools/channel-divergence";
import { recordOneshotApplied } from "./_ledger";

export const CANCEL_TOOL_KEY = "calendar_cancel_appointment";

/**
 * Every customer-facing surface that actually exposes the cancel tool,
 * derived from the registry rather than hard-coded, so a surface added later
 * is not silently missed the way voice was on Amy's account.
 */
export function customerFacingCancelSurfaces(): string[] {
  return AGENT_TOOL_REGISTRY.filter(
    (agent) =>
      !OWNER_OPERATED_AGENT_KEYS.includes(agent.key) &&
      agent.tools.some((t) => t.toolKey === CANCEL_TOOL_KEY)
  ).map((agent) => agent.key);
}

type Args = { apply: boolean; businessId: string | null };

function parseArgs(argv: readonly string[]): Args {
  const args: Args = { apply: false, businessId: null };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--apply") args.apply = true;
    else if (a === "--business") args.businessId = argv[++i] ?? null;
    else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const businessId =
    args.businessId ?? process.env.AIFLOW_KYP_BUSINESS_ID ?? process.env.KYP_BUSINESS_ID ?? "";
  if (!/^[0-9a-f-]{36}$/i.test(businessId)) {
    console.error("Pass --business <uuid> (or set AIFLOW_KYP_BUSINESS_ID / KYP_BUSINESS_ID)");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const surfaces = customerFacingCancelSurfaces();
  console.log(`Disabling "${CANCEL_TOOL_KEY}" on: ${surfaces.join(", ")}`);
  console.log(`Leaving owner-operated surfaces enabled: ${OWNER_OPERATED_AGENT_KEYS.join(", ")}`);

  const { data: existing, error } = await db
    .from("agent_tool_settings")
    .select("agent_key, tool_key, enabled")
    .eq("business_id", businessId)
    .eq("tool_key", CANCEL_TOOL_KEY);
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  console.log(
    `Existing rows for this tool: ${
      existing && existing.length > 0 ? JSON.stringify(existing) : "none (registry default applies, which is ENABLED)"
    }`
  );

  const todo = surfaces.filter(
    (agentKey) => !(existing ?? []).some((r) => r.agent_key === agentKey && r.enabled === false)
  );
  if (todo.length === 0) {
    console.log("Already patched: every customer-facing surface is explicitly disabled.");
    return;
  }
  console.log(`Will write ${todo.length} row(s): ${todo.join(", ")}`);

  if (!args.apply) {
    console.log("[dry-run] Not writing. Re-run with --apply.");
    return;
  }

  const { error: writeErr } = await db.from("agent_tool_settings").upsert(
    todo.map((agentKey) => ({
      business_id: businessId,
      agent_key: agentKey,
      tool_key: CANCEL_TOOL_KEY,
      enabled: false
    })),
    { onConflict: "business_id,agent_key,tool_key" }
  );
  if (writeErr) {
    console.error(`Write failed: ${writeErr.message}`);
    process.exit(1);
  }
  await recordOneshotApplied(db, {
    scriptPath: process.argv[1],
    businessId,
    details: { tool: CANCEL_TOOL_KEY, disabledOn: todo }
  });
  console.log("Written. Verify with: npx tsx debug/audit-agent-tool-channels.ts");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  });
}

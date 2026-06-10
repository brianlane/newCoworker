#!/usr/bin/env tsx
/**
 * Read-only probe of route_to_team agent SELECTION: asks the tenant's live
 * Rowboat the exact same question the ai-flow-worker asks (same preamble, same
 * `{lead, alreadyTried}` payload, same `parseRoutedAgent` parser) and reports:
 *
 *   A) Escalation chain — one synthetic lead, alreadyTried growing after each
 *      pick. Verifies every pick is a distinct roster agent in E.164 and that
 *      Rowboat answers {"none":true} once the roster is exhausted (this is
 *      what protects the owner-fallback path from looping).
 *   B) First-pick fairness — N fresh leads with an empty alreadyTried.
 *      Reports the distribution of who gets offered first. NOTE: each worker
 *      lookup is a STATELESS chat (conversationId=null) and nothing writes
 *      routing outcomes back to vault memory, so "least recently received a
 *      lead" cannot actually be computed by Rowboat — this section makes that
 *      bias visible rather than asserting on it.
 *
 * Sends NO SMS/MMS/email and creates no ai_flow_runs — it only talks to the
 * Rowboat chat endpoint (each call does cost one LLM turn on the tenant box).
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/probe-route-rotation.ts                 # A + B with 5 leads
 *   tsx debug/probe-route-rotation.ts --leads 8       # more fairness samples
 *   tsx debug/probe-route-rotation.ts --skip-chain    # only the fairness pass
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY,
 *      ROWBOAT_VPS_CHAT_BEARER (or ROWBOAT_GATEWAY_TOKEN).
 *      Optional: SMOKE_BUSINESS_ID, ROWBOAT_CHAT_URL_TEMPLATE.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { callRowboatChatOnce } from "../supabase/functions/_shared/sms_rowboat.ts";
import { parseRoutedAgent } from "../supabase/functions/_shared/ai_flows/engine.ts";

const BUSINESS_ID = process.env.SMOKE_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const TIMEOUT_MS = 60_000;
// Mirrors ROUTE_MAX_LOOKUPS in the worker: hard stop for the escalation chain.
const MAX_CHAIN = 8;

// Same preamble string the worker builds in pickNextAgent().
const PREAMBLE = [
  "You are routing a new real-estate lead to your team.",
  "Pick the single NEXT team agent to offer this lead to, using the team",
  "roster and rotation rules in your memory.",
  "Do NOT pick any agent whose phone is in the alreadyTried list.",
  "Reply with ONLY a compact JSON object and nothing else: either",
  '{"name":"<agent name>","phone":"<E.164 phone>"} for the next agent, or',
  '{"none":true} if every eligible agent has already been tried.'
].join(" ");

const SYNTHETIC_LEADS = [
  { name: "Probe Buyer One", phone: "+16025550101", location: "Gilbert, AZ", price: "$254K", type: "buyer" },
  { name: "Probe Seller Two", phone: "+16025550102", location: "Mesa, AZ", price: "$410K", type: "seller" },
  { name: "Probe Buyer Three", phone: "+16025550103", location: "Chandler, AZ", price: "$330K", type: "buyer" },
  { name: "Probe Both Four", phone: "+16025550104", location: "Tempe, AZ", price: "$520K", type: "both" },
  { name: "Probe Seller Five", phone: "+16025550105", location: "Scottsdale, AZ", price: "$780K", type: "seller" },
  { name: "Probe Buyer Six", phone: "+16025550106", location: "Phoenix, AZ", price: "$295K", type: "buyer" },
  { name: "Probe Seller Seven", phone: "+16025550107", location: "Glendale, AZ", price: "$365K", type: "seller" },
  { name: "Probe Buyer Eight", phone: "+16025550108", location: "Peoria, AZ", price: "$440K", type: "buyer" }
];

function fail(msg: string): never {
  console.error(`PROBE FAIL: ${msg}`);
  process.exit(1);
}

async function ask(
  chatUrl: string,
  bearer: string,
  lead: (typeof SYNTHETIC_LEADS)[number],
  tried: string[]
): Promise<{ raw: string; agent: { name: string; phone: string } | null }> {
  const res = await callRowboatChatOnce({
    chatUrl,
    bearer,
    userText: JSON.stringify({ lead, alreadyTried: tried }),
    conversationId: null,
    state: null,
    timeoutMs: TIMEOUT_MS,
    customerPreamble: PREAMBLE
  });
  return { raw: res.reply, agent: parseRoutedAgent(res.reply) };
}

async function main(): Promise<void> {
  loadEnv();
  const args = process.argv.slice(2);
  const leadsIdx = args.indexOf("--leads");
  const fairnessLeads = Math.min(
    leadsIdx !== -1 ? Number(args[leadsIdx + 1]) || 5 : 5,
    SYNTHETIC_LEADS.length
  );
  const skipChain = args.includes("--skip-chain");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  const bearer = process.env.ROWBOAT_VPS_CHAT_BEARER ?? process.env.ROWBOAT_GATEWAY_TOKEN ?? "";
  if (!url || !key) fail("missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
  if (!bearer) fail("missing ROWBOAT_VPS_CHAT_BEARER / ROWBOAT_GATEWAY_TOKEN");

  // Resolve the project id the same way the worker does.
  const db = createClient(url, key, { auth: { persistSession: false } });
  const { data: cfg, error } = await db
    .from("business_configs")
    .select("rowboat_project_id, memory_md")
    .eq("business_id", BUSINESS_ID)
    .maybeSingle();
  if (error) fail(`business_configs read: ${error.message}`);
  const projectId =
    (cfg?.rowboat_project_id as string | null)?.trim() ||
    process.env.ROWBOAT_DEFAULT_PROJECT_ID ||
    "";
  if (!projectId) fail("no rowboat_project_id configured");
  const template =
    process.env.ROWBOAT_CHAT_URL_TEMPLATE ??
    "https://{businessId}.newcoworker.com/api/v1/{projectId}/chat";
  const chatUrl = template
    .replace(/\{businessId\}/g, BUSINESS_ID)
    .replace(/\{projectId\}/g, projectId);
  console.log(`chat endpoint: ${chatUrl}`);
  const memoryMd = (cfg?.memory_md as string | null) ?? "";
  console.log(`vault memory: ${memoryMd.length} chars (roster + rotation rules live here)\n`);

  // --- A. escalation chain: one lead, tried grows until {"none":true} -------
  if (!skipChain) {
    console.log("=== A. escalation chain (one lead, alreadyTried grows) ===");
    const tried: string[] = [];
    const picks: string[] = [];
    let sawNone = false;
    for (let i = 0; i < MAX_CHAIN; i++) {
      const { raw, agent } = await ask(chatUrl, bearer, SYNTHETIC_LEADS[0], tried);
      if (!agent) {
        console.log(`  pick ${i + 1}: none (raw: ${raw.slice(0, 80)})`);
        sawNone = true;
        break;
      }
      const dup = tried.includes(agent.phone);
      console.log(`  pick ${i + 1}: ${agent.name} ${agent.phone}${dup ? "  <-- REPEAT (engine would re-ask)" : ""}`);
      if (!dup) picks.push(`${agent.name} ${agent.phone}`);
      tried.push(agent.phone);
    }
    console.log(`  chain: ${picks.join(" -> ")}${sawNone ? " -> none" : ""}`);
    if (!sawNone) {
      console.log("  WARNING: never returned {\"none\":true} within the lookup budget — owner fallback would rely on the repeat guard.");
    }
    console.log("");
  }

  // --- B. first-pick distribution across fresh leads ------------------------
  console.log(`=== B. first pick across ${fairnessLeads} fresh leads (empty alreadyTried) ===`);
  const counts = new Map<string, number>();
  for (let i = 0; i < fairnessLeads; i++) {
    const { raw, agent } = await ask(chatUrl, bearer, SYNTHETIC_LEADS[i], []);
    const label = agent ? `${agent.name} ${agent.phone}` : `UNPARSEABLE: ${raw.slice(0, 80)}`;
    counts.set(label, (counts.get(label) ?? 0) + 1);
    console.log(`  lead ${i + 1} (${SYNTHETIC_LEADS[i].type}): ${label}`);
  }
  console.log("\n  distribution:");
  for (const [label, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${n}/${fairnessLeads}  ${label}`);
  }
  console.log(
    "\nNOTE: selection calls are stateless and routing outcomes are never written" +
      "\nback to vault memory, so Rowboat cannot know who 'least recently received'" +
      "\na lead — a skewed distribution here is expected, not a regression."
  );
}

main().catch((err) => {
  console.error(`PROBE FAIL: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exit(1);
});

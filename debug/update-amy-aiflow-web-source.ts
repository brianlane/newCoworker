#!/usr/bin/env tsx
/**
 * One-shot: make a tenant's "ReferralExchange Lead" AiFlow report the lead's
 * REAL web source instead of a hardcoded "ReferralExchange".
 *
 * ReferralExchange is an aggregator: the lead page's "Web Source" row shows
 * where the lead actually originated (e.g. RealEstateAgents.com), but every
 * internal message in the flow (owner emails, team offers, claim/fallback
 * notices, owner notifies) hardcodes "Lead source: ReferralExchange
 * (referralexchange.com)". This script:
 *
 *   1. Adds a `web_source` field to the `browse` browse_extract step. The
 *      extraction prompt itself carries the fallback ("answer exactly:
 *      ReferralExchange" when the row is missing), the same "answer exactly"
 *      pattern the flow's other fields already rely on.
 *   2. Rewrites the hardcoded lead-source text in every INTERNAL template to
 *      "{{vars.web_source}}" (owner emails' "lead from ReferralExchange:" and
 *      the route/notify steps' "Lead source: ReferralExchange
 *      (referralexchange.com)" lines). Lead-facing SMS/email copy is left
 *      untouched — it already names RealEstateAgents.com deliberately.
 *
 * NOTE: the "Web Source" value renders as a logo IMAGE (alt="realestateagents"),
 * which document.body.innerText drops — the paired render-service change
 * (readPageText in vps/aiflow-render/server.mjs) inlines image alt text so the
 * extractor can actually see it. Until that lands on the tenant's VPS the
 * field simply falls back to "ReferralExchange", which matches today's copy.
 *
 * Validates through parseAiFlowDefinition before writing, prints the previous
 * definition for rollback, and is idempotent.
 *
 * Usage (reads the repo-root `.env` automatically, like the rest of debug/):
 *   tsx debug/update-amy-aiflow-web-source.ts            # dry run
 *   tsx debug/update-amy-aiflow-web-source.ts --apply
 *
 * Env: NEXT_PUBLIC_SUPABASE_URL (or SUPABASE_URL), SUPABASE_SERVICE_ROLE_KEY.
 * Optional: AIFLOW_UPDATE_BUSINESS_ID, AIFLOW_UPDATE_FLOW_NAME.
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import {
  parseAiFlowDefinition,
  summarizeDefinition,
  AiFlowValidationError,
  type FlowStep
} from "../src/lib/ai-flows/schema.ts";

const WEB_SOURCE_FIELD = {
  name: "web_source",
  description:
    "The lead's original web source website, shown in the 'Web Source' row of the lead " +
    "details (often a site logo). Answer as a full website domain, e.g. RealEstateAgents.com " +
    "— a bare name like 'realestateagents' means realestateagents.com. If none is shown, " +
    "answer exactly: ReferralExchange.com"
};

/**
 * Ordered rewrites applied to every internal template string. The longer
 * "Lead source" line goes first so the bare-name fallback replacement below it
 * can never mangle it. Idempotent: an already-rewritten template contains
 * neither needle.
 */
const REWRITES: ReadonlyArray<[string, string]> = [
  ["Lead source: ReferralExchange (referralexchange.com)", "Lead source: {{vars.web_source}}"],
  ["lead from ReferralExchange:", "lead from {{vars.web_source}}:"]
];

function rewrite(template: string): string {
  let out = template;
  for (const [needle, replacement] of REWRITES) {
    out = out.split(needle).join(replacement);
  }
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  // Read overrides AFTER loadEnv() so repo-root `.env` values actually apply.
  const BUSINESS_ID =
    process.env.AIFLOW_UPDATE_BUSINESS_ID ?? "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
  const FLOW_NAME = process.env.AIFLOW_UPDATE_FLOW_NAME ?? "ReferralExchange Lead";
  const apply = process.argv.includes("--apply");
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!url || !key) {
    console.error("Missing SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY");
    process.exit(2);
  }
  const db = createClient(url, key, { auth: { persistSession: false } });

  const { data: row, error } = await db
    .from("ai_flows")
    .select("id, name, enabled, definition")
    .eq("business_id", BUSINESS_ID)
    .eq("name", FLOW_NAME)
    .maybeSingle();
  if (error) {
    console.error(`Read failed: ${error.message}`);
    process.exit(1);
  }
  if (!row) {
    console.error(`No flow "${FLOW_NAME}" for business ${BUSINESS_ID}`);
    process.exit(1);
  }

  console.log(`Previous definition (for rollback):\n${JSON.stringify(row.definition)}\n`);

  const def = parseAiFlowDefinition(row.definition);
  const steps: FlowStep[] = def.steps.map((s) => ({ ...s }));
  const changed: string[] = [];

  // 1. web_source extraction field on the browse step.
  const browseIdx = steps.findIndex((s) => s.type === "browse_extract");
  if (browseIdx === -1) {
    console.error("No browse_extract step found");
    process.exit(1);
  }
  const browse = steps[browseIdx];
  if (
    browse.type === "browse_extract" &&
    !(browse.fields ?? []).some((f) => f.name === WEB_SOURCE_FIELD.name)
  ) {
    steps[browseIdx] = { ...browse, fields: [...(browse.fields ?? []), WEB_SOURCE_FIELD] };
    changed.push(`${browse.id} (+${WEB_SOURCE_FIELD.name} field)`);
  }

  // 2. Rewrite the hardcoded lead-source text in every internal template.
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    let next: FlowStep = s;
    if (s.type === "send_email") {
      const body = rewrite(s.body);
      if (body !== s.body) next = { ...s, body };
    } else if (s.type === "notify_owner") {
      const message = rewrite(s.message);
      if (message !== s.message) next = { ...s, message };
    } else if (s.type === "route_to_team") {
      const offerTemplate = rewrite(s.offerTemplate);
      const ownerFallbackTemplate = rewrite(s.ownerFallbackTemplate);
      const claimedNotifyTemplate = s.claimedNotifyTemplate
        ? rewrite(s.claimedNotifyTemplate)
        : s.claimedNotifyTemplate;
      if (
        offerTemplate !== s.offerTemplate ||
        ownerFallbackTemplate !== s.ownerFallbackTemplate ||
        claimedNotifyTemplate !== s.claimedNotifyTemplate
      ) {
        next = {
          ...s,
          offerTemplate,
          ownerFallbackTemplate,
          ...(claimedNotifyTemplate !== undefined ? { claimedNotifyTemplate } : {})
        };
      }
    }
    if (next !== s) {
      steps[i] = next;
      changed.push(s.id);
    }
  }

  const nextDefinition = { ...def, steps };
  let validated;
  try {
    validated = parseAiFlowDefinition(nextDefinition);
  } catch (err) {
    if (err instanceof AiFlowValidationError) {
      console.error("Updated definition failed validation:");
      for (const issue of err.issues) console.error(`  - ${issue}`);
    } else {
      console.error("Updated definition failed validation:", err);
    }
    process.exit(2);
  }

  console.log(`Flow    : ${row.id} (${row.name}, enabled=${row.enabled})`);
  console.log(`Summary : ${summarizeDefinition(validated)}`);
  console.log(`Changed : ${changed.length ? changed.join(", ") : "(none — already applied)"}`);

  if (!apply) {
    console.log("\n[dry-run] Not writing. Re-run with --apply to update.");
    return;
  }
  if (changed.length === 0) {
    console.log("\nNothing to write.");
    return;
  }

  const { error: upErr } = await db
    .from("ai_flows")
    .update({ definition: validated })
    .eq("id", row.id);
  if (upErr) {
    console.error(`Update failed: ${upErr.message}`);
    process.exit(1);
  }
  console.log("\nUpdated.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

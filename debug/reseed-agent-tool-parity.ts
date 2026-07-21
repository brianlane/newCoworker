/**
 * Rowboat agent-tool PARITY audit + converge (fleet-wide).
 *
 * The per-tenant Rowboat workflow (agents + tool declarations) is frozen at
 * deploy time by vps/scripts/deploy-client.sh, so every new tool wave leaves
 * already-provisioned boxes behind unless someone remembers a reseed
 * (marketplace and scheduling each got a one-off). This script replaces the
 * per-wave scripts with a full converge:
 *
 *   - the CANONICAL workflow is rendered from deploy-client.sh itself
 *     (debug/_workflow-seed.ts executes the seed's own jq program), so there
 *     is no duplicated catalog to drift;
 *   - for each tenant box it diffs the live Mongo workflow against the
 *     canonical one and reports, per agent: missing tools, extra tools
 *     (NEVER removed — report only), and agents missing entirely (those
 *     need a full redeploy via scripts/redeploy-deploy-client.ts);
 *   - with --apply it surgically UNIONS the missing tool names into each
 *     agent and adds/refreshes the workflow-level tool declarations
 *     (descriptions/parameters converge to canonical; same posture as the
 *     scheduling reseed's description converge). Idempotent: a re-run
 *     converges to a no-op.
 *   - it also checks the voice bridge's deployed tool-declarations source
 *     against the repo copy (sha256) and flags stale bridges — voice tools
 *     ship with the bridge, not the workflow.
 *
 * DEFAULT IS REPORT-ONLY. Nothing writes without --apply.
 *
 * Usage: tsx debug/reseed-agent-tool-parity.ts [businessId] [--apply]
 *        tsx debug/reseed-agent-tool-parity.ts --all [--apply]
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";
import { renderWorkflowSeed } from "./_workflow-seed.ts";

loadEnv();

const flags = process.argv.slice(2);
const ALL = flags.includes("--all");
const APPLY = flags.includes("--apply");
const args = flags.filter((a) => !a.startsWith("--"));
const SINGLE_BUSINESS_ID = args[0] ?? "";

// ---------------------------------------------------------------------------
// Canonical catalog straight from the deploy script's own seed.
// ---------------------------------------------------------------------------
const seed = renderWorkflowSeed();
const catalog = {
  // agentName -> canonical tool list (order preserved for readability).
  agents: Object.fromEntries(seed.agents.map((a) => [a.name, a.tools])),
  // Full workflow-level declarations (name/description/isWebhook/parameters).
  tools: seed.tools
};
const catalogJson = JSON.stringify(catalog);
if (catalogJson.includes("JS_EOF")) {
  throw new Error("catalog JSON collides with the heredoc terminator");
}

console.log(
  `canonical seed: ${seed.agents.length} agents, ${seed.tools.length} workflow tools ` +
    `(from vps/scripts/deploy-client.sh)`
);

// Local hash of the voice bridge tool declarations, to compare per box.
const bridgeDeclPath = path.resolve(process.cwd(), "vps/voice-bridge/src/tool-declarations.ts");
const localBridgeSha = crypto
  .createHash("sha256")
  .update(fs.readFileSync(bridgeDeclPath))
  .digest("hex");

// ---------------------------------------------------------------------------
// The mongosh program: pure diff by default, union+converge under APPLY.
// Ancient mongosh-safe JS (var/functions), mirroring the prior reseeds.
// ---------------------------------------------------------------------------
const patchJs = `
var CATALOG = ${catalogJson};
var APPLY = ${APPLY ? "true" : "false"};

function diffWorkflow(wf) {
  var report = { agents: {}, missingAgents: [], missingTools: [], changed: false };
  if (!wf) return null;

  // Workflow-level tool declarations: add missing, converge drifted copy.
  wf.tools = wf.tools || [];
  var byName = {};
  wf.tools.forEach(function (t) { byName[t.name] = t; });
  CATALOG.tools.forEach(function (def) {
    var existing = byName[def.name];
    if (!existing) {
      report.missingTools.push(def.name);
      if (APPLY) { wf.tools.push(def); report.changed = true; }
    } else if (
      existing.description !== def.description ||
      JSON.stringify(existing.parameters) !== JSON.stringify(def.parameters)
    ) {
      report.missingTools.push(def.name + " (drifted copy)");
      if (APPLY) {
        existing.description = def.description;
        existing.parameters = def.parameters;
        report.changed = true;
      }
    }
  });

  // Per-agent tool lists: union missing, report extras (never removed).
  var liveAgents = {};
  (wf.agents || []).forEach(function (a) { liveAgents[a.name] = a; });
  Object.keys(CATALOG.agents).forEach(function (name) {
    var want = CATALOG.agents[name];
    var live = liveAgents[name];
    if (!live) {
      report.missingAgents.push(name);
      return;
    }
    live.tools = live.tools || [];
    var missing = [];
    want.forEach(function (t) {
      if (live.tools.indexOf(t) === -1) {
        missing.push(t);
        if (APPLY) { live.tools.push(t); report.changed = true; }
      }
    });
    var extra = live.tools.filter(function (t) { return want.indexOf(t) === -1; });
    if (missing.length || extra.length) {
      report.agents[name] = { missing: missing, extra: extra };
    }
  });
  return report;
}

db.projects.find({}).forEach(function (p) {
  var live = diffWorkflow(p.liveWorkflow);
  var draft = diffWorkflow(p.draftWorkflow);
  var changed = (live && live.changed) || (draft && draft.changed);
  if (APPLY && changed) {
    db.projects.updateOne({ _id: p._id }, { $set: {
      liveWorkflow: p.liveWorkflow,
      draftWorkflow: p.draftWorkflow
    }});
  }
  print("PARITY " + JSON.stringify({
    project: p._id,
    applied: APPLY && !!changed,
    live: live,
    draft: draft
  }));
});
`;

const remote = `
set -uo pipefail
DC="docker compose -f /opt/rowboat/docker-compose.yml"

cat > /tmp/reseed-parity.js <<'JS_EOF'
${patchJs}
JS_EOF

echo "===RUN==="
\$DC cp /tmp/reseed-parity.js mongo:/tmp/reseed-parity.js >/dev/null
\$DC exec -T mongo mongosh --quiet rowboat /tmp/reseed-parity.js 2>/dev/null || { echo "ERR running"; exit 1; }
echo "===BRIDGE==="
sha256sum /opt/voice-bridge/src/tool-declarations.ts 2>/dev/null || echo "MISSING voice-bridge tool-declarations"
echo "===DONE==="
`;

const { getActiveVpsSshKeyForBusiness } = await import("../src/lib/db/vps-ssh-keys.ts");
const { sshExecPinned } = await import("../src/lib/hostinger/ssh-pinned.ts");

async function targetBusinessIds(): Promise<string[]> {
  if (!ALL) {
    if (!SINGLE_BUSINESS_ID) {
      throw new Error("usage: tsx debug/reseed-agent-tool-parity.ts <businessId> [--apply] | --all [--apply]");
    }
    return [SINGLE_BUSINESS_ID];
  }
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "",
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? "",
    { auth: { persistSession: false } }
  );
  const { data, error } = await db
    .from("businesses")
    .select("id, name, status")
    .neq("status", "wiped")
    .not("hostinger_vps_id", "is", null);
  if (error) throw new Error(error.message);
  return ((data ?? []) as Array<{ id: string; status: string }>)
    .filter((b) => b.status === "online")
    .map((b) => b.id);
}

type AgentDiff = { missing: string[]; extra: string[] };
type WorkflowReport = {
  agents: Record<string, AgentDiff>;
  missingAgents: string[];
  missingTools: string[];
  changed: boolean;
} | null;

function summarize(businessId: string, output: string): { clean: boolean } {
  let clean = true;
  for (const line of output.split("\n")) {
    const m = /^PARITY (\{.*\})\s*$/.exec(line.trim());
    if (!m) continue;
    const rec = JSON.parse(m[1]) as {
      project: string;
      applied: boolean;
      live: WorkflowReport;
      draft: WorkflowReport;
    };
    const wf = rec.live;
    if (!wf) {
      console.log(`  project ${rec.project}: NO liveWorkflow — needs a full redeploy`);
      clean = false;
      continue;
    }
    const agentIssues = Object.entries(wf.agents);
    if (wf.missingAgents.length === 0 && wf.missingTools.length === 0 && agentIssues.length === 0) {
      console.log(`  project ${rec.project}: OK (full parity)`);
      continue;
    }
    clean = false;
    if (wf.missingAgents.length > 0) {
      console.log(
        `  project ${rec.project}: MISSING AGENTS ${wf.missingAgents.join(", ")} — run scripts/redeploy-deploy-client.ts for this business`
      );
    }
    if (wf.missingTools.length > 0) {
      console.log(
        `  project ${rec.project}: workflow tool declarations ${APPLY ? "added/converged" : "missing/drifted"}: ${wf.missingTools.join(", ")}`
      );
    }
    for (const [agent, diff] of agentIssues) {
      if (diff.missing.length > 0) {
        console.log(
          `  project ${rec.project}: ${agent} ${APPLY ? "gained" : "is missing"}: ${diff.missing.join(", ")}`
        );
      }
      if (diff.extra.length > 0) {
        console.log(
          `  project ${rec.project}: ${agent} has EXTRA (not in seed, left untouched): ${diff.extra.join(", ")}`
        );
      }
    }
    if (rec.applied) console.log(`  project ${rec.project}: patch APPLIED`);
  }
  // Voice bridge freshness.
  const bridgeSection = output.split("===BRIDGE===")[1] ?? "";
  const shaMatch = /^([0-9a-f]{64})\s/m.exec(bridgeSection);
  if (!shaMatch) {
    console.log("  voice bridge: tool-declarations source NOT FOUND on box — old bridge layout; redeploy the voice bridge");
    clean = false;
  } else if (shaMatch[1] !== localBridgeSha) {
    console.log("  voice bridge: tool-declarations STALE vs repo — redeploy the voice bridge to ship the current voice tools");
    clean = false;
  } else {
    console.log("  voice bridge: tool-declarations current");
  }
  return { clean };
}

const client = makeHostingerClient();
let failures = 0;
let dirty = 0;
for (const businessId of await targetBusinessIds()) {
  console.log(`\n== agent-tool parity ${APPLY ? "(APPLY)" : "(report-only)"}: ${businessId} ==`);
  const key = await getActiveVpsSshKeyForBusiness(businessId);
  if (!key) {
    console.error(`no active ssh key for business ${businessId} — skipping`);
    failures += 1;
    continue;
  }
  const ip = await resolveVpsIp(client, key);
  console.log(`vps=${ip}`);
  try {
    let buffer = "";
    const res = await sshExecPinned(key, {
      host: ip,
      username: key.ssh_username || "root",
      privateKeyPem: key.private_key_pem,
      command: remote,
      timeoutMs: 5 * 60 * 1000,
      onStdout: (c: string) => {
        buffer += c;
      },
      onStderr: (c: string) => process.stderr.write(c)
    });
    if (res.exitCode !== 0) {
      console.error(`[parity] exit ${res.exitCode}`);
      console.error(buffer.slice(-2000));
      failures += 1;
      continue;
    }
    const { clean } = summarize(businessId, buffer);
    if (!clean) dirty += 1;
  } catch (err) {
    console.error(`[parity] ${businessId} failed:`, err instanceof Error ? err.message : err);
    failures += 1;
  }
}
console.log(
  `\nSummary: ${failures} failure(s), ${dirty} box(es) ${APPLY ? "patched or still needing follow-up" : "with diffs"}.` +
    (APPLY ? "" : " Re-run with --apply to converge.")
);
process.exit(failures === 0 ? 0 : 1);

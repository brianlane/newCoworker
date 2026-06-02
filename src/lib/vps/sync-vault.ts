/**
 * Push the latest `business_configs` markdown vault to the live VPS and re-seed
 * the per-tenant Rowboat MongoDB project's agent.instructions field.
 *
 * Why this exists:
 *   The orchestrator's `vps/scripts/deploy-client.sh` writes vault files
 *   (`/opt/rowboat/vault/{soul,identity,memory,website}.md`) and seeds
 *   every agent's `instructions` in `db.projects.{draft,live}Workflow`
 *   ONCE at provision time. After that, any owner-driven memory edits via the
 *   dashboard's `/api/business/config` POST or any post-onboarding
 *   `/api/onboard/website-ingest` re-crawl would only land in Supabase —
 *   the VPS-side vault and the MongoDB agent prompt would stay frozen at
 *   the provision-time snapshot. As a result, the agent never reflected
 *   the edits in chat or voice/SMS replies.
 *
 *   This module closes that loop: every write to `business_configs` that
 *   matters for the agent's grounding re-pushes the four markdown files
 *   over SSH and atomically re-runs the same Mongo update the deploy
 *   script does. Idempotent on every call.
 *
 * Why SSH (vs. an HTTP /sync endpoint on the VPS):
 *   - The VPS doesn't expose a public mutation API; only the per-tenant
 *     Cloudflare Tunnel hostname proxies to Rowboat's authenticated /chat
 *     surface. Adding a /sync endpoint would require new auth + transport
 *     hardening for what is, fundamentally, a one-shot orchestrator
 *     operation. SSH already has rotating per-VPS keypairs in
 *     `vps_ssh_keys`; reusing that path keeps the attack surface flat.
 *
 * Failure mode:
 *   This is invoked from API routes as a fire-and-forget side-effect after
 *   the canonical Supabase write has already succeeded. Callers must
 *   `.catch()` rejections — a slow VPS or a missing key MUST NOT block the
 *   API response. Callers should log non-`ok` results so a quiet drift
 *   (e.g. lost SSH key, stopped VPS) surfaces in monitoring rather than
 *   silently breaking the agent.
 */

import { sshExec, type SshExecResult } from "@/lib/hostinger/ssh";
import { getActiveVpsSshKeyForBusiness, type VpsSshKeyRow } from "@/lib/db/vps-ssh-keys";
import { getBusinessConfig, type ConfigRow } from "@/lib/db/configs";
import { getBusiness, type BusinessRow } from "@/lib/db/businesses";
import { HostingerClient, DEFAULT_HOSTINGER_BASE_URL } from "@/lib/hostinger/client";
import { logger } from "@/lib/logger";

export type VaultSyncOk = {
  ok: true;
  hostingerVpsId: string;
  publicIp: string;
  /**
   * The `_id` we targeted in `db.projects.updateOne`. Mirrors the runtime
   * chat route's resolution: `business_configs.rowboat_project_id` first,
   * `businessId` as fallback. Surfaced so logs / monitoring can spot
   * tenants whose project id has drifted from their business id.
   */
  projectId: string;
  /** Length of the concatenated instructions string written to MongoDB. */
  instructionsLength: number;
};

export type VaultSyncFailReason =
  | "no_business"
  | "no_business_config"
  | "no_vps_assigned"
  | "no_ssh_key"
  | "no_public_ip"
  | "no_hostinger_token"
  | "ssh_failed";

export type VaultSyncFail = {
  ok: false;
  reason: VaultSyncFailReason;
  /** Surfaced from the underlying client when relevant (e.g. ssh stderr tail). */
  detail?: string;
};

export type VaultSyncResult = VaultSyncOk | VaultSyncFail;

export type VaultSyncDeps = {
  /** Override the business_configs lookup (tests + admin tooling). */
  fetchConfig?: (businessId: string) => Promise<ConfigRow | null>;
  /** Override the businesses-row lookup. */
  fetchBusiness?: (businessId: string) => Promise<BusinessRow | null>;
  /** Override the SSH key lookup. */
  fetchSshKey?: (businessId: string) => Promise<VpsSshKeyRow | null>;
  /** Override the IP resolver (tests skip the Hostinger API roundtrip). */
  resolveIp?: (hostingerVpsId: string) => Promise<string | null>;
  /** Override the SSH executor (tests inject a fake). */
  exec?: typeof sshExec;
  /** Override the wallclock for the `lastUpdatedAt` field (tests). */
  now?: () => Date;
};

/**
 * Default fallback used when ALL four vault files are blank — keeps the
 * agent operational with a baseline persona instead of a literally empty
 * system prompt (Rowboat's runtime tolerates empty `instructions` but the
 * agent then has no grounding at all). Mirrors the same fallback in
 * `vps/scripts/deploy-client.sh:425`.
 */
export const DEFAULT_AGENT_INSTRUCTIONS_FALLBACK =
  "You are a professional AI coworker. Reply concisely and helpfully.";

/**
 * Build the concatenated `instructions` string in the same field order
 * `deploy-client.sh` uses (identity → soul → website → memory). Empty /
 * whitespace-only sections are skipped so the joined output never has
 * stray double-newlines.
 *
 * Exported for test parity — the same composition runs both at provision
 * time (in bash) and on every dashboard save (here in TS), and a
 * regression in either path silently breaks the agent's grounding.
 */
export function buildAgentInstructions(config: Pick<ConfigRow, "soul_md" | "identity_md" | "memory_md" | "website_md">): string {
  const parts = [config.identity_md, config.soul_md, config.website_md, config.memory_md]
    .map((s) => (typeof s === "string" ? s.trim() : ""))
    .filter((s) => s.length > 0);
  if (parts.length === 0) return DEFAULT_AGENT_INSTRUCTIONS_FALLBACK;
  return parts.join("\n\n");
}

/**
 * Default IP resolver: hits Hostinger's `getVirtualMachine` endpoint and
 * returns the first IPv4 address. Returns `null` when the API token is
 * absent (development) or when the VM has no IPs assigned yet (race with
 * a fresh provision).
 *
 * Splitting this out lets tests inject a deterministic IP without forcing
 * a Hostinger API mock at the call site — the contract is just
 * `(vpsId) => string | null`.
 */
/* c8 ignore start -- network roundtrip; covered by integration tests, not unit tests */
async function defaultResolveIp(hostingerVpsId: string): Promise<string | null> {
  const token = process.env.HOSTINGER_API_TOKEN ?? "";
  if (!token) return null;
  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token
  });
  try {
    const vm = await client.getVirtualMachine(Number(hostingerVpsId));
    return vm.ipv4?.[0]?.address ?? null;
  } catch (err) {
    logger.warn("syncVaultToVps: hostinger getVirtualMachine failed", {
      hostingerVpsId,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}
/* c8 ignore stop */

/**
 * Resolve the MongoDB project id this sync should target. Mirrors the
 * runtime resolution in `/api/dashboard/chat`:
 *
 *   const projectId = projectConfig?.rowboat_project_id?.trim() ?? ...;
 *
 * Without this alignment, the sync path would silently update the wrong
 * (or no) project document on tenants where `rowboat_project_id` was
 * manually re-pointed to a hand-seeded project — `matchedCount` would be
 * zero but `mongosh` reports a clean exit, so the orchestrator would
 * report `ok: true` while the live agent kept serving the stale prompt.
 *
 * Falls back to `businessId` because that's how `deploy-client.sh`
 * provisions every fresh tenant (`db.projects.insertOne({ _id: BUSINESS_ID, ... })`
 * + `PATCH business_configs.rowboat_project_id = BUSINESS_ID`), so the
 * fallback exactly matches the on-VPS reality for the >99% case.
 *
 * The runtime chat route ALSO falls through to
 * `process.env.ROWBOAT_DEFAULT_PROJECT_ID` after the businessId path —
 * that env var is a multi-tenant shared-default for the platform-side
 * gateway, NOT a per-VPS project id, so it's deliberately omitted here.
 * A per-tenant Mongo only has the tenant's own project; targeting a
 * shared default id would update nothing.
 */
export function resolveSyncProjectId(
  businessId: string,
  config: Pick<ConfigRow, "rowboat_project_id">
): string {
  const explicit = config.rowboat_project_id?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return businessId;
}

/**
 * Build the bash command run over SSH. Vault contents are passed as
 * base64 to dodge shell-quoting hazards — markdown frequently contains
 * single quotes, dollar signs, and backticks that would break a heredoc
 * or `printf %s` literal.
 *
 * The mongosh script writes the FULL instructions into EVERY agent of both
 * `draftWorkflow.agents` AND `liveWorkflow.agents` so the two surfaces
 * (draft chat in playground, live `/api/v1/{projectId}/chat`) stay in
 * lockstep AND both the Coworker (SMS/voice) and OwnerCoworker (owner
 * dashboard) agents reflect the edit. Without the live update, the
 * production tunnel would keep serving the old prompt even after a draft
 * save; without the all-agents update, owner-dashboard memory edits would
 * never reach the OwnerCoworker prompt.
 *
 * `matchedCount === 0` is treated as a hard failure (mongosh `quit(1)`)
 * so the orchestrator surfaces it as `ssh_failed` instead of silently
 * reporting success when the targeted project doesn't exist on the VPS
 * (e.g. `business_configs.rowboat_project_id` got out of sync with the
 * on-VPS Mongo, or someone wiped the project document manually). The
 * surrounding `set -euo pipefail` then fails the whole command.
 *
 * The `projectId` parameter is the already-resolved Mongo target — single
 * source of truth from {@link syncVaultToVps}. Bugbot Low on PR #60
 * called out that the previous version re-ran `resolveSyncProjectId`
 * internally AND the caller did the same for its return value: today
 * they agreed because the function was pure with identical inputs, but
 * a future change to the resolution inside this function that wasn't
 * mirrored at the caller would silently desync the drift signal from
 * the actual targeted document. Threading the resolved id in as a
 * parameter eliminates that class of bug entirely.
 *
 * Exported for tests — the unit suite asserts on key substrings of the
 * generated command (e.g. base64 contents, mongo update path, exit
 * sentinel) without needing to spin a real SSH listener.
 */
export function buildSyncVaultCommand(
  config: Pick<ConfigRow, "soul_md" | "identity_md" | "memory_md" | "website_md">,
  projectId: string,
  instructions: string,
  now: Date
): string {
  // The `?? ""` fallbacks here and in `enc` are defense-in-depth nets for
  // a misshapen ConfigRow; ConfigRow's `text` columns are NON-NULL at the
  // DB layer, and {@link buildAgentInstructions} already filters non-
  // strings upstream, so these branches are unreachable on a healthy
  // code path. We keep them so a future column-add doesn't accidentally
  // produce `undefined.toString()` if a caller forgets to initialize the
  // new field.
  /* c8 ignore start -- defense-in-depth fallbacks unreachable on healthy ConfigRow */
  const enc = (s: string) => Buffer.from(s ?? "", "utf8").toString("base64");
  const soulB64 = enc(config.soul_md ?? "");
  const identityB64 = enc(config.identity_md ?? "");
  const memoryB64 = enc(config.memory_md ?? "");
  const websiteB64 = enc(config.website_md ?? "");
  /* c8 ignore stop */
  const instructionsB64 = enc(instructions);
  // JSON.stringify keeps the mongosh literal robust against any oddball
  // characters that slip past the upstream uuid validation.
  const projectIdJson = JSON.stringify(projectId);
  const nowIso = now.toISOString();

  return [
    "set -euo pipefail",
    "mkdir -p /opt/rowboat/vault",
    `printf %s '${soulB64}'    | base64 -d > /opt/rowboat/vault/soul.md`,
    `printf %s '${identityB64}' | base64 -d > /opt/rowboat/vault/identity.md`,
    `printf %s '${memoryB64}'  | base64 -d > /opt/rowboat/vault/memory.md`,
    `printf %s '${websiteB64}' | base64 -d > /opt/rowboat/vault/website.md`,
    `INST_FILE=$(mktemp)`,
    `printf %s '${instructionsB64}' | base64 -d > "$INST_FILE"`,
    `SEED_FILE=$(mktemp --suffix=.js)`,
    // Build the mongosh script: read instructions from disk via fs.readFileSync
    // so we don't have to escape the markdown a second time through bash. The
    // `mongosh --shell` runtime exposes `fs` natively.
    `cat > "$SEED_FILE" <<'MONGOSH_EOF'`,
    `const fs = require("fs");`,
    `const inst = fs.readFileSync(process.env.INST_FILE_PATH, "utf8");`,
    // Update EVERY agent's instructions, not just agents.0. The workflow now
    // has two vault-grounded agents (Coworker for SMS/voice + OwnerCoworker
    // for the owner dashboard), both seeded with identical instructions by
    // deploy-client.sh. The old `agents.0.instructions` hardcode only
    // refreshed Coworker, so owner-dashboard memory edits never reached the
    // OwnerCoworker prompt the owner actually talks to — a "saved" rule
    // silently failed to take effect on re-test. The aggregation pipeline
    // ($map + $mergeObjects) rewrites only the instructions field of each
    // agent and preserves the rest of every agent doc.
    //
    // `inst` MUST be wrapped in `$literal`: inside an aggregation expression,
    // a string starting with `$` is interpreted as a field path/variable, so
    // a vault whose instructions begin with `$` (e.g. memory starting with a
    // price like "$100 minimum budget") would otherwise resolve to null and
    // WIPE the agent prompt. $literal forces it to be treated as plain text.
    `const mapAgents = (p) => ({ $map: { input: { $ifNull: ["$" + p, []] }, as: "a", in: { $mergeObjects: ["$$a", { instructions: { $literal: inst } }] } } });`,
    `const r = db.projects.updateOne(`,
    `  { _id: ${projectIdJson} },`,
    `  [ { $set: {`,
    `      "draftWorkflow.agents": mapAgents("draftWorkflow.agents"),`,
    `      "liveWorkflow.agents": mapAgents("liveWorkflow.agents"),`,
    `      "lastUpdatedAt": ${JSON.stringify(nowIso)}`,
    `  } } ]`,
    `);`,
    `print("matched=" + r.matchedCount + " modified=" + r.modifiedCount + " inst.length=" + inst.length);`,
    // Hard fail when the target project doesn't exist on this VPS — see
    // the function-level comment for why silent zero-matches are dangerous.
    `if (r.matchedCount === 0) { print("vault_sync_target_missing _id=" + ${projectIdJson}); quit(1); }`,
    `MONGOSH_EOF`,
    `docker compose -f /opt/rowboat/docker-compose.yml cp "$SEED_FILE" mongo:/tmp/sync-vault.js > /dev/null`,
    `docker compose -f /opt/rowboat/docker-compose.yml cp "$INST_FILE" mongo:/tmp/sync-vault.inst > /dev/null`,
    `docker compose -f /opt/rowboat/docker-compose.yml exec -T -e INST_FILE_PATH=/tmp/sync-vault.inst mongo mongosh --quiet rowboat /tmp/sync-vault.js`,
    `docker compose -f /opt/rowboat/docker-compose.yml exec -T mongo rm -f /tmp/sync-vault.js /tmp/sync-vault.inst > /dev/null || true`,
    `rm -f "$INST_FILE" "$SEED_FILE"`,
    `echo "vault_synced=ok"`
  ].join("\n");
}

/**
 * Push the latest `business_configs` vault to the live VPS and refresh the
 * MongoDB project's agent prompt. See module header for the full rationale
 * — TL;DR: dashboard memory edits previously never reached the agent; this
 * closes that loop. Idempotent.
 */
export async function syncVaultToVps(
  businessId: string,
  deps: VaultSyncDeps = {}
): Promise<VaultSyncResult> {
  // Production default-deps fallbacks: unit tests always inject explicit
  // deps for determinism, so the right-hand side of each `??` is only
  // exercised in production / integration. Wrap as a block so v8's
  // branch counter doesn't flag each fallback as an uncovered conditional.
  /* c8 ignore start -- production default-deps; unit tests inject explicit deps */
  const fetchConfig = deps.fetchConfig ?? getBusinessConfig;
  const fetchBusiness = deps.fetchBusiness ?? getBusiness;
  const fetchSshKey = deps.fetchSshKey ?? getActiveVpsSshKeyForBusiness;
  const resolveIp = deps.resolveIp ?? defaultResolveIp;
  const exec = deps.exec ?? sshExec;
  const now = (deps.now ?? (() => new Date()))();
  /* c8 ignore stop */

  const [biz, config, key] = await Promise.all([
    fetchBusiness(businessId),
    fetchConfig(businessId),
    fetchSshKey(businessId)
  ]);

  if (!biz) return { ok: false, reason: "no_business" };
  if (!config) return { ok: false, reason: "no_business_config" };
  if (!biz.hostinger_vps_id) return { ok: false, reason: "no_vps_assigned" };
  if (!key) return { ok: false, reason: "no_ssh_key" };

  // The default IP resolver short-circuits to `null` when
  // HOSTINGER_API_TOKEN is missing. Treat that as a distinct failure
  // mode so dev environments don't appear "broken" — they just can't
  // reach the live VPS, which is fine.
  if (!process.env.HOSTINGER_API_TOKEN && deps.resolveIp === undefined) {
    return { ok: false, reason: "no_hostinger_token" };
  }

  const publicIp = await resolveIp(biz.hostinger_vps_id);
  if (!publicIp) return { ok: false, reason: "no_public_ip" };

  const instructions = buildAgentInstructions(config);
  // Single resolution point: the value we report in `result.projectId`
  // (used as the drift signal in `syncVaultToVpsAndLog`'s log) is the
  // EXACT same string we ask mongosh to update. See the doc on
  // `buildSyncVaultCommand` for the Bugbot Low motivation.
  const projectId = resolveSyncProjectId(businessId, config);
  const command = buildSyncVaultCommand(config, projectId, instructions, now);

  let result: SshExecResult;
  try {
    result = await exec({
      host: publicIp,
      port: 22,
      username: key.ssh_username,
      privateKeyPem: key.private_key_pem,
      command,
      // Vault sync is small (a few KB) but it does an exec into the
      // mongo container, which can sit behind a 5–15s docker-cli
      // warmup on cold VPSes. 60s is plenty for the steady state and
      // generous on the cold path; we still want a hard upper bound
      // so a hung VPS doesn't pin the orchestrator forever.
      timeoutMs: 60_000
    });
  } catch (err) {
    return {
      ok: false,
      reason: "ssh_failed",
      detail: err instanceof Error ? err.message : String(err)
    };
  }

  if (result.exitCode !== 0) {
    return {
      ok: false,
      reason: "ssh_failed",
      detail: `exit ${result.exitCode}: ${(result.stderr || result.stdout).slice(-400)}`
    };
  }

  return {
    ok: true,
    hostingerVpsId: biz.hostinger_vps_id,
    publicIp,
    projectId,
    instructionsLength: instructions.length
  };
}

/**
 * Fire-and-forget convenience wrapper for API routes. Logs the outcome
 * and never throws — the caller's primary write to Supabase is the
 * source of truth and must NOT be reverted because the VPS is
 * unreachable.
 *
 * Use this from `/api/business/config` and `/api/onboard/website-ingest`
 * AFTER the Supabase write succeeds. Mark the call with `void` (or
 * `await` it inside `Promise.allSettled`) to signal the contract.
 */
export async function syncVaultToVpsAndLog(
  businessId: string,
  deps: VaultSyncDeps = {}
): Promise<void> {
  try {
    const result = await syncVaultToVps(businessId, deps);
    if (result.ok) {
      logger.info("vault sync ok", {
        businessId,
        hostingerVpsId: result.hostingerVpsId,
        projectId: result.projectId,
        // Drift signal: when this is true, the tenant's
        // `business_configs.rowboat_project_id` points at a project
        // whose id ISN'T the businessId — typically a manually-seeded
        // project. Worth surfacing in logs so we can spot tenants who
        // are off the standard provisioning path.
        projectIdDriftedFromBusinessId: result.projectId !== businessId,
        instructionsLength: result.instructionsLength
      });
    } else {
      // Most non-OK reasons are operational (no_vps_assigned during onboarding,
      // no_hostinger_token in dev) and not bugs. Logging at warn keeps them
      // visible in monitoring without paging on healthy code paths.
      logger.warn("vault sync skipped", {
        businessId,
        reason: result.reason,
        detail: result.detail
      });
    }
  } catch (err) {
    /* c8 ignore next 4 -- syncVaultToVps catches its own throwables; this is a defense-in-depth net for unexpected import-time failures */
    logger.warn("vault sync threw", {
      businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

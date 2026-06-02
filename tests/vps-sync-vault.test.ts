/**
 * Unit tests for `lib/vps/sync-vault.ts`.
 *
 * Covers:
 *   1. `buildAgentInstructions` ordering, blank-skip, fallback semantics —
 *      it's the TS twin of the same composition that runs in
 *      `vps/scripts/deploy-client.sh:422`. A drift in either direction
 *      silently breaks the agent's grounding.
 *   2. `buildSyncVaultCommand` — base64 encoding of vault contents,
 *      mongosh update path, idempotent cleanup. Asserts on key
 *      substrings rather than the full command string so cosmetic
 *      whitespace/line-break tweaks don't churn the suite.
 *   3. `syncVaultToVps` — every guard (no_business / no_business_config /
 *      no_vps_assigned / no_ssh_key / no_hostinger_token / no_public_ip)
 *      and the SSH success/failure paths, all via injected deps.
 *   4. `syncVaultToVpsAndLog` — never throws, logs ok/skipped paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  buildAgentInstructions,
  buildSyncVaultCommand,
  DEFAULT_AGENT_INSTRUCTIONS_FALLBACK,
  resolveSyncProjectId,
  syncVaultToVps,
  syncVaultToVpsAndLog,
  type VaultSyncDeps
} from "@/lib/vps/sync-vault";
import { logger } from "@/lib/logger";

const BIZ = "11111111-1111-4111-8111-111111111111";

const FULL_CONFIG = {
  business_id: BIZ,
  soul_md: "# soul\nbe nice",
  identity_md: "# identity\nAcme Co",
  memory_md: "# memory\nthings i know",
  website_md: "# website\npublic site summary",
  rowboat_project_id: BIZ,
  updated_at: "2026-05-03T00:00:00Z"
};

const FULL_BIZ = {
  id: BIZ,
  name: "Acme",
  owner_email: "owner@acme.com",
  tier: "starter" as const,
  status: "online" as const,
  hostinger_vps_id: "1632631",
  created_at: "2026-04-30T00:00:00Z"
};

const FULL_KEY = {
  id: "k1",
  business_id: BIZ,
  hostinger_vps_id: "1632631",
  hostinger_public_key_id: 42,
  public_key: "ssh-ed25519 AAA",
  private_key_pem: "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n-----END OPENSSH PRIVATE KEY-----\n",
  fingerprint_sha256: "SHA256:fp",
  ssh_username: "root",
  created_at: "2026-04-30T00:00:00Z",
  rotated_at: null
};

function freshDeps(overrides: Partial<VaultSyncDeps> = {}): Required<VaultSyncDeps> {
  return {
    fetchConfig: vi.fn(async () => FULL_CONFIG),
    fetchBusiness: vi.fn(async () => FULL_BIZ),
    fetchSshKey: vi.fn(async () => FULL_KEY),
    resolveIp: vi.fn(async () => "203.0.113.1"),
    exec: vi.fn(async () => ({ exitCode: 0, signal: null, stdout: "vault_synced=ok\n", stderr: "" })),
    now: () => new Date("2026-05-03T12:00:00Z"),
    ...overrides
  } as Required<VaultSyncDeps>;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  vi.clearAllMocks();
  // The default IP-resolver short-circuits to `null` when this is unset.
  // Set it so the env-guard branch in the code doesn't fire — tests
  // exercising that branch override locally.
  process.env.HOSTINGER_API_TOKEN = "test-token";
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("buildAgentInstructions", () => {
  it("joins identity → soul → website → memory in deploy-client.sh order so the bash and TS paths produce identical prompts", () => {
    const out = buildAgentInstructions(FULL_CONFIG);
    // The exact order matters: deploy-client.sh:422 uses
    // [$id, $soul, $web, $mem] and the agent's grounding depends on
    // identity coming first. Pin it as a regression boundary.
    const idxIdentity = out.indexOf("# identity");
    const idxSoul = out.indexOf("# soul");
    const idxWebsite = out.indexOf("# website");
    const idxMemory = out.indexOf("# memory");
    expect(idxIdentity).toBeGreaterThanOrEqual(0);
    expect(idxIdentity).toBeLessThan(idxSoul);
    expect(idxSoul).toBeLessThan(idxWebsite);
    expect(idxWebsite).toBeLessThan(idxMemory);
    expect(out).toContain("\n\n");
  });

  it("skips blank/whitespace-only sections so the joined output never has stray empty stanzas", () => {
    const out = buildAgentInstructions({
      ...FULL_CONFIG,
      website_md: "",
      memory_md: "   \n\t"
    });
    expect(out).toContain("# identity");
    expect(out).toContain("# soul");
    expect(out).not.toContain("\n\n\n\n");
  });

  it("returns the canonical fallback when EVERY field is blank (agent gets a baseline persona, not an empty system prompt)", () => {
    const out = buildAgentInstructions({
      soul_md: "",
      identity_md: "",
      memory_md: "",
      website_md: ""
    });
    expect(out).toBe(DEFAULT_AGENT_INSTRUCTIONS_FALLBACK);
  });

  it("treats a config with non-string fields as blank (defends against a misshapen DB row without crashing)", () => {
    const out = buildAgentInstructions({
      // Cast through unknown to feed a deliberately misshapen row — the
      // production DB column is `text not null` but defense-in-depth
      // matters because a bad migration could leave the row malformed.
      soul_md: null as unknown as string,
      identity_md: undefined as unknown as string,
      memory_md: 42 as unknown as string,
      website_md: ""
    });
    expect(out).toBe(DEFAULT_AGENT_INSTRUCTIONS_FALLBACK);
  });
});

describe("resolveSyncProjectId", () => {
  // Codex P2 review on PR #59 caught a divergence: the runtime chat route
  // resolves the project id from `business_configs.rowboat_project_id`
  // first (falling back to businessId only when null), but the original
  // sync path hard-coded the businessId. On tenants whose two values
  // differed (manual seed, future migration), the sync would target the
  // wrong/no project document while reporting `ok: true`. These tests
  // pin the corrected resolution against the chat route's behavior.
  it("uses business_configs.rowboat_project_id when it differs from businessId (manual seed / drifted row)", () => {
    expect(
      resolveSyncProjectId("biz-uuid", { rowboat_project_id: "custom-project-uuid" })
    ).toBe("custom-project-uuid");
  });

  it("falls back to businessId when rowboat_project_id is null (orchestrator's default provisioning leaves them equal)", () => {
    expect(resolveSyncProjectId("biz-uuid", { rowboat_project_id: null })).toBe("biz-uuid");
  });

  it("treats undefined rowboat_project_id as null (older rows missing the column)", () => {
    expect(resolveSyncProjectId("biz-uuid", { rowboat_project_id: undefined })).toBe("biz-uuid");
  });

  it("treats whitespace-only rowboat_project_id as unset (defends against accidental empty patches)", () => {
    expect(resolveSyncProjectId("biz-uuid", { rowboat_project_id: "   " })).toBe("biz-uuid");
  });

  it("trims surrounding whitespace from a valid rowboat_project_id (mirrors the chat route's `.trim()`)", () => {
    expect(
      resolveSyncProjectId("biz-uuid", { rowboat_project_id: "  custom-project  " })
    ).toBe("custom-project");
  });
});

describe("buildSyncVaultCommand", () => {
  const NOW = new Date("2026-05-03T12:00:00Z");

  it("base64-encodes each vault file so quotes/backticks/dollar signs in the markdown can't break shell quoting", () => {
    const cmd = buildSyncVaultCommand(FULL_CONFIG, BIZ, "INST", NOW);
    // Identity content `# identity\nAcme Co` base64-encodes to a
    // recognizable prefix; substring check avoids hardcoding the full
    // base64 to keep the assertion forward-compatible with content
    // tweaks while still confirming the encoding path is in use.
    const identityB64 = Buffer.from(FULL_CONFIG.identity_md).toString("base64");
    expect(cmd).toContain(`'${identityB64}'`);
    // Stage to /opt/rowboat/vault/identity.md via base64 -d + redirect.
    expect(cmd).toContain("base64 -d > /opt/rowboat/vault/identity.md");
    expect(cmd).toContain("base64 -d > /opt/rowboat/vault/soul.md");
    expect(cmd).toContain("base64 -d > /opt/rowboat/vault/memory.md");
    expect(cmd).toContain("base64 -d > /opt/rowboat/vault/website.md");
  });

  it("updates EVERY agent (not just agents.0) across BOTH draftWorkflow and liveWorkflow so Coworker + OwnerCoworker stay in lockstep and owner-dashboard memory edits reach the agent the owner talks to", () => {
    const cmd = buildSyncVaultCommand(FULL_CONFIG, BIZ, "INSTRUCTIONS", NOW);
    // Aggregation-pipeline update: $map over the agents array rewrites only
    // the instructions field of each agent (preserving the rest via
    // $mergeObjects). Regression guard against the old `agents.0` hardcode
    // that left OwnerCoworker stale.
    expect(cmd).toContain('"draftWorkflow.agents": mapAgents("draftWorkflow.agents")');
    expect(cmd).toContain('"liveWorkflow.agents": mapAgents("liveWorkflow.agents")');
    expect(cmd).toContain("$map");
    expect(cmd).toContain('$mergeObjects: ["$$a", { instructions: inst }]');
    // Must be a pipeline update (array form) for $map/$mergeObjects to work.
    expect(cmd).toContain(`[ { $set: {`);
    // The old single-field hardcode must be gone.
    expect(cmd).not.toContain('"draftWorkflow.agents.0.instructions"');
    expect(cmd).not.toContain('"liveWorkflow.agents.0.instructions"');
    // The mongo filter uses the bare `_id` shorthand (Mongo permits it
    // without quoting); just confirm the projectId reaches the script.
    expect(cmd).toContain(`{ _id: "${BIZ}" }`);
    // ISO timestamp is JSON-stringified into the seed script.
    expect(cmd).toContain(`"lastUpdatedAt": "${NOW.toISOString()}"`);
  });

  it("reads the instructions blob from a temp file inside the mongo container instead of inlining it (avoids shell-escaping markdown twice)", () => {
    const cmd = buildSyncVaultCommand(FULL_CONFIG, BIZ, "INSTRUCTIONS", NOW);
    // Hand-off path: write inst to host temp → docker cp into container
    // → read via fs.readFileSync(process.env.INST_FILE_PATH).
    expect(cmd).toContain("docker compose -f /opt/rowboat/docker-compose.yml cp");
    expect(cmd).toContain("INST_FILE_PATH=/tmp/sync-vault.inst");
    expect(cmd).toContain('fs.readFileSync(process.env.INST_FILE_PATH, "utf8")');
  });

  it("ends with `vault_synced=ok` so the orchestrator can grep for the success sentinel and distinguish 'ssh OK + script crashed mid-flight' from a clean run", () => {
    const cmd = buildSyncVaultCommand(FULL_CONFIG, BIZ, "INST", NOW);
    expect(cmd.trim().endsWith('echo "vault_synced=ok"')).toBe(true);
  });

  it("starts with `set -euo pipefail` so a failure in any pipeline step (base64 decode, docker cp, mongosh) propagates as a non-zero exit code", () => {
    const cmd = buildSyncVaultCommand(FULL_CONFIG, BIZ, "INST", NOW);
    expect(cmd.startsWith("set -euo pipefail")).toBe(true);
  });

  it("base64-encodes empty fields to empty strings so an unset website.md still gets a deterministic blank file (not a stale prior content)", () => {
    const cmd = buildSyncVaultCommand(
      { ...FULL_CONFIG, website_md: "" },
      BIZ,
      "INST",
      NOW
    );
    // Empty buffer base64-encodes to the empty string — the line still
    // executes (`base64 -d > .../website.md` from an empty input) and
    // truncates the file to zero bytes.
    expect(cmd).toContain("printf %s ''");
  });

  it("uses the EXACT projectId the caller supplies — single source of truth from syncVaultToVps", () => {
    // Bugbot Low on PR #60: previously this function called
    // `resolveSyncProjectId` internally AND the caller did the same for
    // its return value. Today they agreed because the resolver was pure
    // with identical inputs, but a future change to the in-function
    // resolution that wasn't mirrored at the caller would silently
    // desync the drift signal from the actually-targeted document. The
    // refactor threads `projectId` in as a parameter so this whole class
    // of bug is structurally impossible. Pin it.
    const cmd = buildSyncVaultCommand(FULL_CONFIG, "drifted-project-id", "INST", NOW);
    expect(cmd).toContain('{ _id: "drifted-project-id" }');
    expect(cmd).not.toContain(`{ _id: "${BIZ}" }`);
    // Same diagnostic must reference the supplied id, not the businessId.
    expect(cmd).toContain('vault_sync_target_missing _id=" + "drifted-project-id"');
  });

  it("JSON-stringifies the projectId so embedded quotes can't escape the mongosh literal", () => {
    // Defense-in-depth: callers should pass UUIDs that pass upstream
    // validation, but if a malformed value ever slips through (e.g. from
    // a future raw-SQL backfill) JSON.stringify keeps the embedded
    // mongosh string a valid JS string literal instead of a syntax error
    // or — worse — a code injection.
    const cmd = buildSyncVaultCommand(FULL_CONFIG, 'evil"; print("pwned"); //', "INST", NOW);
    // The escaped form makes the dquote literal, so mongosh sees it as
    // a benign string rather than terminating early.
    expect(cmd).toContain('"evil\\"; print(\\"pwned\\"); //"');
  });

  it("hard-fails the sync when matchedCount === 0 so a drifted projectId surfaces as ssh_failed instead of silent success", () => {
    const cmd = buildSyncVaultCommand(FULL_CONFIG, BIZ, "INST", NOW);
    // `r.matchedCount === 0` is treated as fatal — without this, a tenant
    // whose project id got out of sync with their VPS Mongo would see
    // `ok: true` while their agent kept serving the stale prompt.
    expect(cmd).toMatch(/r\.matchedCount\s*===\s*0/);
    expect(cmd).toContain("quit(1)");
    // Diagnostic line so the orchestrator's stderr-tail logging shows
    // exactly which projectId was requested when this fires.
    expect(cmd).toContain("vault_sync_target_missing");
  });
});

describe("syncVaultToVps — guards", () => {
  it("returns no_business when the businesses lookup misses (orchestrator was called for a deleted/nonexistent biz)", async () => {
    const deps = freshDeps({ fetchBusiness: vi.fn(async () => null) });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r).toEqual({ ok: false, reason: "no_business" });
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns no_business_config when the business exists but has never been onboarded", async () => {
    const deps = freshDeps({ fetchConfig: vi.fn(async () => null) });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r).toEqual({ ok: false, reason: "no_business_config" });
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns no_vps_assigned for pre-checkout drafts (the keepalive ingest fires before a VPS exists)", async () => {
    const deps = freshDeps({
      fetchBusiness: vi.fn(async () => ({ ...FULL_BIZ, hostinger_vps_id: null }))
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r).toEqual({ ok: false, reason: "no_vps_assigned" });
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns no_ssh_key when the active key was rotated/deleted (orchestrator can't authenticate)", async () => {
    const deps = freshDeps({ fetchSshKey: vi.fn(async () => null) });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r).toEqual({ ok: false, reason: "no_ssh_key" });
    expect(deps.exec).not.toHaveBeenCalled();
  });

  it("returns no_hostinger_token in dev environments where the API token isn't set (and no resolveIp override given)", async () => {
    delete process.env.HOSTINGER_API_TOKEN;
    // Build deps WITHOUT a resolveIp override so the env-guard fires.
    const fetchConfig = vi.fn(async () => FULL_CONFIG);
    const fetchBusiness = vi.fn(async () => FULL_BIZ);
    const fetchSshKey = vi.fn(async () => FULL_KEY);
    const exec = vi.fn();
    const r = await syncVaultToVps(BIZ, {
      fetchConfig,
      fetchBusiness,
      fetchSshKey,
      exec: exec as never,
      now: () => new Date("2026-05-03T12:00:00Z")
    });
    expect(r).toEqual({ ok: false, reason: "no_hostinger_token" });
    expect(exec).not.toHaveBeenCalled();
  });

  it("returns no_public_ip when Hostinger reports the VPS has no IP yet (race with first-boot)", async () => {
    const deps = freshDeps({ resolveIp: vi.fn(async () => null) });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r).toEqual({ ok: false, reason: "no_public_ip" });
    expect(deps.exec).not.toHaveBeenCalled();
  });
});

describe("syncVaultToVps — success path", () => {
  it("invokes ssh with the resolved IP, the active key's username + private key, and the generated command", async () => {
    const deps = freshDeps();
    const r = await syncVaultToVps(BIZ, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.hostingerVpsId).toBe("1632631");
    expect(r.publicIp).toBe("203.0.113.1");
    // The default fixture has rowboat_project_id === businessId, so the
    // resolved target is the businessId — same as the chat route's
    // resolution. The dedicated drift tests below cover the divergent
    // case.
    expect(r.projectId).toBe(BIZ);
    expect(r.instructionsLength).toBeGreaterThan(0);
    expect(deps.exec).toHaveBeenCalledTimes(1);
    const call = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.host).toBe("203.0.113.1");
    expect(call.username).toBe("root");
    expect(call.privateKeyPem).toContain("BEGIN OPENSSH PRIVATE KEY");
    // Sanity-check the command body — we already exhaustively test
    // `buildSyncVaultCommand`, so just confirm the wiring connects.
    expect(call.command).toContain('echo "vault_synced=ok"');
  });

  it("uses the generously-large 60s timeout so a cold docker exec into mongo doesn't tip the orchestrator into a false ssh_failed", async () => {
    const deps = freshDeps();
    await syncVaultToVps(BIZ, deps);
    const call = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.timeoutMs).toBe(60_000);
  });

  it("propagates a drifted business_configs.rowboat_project_id all the way to the SSH command AND the returned result.projectId", async () => {
    const driftedConfig = { ...FULL_CONFIG, rowboat_project_id: "different-id" };
    const deps = freshDeps({
      fetchConfig: vi.fn(async () => driftedConfig)
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The result tells the caller the actual targeted id, NOT the
    // businessId — observability for tenants on the divergent path.
    expect(r.projectId).toBe("different-id");
    // The bash command targets the same id.
    const call = (deps.exec as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.command).toContain('{ _id: "different-id" }');
  });
});

describe("syncVaultToVps — ssh failure paths", () => {
  it("captures a thrown ssh error as ssh_failed with the message tail (no_route_to_host, ETIMEDOUT, etc.)", async () => {
    const deps = freshDeps({
      exec: vi.fn(async () => {
        throw new Error("ETIMEDOUT 203.0.113.1:22");
      })
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r).toEqual({
      ok: false,
      reason: "ssh_failed",
      detail: "ETIMEDOUT 203.0.113.1:22"
    });
  });

  it("converts non-Error throws via String() so an unusual reject-with-string doesn't crash the helper", async () => {
    const deps = freshDeps({
      exec: vi.fn(async () => {
        throw "raw reject string";
      })
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ssh_failed");
      expect(r.detail).toBe("raw reject string");
    }
  });

  it("returns ssh_failed when the script exited non-zero and surfaces the stderr tail so support can diagnose the actual remote failure", async () => {
    const deps = freshDeps({
      exec: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        stdout: "",
        stderr: "MongoServerError: not authorized\n".repeat(20)
      }))
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ssh_failed");
      // The detail is bounded so a multi-MB stderr can't blow up the
      // log line; the tail is what's relevant for diagnosis.
      expect(r.detail?.startsWith("exit 1: ")).toBe(true);
      expect(r.detail?.length).toBeLessThan(500);
    }
  });

  it("falls back to stdout in the detail when stderr is empty (some mongosh failures report only on stdout)", async () => {
    const deps = freshDeps({
      exec: vi.fn(async () => ({
        exitCode: 2,
        signal: null,
        stdout: "MONGOSH: cannot connect after 30s",
        stderr: ""
      }))
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.detail).toContain("cannot connect after 30s");
    }
  });

  it("surfaces a missing-project failure as ssh_failed with the diagnostic sentinel so a drifted rowboat_project_id can't masquerade as silent success", async () => {
    // Simulates the on-VPS scenario where `business_configs.rowboat_project_id`
    // points at a project that no longer exists in the per-tenant Mongo.
    // The mongosh script's `quit(1)` triggers `set -e` to fail the whole
    // bash command; the wrapper sees exitCode !== 0 and surfaces the
    // sentinel via the stderr/stdout tail.
    const deps = freshDeps({
      exec: vi.fn(async () => ({
        exitCode: 1,
        signal: null,
        stdout: 'matched=0 modified=0 inst.length=42\nvault_sync_target_missing _id="missing-project"\n',
        stderr: ""
      }))
    });
    const r = await syncVaultToVps(BIZ, deps);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ssh_failed");
      expect(r.detail).toContain("vault_sync_target_missing");
    }
  });
});

describe("syncVaultToVpsAndLog", () => {
  it("logs at info on success with the businessId + projectId + instructionsLength so we have an audit trail per save", async () => {
    await syncVaultToVpsAndLog(BIZ, freshDeps());
    expect(logger.info).toHaveBeenCalledWith(
      "vault sync ok",
      expect.objectContaining({
        businessId: BIZ,
        projectId: BIZ,
        // Default fixture has rowboat_project_id === businessId.
        projectIdDriftedFromBusinessId: false
      })
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("flags the drift signal when the targeted projectId differs from the businessId so we can spot legacy/manual rows in production logs", async () => {
    const driftedConfig = { ...FULL_CONFIG, rowboat_project_id: "different-id" };
    await syncVaultToVpsAndLog(BIZ, freshDeps({
      fetchConfig: vi.fn(async () => driftedConfig)
    }));
    expect(logger.info).toHaveBeenCalledWith(
      "vault sync ok",
      expect.objectContaining({
        businessId: BIZ,
        projectId: "different-id",
        projectIdDriftedFromBusinessId: true
      })
    );
  });

  it("logs at warn (not error) for non-ok results so we don't page on healthy code paths like dev no_hostinger_token", async () => {
    delete process.env.HOSTINGER_API_TOKEN;
    await syncVaultToVpsAndLog(BIZ, {
      fetchConfig: async () => FULL_CONFIG,
      fetchBusiness: async () => FULL_BIZ,
      fetchSshKey: async () => FULL_KEY
    });
    expect(logger.warn).toHaveBeenCalledWith(
      "vault sync skipped",
      expect.objectContaining({ reason: "no_hostinger_token" })
    );
    expect(logger.info).not.toHaveBeenCalled();
  });

  it("never throws — even when the underlying syncVaultToVps rejects, the API caller's response must not be affected", async () => {
    // syncVaultToVps catches its own ssh throws, but if a future
    // refactor adds a synchronous throw above the try/catch, the
    // wrapper here is the safety net for the API route's `void`
    // fire-and-forget contract. Verify by feeding a fetchBusiness
    // that rejects synchronously.
    const deps = freshDeps({
      fetchBusiness: vi.fn(() => {
        throw new Error("sync throw");
      }) as never
    });
    await expect(syncVaultToVpsAndLog(BIZ, deps)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      "vault sync threw",
      expect.objectContaining({ businessId: BIZ })
    );
  });
});

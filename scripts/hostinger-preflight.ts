#!/usr/bin/env tsx
/**
 * Hostinger provisioning preflight — end-to-end dry run against the LIVE API.
 *
 * Exercises every primitive `orchestrateProvisioning` depends on EXCEPT the one
 * that spends money (`POST /api/vps/v1/virtual-machines`). Everything else —
 * catalog lookup, payment-method presence, data-center / template verification,
 * public-key create + delete, post-install script create + delete — is invoked
 * for real and cleaned up before exit.
 *
 * Why this exists:
 *   - Catches auth / permission / quota / account-state regressions BEFORE a
 *     tenant onboarding tries to purchase a VPS and blows up mid-flight.
 *   - Confirms the SKUs we hardcode in `DEFAULT_TIER_PRICE_ITEM` still resolve.
 *   - Confirms the Boston DC (`DEFAULT_US_DATA_CENTER_ID`) and Ubuntu 24.04
 *     Docker template (`DEFAULT_TEMPLATE_ID`) are still live.
 *   - Confirms at least one non-expired, non-suspended payment method is on
 *     file — otherwise a real purchase would 402.
 *
 * Usage:
 *   HOSTINGER_API_TOKEN=… npx tsx scripts/hostinger-preflight.ts
 *   HOSTINGER_API_TOKEN=… npx tsx scripts/hostinger-preflight.ts --json
 *   HOSTINGER_API_TOKEN=… npx tsx scripts/hostinger-preflight.ts --keep
 *
 * Exit codes:
 *   0  — all checks passed
 *   1  — at least one check failed (cleanup is still attempted)
 *   2  — required env missing or bad CLI args
 *
 * See `src/lib/hostinger/client.ts` for the endpoint surface and
 * `src/lib/hostinger/provision.ts` for the SKU / DC / template defaults we
 * validate against.
 */
import {
  HostingerApiError,
  HostingerClient,
  DEFAULT_HOSTINGER_BASE_URL,
  type PaymentMethod,
  type PostInstallScript,
  type PublicKey
} from "@/lib/hostinger/client";
import { generateSshKeypair } from "@/lib/hostinger/keypair";
import {
  DEFAULT_TEMPLATE_ID,
  DEFAULT_TIER_PRICE_ITEM,
  DEFAULT_US_DATA_CENTER_ID
} from "@/lib/hostinger/provision";

export type PreflightArgs = {
  json: boolean;
  /** Skip deletion of the throwaway public key / post-install script (for debugging). */
  keep: boolean;
  /** Skip the payment-method check (useful for read-only/viewer API tokens). */
  skipPaymentCheck: boolean;
};

export type PreflightCheck = {
  name: string;
  ok: boolean;
  detail?: string;
  durationMs: number;
};

export type PreflightReport = {
  ok: boolean;
  baseUrl: string;
  startedAt: string;
  finishedAt: string;
  checks: PreflightCheck[];
  cleanup: {
    publicKeyDeleted: boolean | null;
    postInstallScriptDeleted: boolean | null;
  };
};

export function parsePreflightArgs(argv: string[]): PreflightArgs {
  const out: PreflightArgs = { json: false, keep: false, skipPaymentCheck: false };
  for (const a of argv) {
    if (a === "--json") out.json = true;
    else if (a === "--keep") out.keep = true;
    else if (a === "--skip-payment-check") out.skipPaymentCheck = true;
    else if (a === "--help" || a === "-h") {
      // `process.stdout.write` keeps help output stable in `--json` pipelines.
      process.stdout.write(
        "Usage: tsx scripts/hostinger-preflight.ts [--json] [--keep] [--skip-payment-check]\n"
      );
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${a}`);
    }
  }
  return out;
}

type Logger = {
  step: (name: string, ok: boolean, detail?: string) => void;
};

function humanLogger(): Logger {
  return {
    step(name, ok, detail) {
      const tag = ok ? "OK  " : "FAIL";
      const suffix = detail ? ` — ${detail}` : "";
      console.log(`[preflight] ${tag}  ${name}${suffix}`);
    }
  };
}

function silentLogger(): Logger {
  return { step() {} };
}

/**
 * Run a single named check, catching errors and timing it. We deliberately
 * capture `HostingerApiError.status` in the detail so the operator sees
 * `HTTP 401 …` when the token is revoked or scoped wrong.
 */
async function runCheck<T>(
  name: string,
  checks: PreflightCheck[],
  logger: Logger,
  fn: () => Promise<T>
): Promise<T | undefined> {
  const t0 = Date.now();
  try {
    const result = await fn();
    const durationMs = Date.now() - t0;
    checks.push({ name, ok: true, durationMs });
    logger.step(name, true, `${durationMs}ms`);
    return result;
  } catch (err) {
    const durationMs = Date.now() - t0;
    const detail = errorDetail(err);
    checks.push({ name, ok: false, detail, durationMs });
    logger.step(name, false, detail);
    return undefined;
  }
}

function errorDetail(err: unknown): string {
  if (err instanceof HostingerApiError) {
    return `HTTP ${err.status} ${err.endpoint}: ${err.message}`;
  }
  /* c8 ignore next -- non-Error throwables are defensive */
  return err instanceof Error ? err.message : String(err);
}

export async function runPreflight(
  args: PreflightArgs,
  deps: {
    client: HostingerClient;
    now?: () => Date;
    logger?: Logger;
  }
): Promise<PreflightReport> {
  const client = deps.client;
  const now = deps.now ?? (() => new Date());
  const logger = deps.logger ?? (args.json ? silentLogger() : humanLogger());

  const checks: PreflightCheck[] = [];
  const startedAt = now().toISOString();

  // ---- 1. Catalog: confirm the SKUs we will charge for still exist. ------
  await runCheck("catalog.listCatalog(vps)", checks, logger, async () => {
    const catalog = await client.listCatalog("vps");
    const ids = new Set<string>();
    for (const item of catalog) {
      for (const price of item.prices) ids.add(price.id);
    }
    const required = [DEFAULT_TIER_PRICE_ITEM.starter, DEFAULT_TIER_PRICE_ITEM.standard];
    const missing = required.filter((sku) => !ids.has(sku));
    if (missing.length > 0) {
      throw new Error(`missing price items: ${missing.join(", ")}`);
    }
    return { totalItems: catalog.length, foundSkus: required };
  });

  // ---- 2. Payment methods: at least one default, non-expired, non-suspended.
  //         This is what keeps `POST /virtual-machines` from 402-ing in prod.
  if (!args.skipPaymentCheck) {
    await runCheck("billing.listPaymentMethods()", checks, logger, async () => {
      const methods = await client.listPaymentMethods();
      const usable = methods.filter(
        (m: PaymentMethod) => !m.is_expired && !m.is_suspended
      );
      if (usable.length === 0) {
        throw new Error(
          `no usable payment methods on file (got ${methods.length} total, all expired/suspended/none)`
        );
      }
      const hasDefault = usable.some((m) => m.is_default);
      if (!hasDefault) {
        // Hostinger falls back to *any* usable method when `payment_method_id`
        // is omitted in the purchase body, so this is a warning, not a fatal.
        return { usable: usable.length, hasDefault: false, note: "no default flagged" };
      }
      return { usable: usable.length, hasDefault: true };
    });
  }

  // ---- 3. Data centers: Boston (id 17) must still be in the fleet. -------
  await runCheck("vps.listDataCenters()", checks, logger, async () => {
    const dcs = await client.listDataCenters();
    const match = dcs.find((d) => d.id === DEFAULT_US_DATA_CENTER_ID);
    if (!match) {
      throw new Error(`DEFAULT_US_DATA_CENTER_ID=${DEFAULT_US_DATA_CENTER_ID} not in fleet`);
    }
    return { dc: `${match.name} (${match.city})` };
  });

  // ---- 4. Templates: Ubuntu 24.04 w/ Docker (id 1121) must still exist. --
  await runCheck("vps.listTemplates()", checks, logger, async () => {
    const tpls = await client.listTemplates();
    const match = tpls.find((t) => t.id === DEFAULT_TEMPLATE_ID);
    if (!match) {
      throw new Error(`DEFAULT_TEMPLATE_ID=${DEFAULT_TEMPLATE_ID} not available`);
    }
    return { template: match.name };
  });

  // ---- 5. Public-key round-trip: create a throwaway, list, delete. -------
  //   This proves the token has `vps:write` scope on /public-keys before any
  //   real tenant purchase tries to attach one.
  const keypair = await generateSshKeypair(`preflight-${Date.now()}`);
  const preflightKeyName = `newcoworker-preflight-${Date.now()}`;
  let createdKey: PublicKey | undefined;
  let createdKeyDeleted: boolean | null = null;

  await runCheck("vps.createPublicKey(throwaway)", checks, logger, async () => {
    createdKey = await client.createPublicKey(preflightKeyName, keypair.publicKey.trim());
    if (typeof createdKey.id !== "number") {
      throw new Error("createPublicKey returned no id");
    }
    return { id: createdKey.id, fingerprint: keypair.fingerprintSha256.slice(0, 32) };
  });

  if (createdKey) {
    await runCheck("vps.listPublicKeys() sees throwaway", checks, logger, async () => {
      const keys = await client.listPublicKeys();
      const match = keys.find((k) => k.id === createdKey!.id);
      if (!match) throw new Error(`created key id=${createdKey!.id} not in listPublicKeys()`);
      return { id: match.id };
    });
  }

  // ---- 6. Post-install script round-trip: create + delete. --------------
  //   Smallest possible valid script — only exercises the API surface, not
  //   the production bootstrap (which is 4 KB and lives in `provision.ts`).
  let createdScript: PostInstallScript | undefined;
  let createdScriptDeleted: boolean | null = null;

  const preflightScriptName = `newcoworker-preflight-${Date.now()}`;
  const preflightScriptContent = "#!/bin/bash\nset -euo pipefail\necho preflight-noop\n";

  await runCheck("vps.createPostInstallScript(throwaway)", checks, logger, async () => {
    createdScript = await client.createPostInstallScript(
      preflightScriptName,
      preflightScriptContent
    );
    if (typeof createdScript.id !== "number") {
      throw new Error("createPostInstallScript returned no id");
    }
    return { id: createdScript.id, bytes: preflightScriptContent.length };
  });

  // ---- 7. Cleanup (always attempted, even if earlier checks failed). ----
  //   We honor --keep for manual debugging, but scream about orphans via
  //   the cleanup section of the report.
  if (createdKey && !args.keep) {
    const ok = await runCheck("vps.deletePublicKey(throwaway)", checks, logger, async () => {
      await client.deletePublicKey(createdKey!.id);
      return true;
    });
    createdKeyDeleted = ok === true;
  } else if (createdKey) {
    createdKeyDeleted = false; // explicitly kept
    logger.step(
      "vps.deletePublicKey(throwaway)",
      true,
      `skipped (--keep) — id=${createdKey.id}`
    );
  }

  if (createdScript && !args.keep) {
    const ok = await runCheck(
      "vps.deletePostInstallScript(throwaway)",
      checks,
      logger,
      async () => {
        await client.deletePostInstallScript(createdScript!.id);
        return true;
      }
    );
    createdScriptDeleted = ok === true;
  } else if (createdScript) {
    createdScriptDeleted = false;
    logger.step(
      "vps.deletePostInstallScript(throwaway)",
      true,
      `skipped (--keep) — id=${createdScript.id}`
    );
  }

  const finishedAt = now().toISOString();
  const ok = checks.every((c) => c.ok);

  return {
    ok,
    baseUrl: DEFAULT_HOSTINGER_BASE_URL,
    startedAt,
    finishedAt,
    checks,
    cleanup: {
      publicKeyDeleted: createdKeyDeleted,
      postInstallScriptDeleted: createdScriptDeleted
    }
  };
}

/* c8 ignore start -- CLI entrypoint: exercised end-to-end only by the live preflight itself */
async function main(): Promise<void> {
  let args: PreflightArgs;
  try {
    args = parsePreflightArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const token = process.env.HOSTINGER_API_TOKEN ?? "";
  if (!token) {
    console.error("HOSTINGER_API_TOKEN is required");
    process.exit(2);
  }

  const client = new HostingerClient({
    baseUrl: process.env.HOSTINGER_API_BASE_URL ?? DEFAULT_HOSTINGER_BASE_URL,
    token,
    userAgent: "newcoworker-preflight/1.0"
  });

  const report = await runPreflight(args, { client });

  if (args.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    const passed = report.checks.filter((c) => c.ok).length;
    const total = report.checks.length;
    console.log(
      `[preflight] summary: ${passed}/${total} checks passed (base=${report.baseUrl})`
    );
    if (report.cleanup.publicKeyDeleted === false && args.keep) {
      console.log("[preflight] NOTE: --keep set; throwaway public key NOT deleted");
    }
    if (report.cleanup.postInstallScriptDeleted === false && args.keep) {
      console.log("[preflight] NOTE: --keep set; throwaway post-install script NOT deleted");
    }
  }

  process.exit(report.ok ? 0 : 1);
}

// Only invoke main() when executed directly (not when imported by tests).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("[preflight] fatal:", err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
/* c8 ignore stop */

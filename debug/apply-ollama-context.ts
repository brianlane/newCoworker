/**
 * Apply the per-size `OLLAMA_CONTEXT_LENGTH` from bootstrap.sh to live boxes.
 *
 * WHY this exists: bootstrap.sh runs at PROVISION time. Editing it fixes new
 * boxes and does nothing for existing ones, and the fleet has been running
 * since long before the fix (Amy's box still carries systemd comments that
 * were rewritten in the repo weeks ago). Ollama defaults to a 4096-token
 * context and silently TRUNCATES anything longer, and the `/v1` path the
 * llm-router uses cannot pass `num_ctx` per request, so an unset box has no
 * way to be handed a longer prompt. That is the state every box was in:
 * `OLLAMA_CONTEXT_LENGTH=16384` existed only in bootstrap's KVM 8 branch,
 * and nothing has been provisioned at KVM 8 since the Jul 2026 default flip.
 *
 * What it does per tenant: resolves the box's tuned size, reads the value a
 * fresh bootstrap would write for that size (parsed out of bootstrap.sh
 * itself, so this script can never hand a box a number bootstrap disagrees
 * with), rewrites the systemd drop-in idempotently, and restarts Ollama.
 * A box already carrying the right value is reported and left alone, so this
 * is safe to re-run.
 *
 * Restart safety: `systemctl restart ollama` drops any in-flight LOCAL
 * inference. On this fleet the local model only serves the spend-cap twin
 * agents (CoworkerLocal / OwnerCoworkerLocal / WebchatCoworkerLocal), which
 * are reached only once a tenant is over its shared AI budget, so the script
 * checks that budget (current-period spend against base cap plus purchased
 * credit, the same number the workers route on) and SKIPS a tenant who is
 * currently over unless `--force`. Voice is untouched either way: Gemini
 * Live never goes near Ollama.
 *
 * Usage:
 *   tsx debug/apply-ollama-context.ts --all --dry-run   # list targets, change nothing
 *   tsx debug/apply-ollama-context.ts --all
 *   tsx debug/apply-ollama-context.ts --business-id <uuid>
 *   tsx debug/apply-ollama-context.ts --all --force     # apply even with a tripped fuse
 *
 * Exit code: 0 only when every targeted tenant ended up on the right value.
 * A skip exits non-zero, since a skipped box is still truncating prompts.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadEnv, makeHostingerClient, resolveVpsIp } from "./_shared.ts";

loadEnv();

const DEFAULT_BUSINESS_ID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const DRY_RUN = process.argv.includes("--dry-run");
const ALL = process.argv.includes("--all");
const FORCE = process.argv.includes("--force");

function parseBusinessId(): string {
  const i = process.argv.indexOf("--business-id");
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return process.env.AIFLOW_SEED_BUSINESS_ID ?? DEFAULT_BUSINESS_ID;
}

const { parseOllamaContextLengths, tunedSizeForPin } = await import(
  "../src/lib/vps/ollama-tuning.ts"
);
const { getActiveVpsSshKeyForBusiness, listActiveVpsSshKeys, newestKeyPerBusiness } = await import(
  "../src/lib/db/vps-ssh-keys.ts"
);
const { sshExec } = await import("../src/lib/hostinger/ssh.ts");
const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { getChatSpendSnapshotForBusiness } = await import("../src/lib/db/chat-usage.ts");

const BOOTSTRAP = readFileSync(
  join(import.meta.dirname, "..", "vps", "scripts", "bootstrap.sh"),
  "utf8"
);
const CONTEXT_LENGTHS = parseOllamaContextLengths(BOOTSTRAP);
console.log(
  "Target values (from vps/scripts/bootstrap.sh):",
  [...CONTEXT_LENGTHS].map(([s, n]) => `${s}=${n}`).join(" ")
);

const db = await createSupabaseServiceClient();

type KeyRow = NonNullable<Awaited<ReturnType<typeof getActiveVpsSshKeyForBusiness>>>;

let targets: KeyRow[];
if (ALL) {
  targets = newestKeyPerBusiness(await listActiveVpsSshKeys());
  if (targets.length === 0) {
    console.error("No active VPS SSH keys: nothing to do.");
    process.exit(1);
  }
  console.log(`Targets  : ${targets.length} tenant(s) (--all)\n`);
} else {
  const one = await getActiveVpsSshKeyForBusiness(parseBusinessId());
  if (!one) {
    console.error(`No active VPS SSH key for business ${parseBusinessId()}`);
    process.exit(1);
  }
  targets = [one];
}

/**
 * True when this tenant is currently OVER its AI budget, which is the only
 * state in which the box actually serves local-model turns.
 *
 * Deliberately NOT `owner_chat_model_spend.fuse_tripped_at`. The workers
 * route on current-period `spend >= effectiveCap` (base cap PLUS purchased
 * credit), which is what `getChatSpendSnapshotForBusiness` computes, and it
 * also resolves the right period window. `fuse_tripped_at` disagrees with
 * that in two directions: it is sticky once set, so a mid-period credit
 * top-up restores Gemini while the stamp stays, and the newest row can be a
 * PRIOR period whose trip says nothing about today.
 *
 * Returns null when it cannot be read: unknown must not be downgraded to
 * "safe to restart".
 */
async function overAiBudget(
  businessId: string,
  tier: "starter" | "standard" | "enterprise"
): Promise<boolean | null> {
  try {
    const snap = await getChatSpendSnapshotForBusiness(businessId, db, tier);
    return snap.spendMicros >= snap.effectiveCapMicros;
  } catch (err) {
    console.error(
      `  ! could not read the chat spend snapshot: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

function remoteScript(contextLength: number): string {
  return `
set -euo pipefail
DROPIN=/etc/systemd/system/ollama.service.d/override.conf
WANT='Environment="OLLAMA_CONTEXT_LENGTH=${contextLength}"'

if [ ! -f "$DROPIN" ]; then
  echo "ERROR: $DROPIN missing, this box was never tuned by bootstrap.sh" >&2
  exit 1
fi

echo "== before =="
grep -E '^Environment="OLLAMA_CONTEXT_LENGTH=' "$DROPIN" || echo "(unset, Ollama defaults to 4096)"

if grep -Fxq "$WANT" "$DROPIN"; then
  echo "already at ${contextLength}, leaving the drop-in and the service alone"
else
  cp "$DROPIN" "$DROPIN.bak.$(date +%s)"
  # Drop any existing pin, then append the wanted one. Order is irrelevant to
  # systemd, and rewriting rather than editing in place keeps this idempotent
  # whatever the previous value was.
  grep -vE '^Environment="OLLAMA_CONTEXT_LENGTH=' "$DROPIN" > "$DROPIN.tmp"
  printf '%s\\n' "$WANT" >> "$DROPIN.tmp"
  mv "$DROPIN.tmp" "$DROPIN"
  systemctl daemon-reload
  # restart, NOT start: on an already-running service start is a silent no-op
  # and the new environment would never reach the live process.
  systemctl restart ollama
fi

echo "== waiting for ollama to answer =="
ready=0
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS -m 5 http://127.0.0.1:11434/api/tags >/dev/null 2>&1; then
    echo "ollama responding (attempt $attempt)"
    ready=1
    break
  fi
  sleep 3
done
if [ "$ready" -ne 1 ]; then
  echo "ERROR: ollama did not answer /api/tags after the restart" >&2
  exit 1
fi

echo "== effective environment of the running process =="
# systemd's own MainPID, NOT pgrep. This whole script is delivered as one
# \`bash -c\` command, so its text (including any pgrep pattern) is in the
# shell's own /proc cmdline: \`pgrep -f 'ollama serve'\` matches the shell
# too, and after a restart Ollama's PID is HIGHER than the shell's, so
# \`head -1\` would read the shell's environ and report a failure on a box
# that is in fact correct. MainPID has no such ambiguity.
PID="$(systemctl show -p MainPID --value ollama 2>/dev/null || true)"
if [ -z "$PID" ] || [ "$PID" = "0" ]; then
  echo "ERROR: systemd reports no running MainPID for ollama.service" >&2
  exit 1
fi
EFFECTIVE="$(tr '\\0' '\\n' < "/proc/$PID/environ" | grep -E '^OLLAMA_CONTEXT_LENGTH=' || true)"
echo "\${EFFECTIVE:-(OLLAMA_CONTEXT_LENGTH absent from the running process)}"
if [ "$EFFECTIVE" != "OLLAMA_CONTEXT_LENGTH=${contextLength}" ]; then
  echo "ERROR: running ollama does not carry OLLAMA_CONTEXT_LENGTH=${contextLength}" >&2
  exit 1
fi
echo "OK: verified on the live process"
`;
}

let failures = 0;

for (const key of targets) {
  const businessId = key.business_id;
  const { data: biz, error: bizErr } = await db
    .from("businesses")
    .select("name, tier, vps_size")
    .eq("id", businessId)
    .maybeSingle();
  const row = biz as { name: string; tier: string; vps_size: string | null } | null;
  console.log(`\n=== ${row?.name ?? businessId} (${businessId}) ===`);
  if (bizErr || !row) {
    console.error(`  ! business row unreadable: ${bizErr?.message ?? "not found"}`);
    failures += 1;
    continue;
  }

  const size = tunedSizeForPin(
    row.vps_size,
    row.tier as "starter" | "standard" | "enterprise"
  );
  if (!size) {
    console.log(`  pin=${row.vps_size}: no Ollama on this size, nothing to tune. Skipping.`);
    continue;
  }
  const want = CONTEXT_LENGTHS.get(size) as number;
  console.log(`  tier=${row.tier} pin=${row.vps_size} size=${size} want=${want}`);

  const overBudget = await overAiBudget(
    businessId,
    row.tier as "starter" | "standard" | "enterprise"
  );
  if (overBudget !== false && !FORCE) {
    console.error(
      overBudget === null
        ? "  ! AI budget state unknown, refusing to restart Ollama (use --force)"
        : "  ! OVER the AI budget, this box is serving local turns right now. Skipping (use --force)"
    );
    failures += 1;
    continue;
  }

  if (DRY_RUN) {
    console.log(`  [dry-run] would set OLLAMA_CONTEXT_LENGTH=${want} and restart ollama`);
    continue;
  }

  const ip = await resolveVpsIp(makeHostingerClient(), key);
  const res = await sshExec({
    host: ip,
    username: key.ssh_username || "root",
    privateKeyPem: key.private_key_pem,
    command: remoteScript(want),
    timeoutMs: 180_000,
    onStdout: (c) => process.stdout.write(c),
    onStderr: (c) => process.stderr.write(c)
  });
  if (res.exitCode !== 0) {
    console.error(`  ! exit ${res.exitCode}`);
    failures += 1;
  }
}

console.log(
  failures === 0
    ? "\nAll targeted boxes carry the bootstrap value."
    : `\n${failures} tenant(s) did NOT end up on the right value.`
);
process.exit(failures === 0 ? 0 : 1);

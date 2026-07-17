/**
 * Create or update a single Vercel project env var (production + preview by
 * default). Generalized from the one-shot flips used for the HQ webchat key
 * (NEXT_PUBLIC_WEBCHAT_SITE_KEY) and the WhatsApp Embedded Signup config
 * (META_WHATSAPP_CONFIG_ID).
 *
 * Requires VERCEL_TOKEN / VERCEL_PROJECT_ID (and VERCEL_ORG_ID for team
 * projects) in the repo-root .env. Values are printed truncated (first 16
 * chars) — never pass secrets you can't afford in shell history; NEXT_PUBLIC_*
 * and non-secret config IDs are the intended use.
 *
 * A changed value only takes effect on the NEXT production build — follow up
 * with debug/vercel-redeploy.ts (or merge to main).
 *
 * Dry-run by default (lists the existing rows); ⚠️ --apply writes.
 *
 * Usage: tsx debug/vercel-env-set.ts --key NAME --value VALUE \
 *          [--targets production,preview] [--apply]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

function argValue(flag: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  const eq = process.argv.find((a) => a.startsWith(`${flag}=`));
  return eq ? eq.slice(flag.length + 1) : "";
}

const APPLY = process.argv.includes("--apply");
const KEY_NAME = argValue("--key");
const NEW_VALUE = argValue("--value");
const TARGETS = (argValue("--targets") || "production,preview")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);
if (!KEY_NAME || !NEW_VALUE) throw new Error("usage: --key NAME --value VALUE [--targets a,b] [--apply]");

const token = process.env.VERCEL_TOKEN ?? "";
const projectId = process.env.VERCEL_PROJECT_ID ?? "";
const orgId = process.env.VERCEL_ORG_ID ?? "";
if (!token || !projectId) throw new Error("VERCEL_TOKEN / VERCEL_PROJECT_ID missing");

const base = `https://api.vercel.com`;
const teamQs = orgId.startsWith("team_") ? `?teamId=${orgId}` : "";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const listRes = await fetch(`${base}/v9/projects/${projectId}/env${teamQs}`, { headers });
if (!listRes.ok) throw new Error(`env list HTTP ${listRes.status}: ${await listRes.text()}`);
const list = (await listRes.json()) as {
  envs: Array<{ id: string; key: string; target: string[]; value?: string }>;
};
const rows = list.envs.filter((e) => e.key === KEY_NAME);
console.log(
  "existing rows:",
  rows.map((r) => ({ id: r.id, target: r.target, valueHead: (r.value ?? "").slice(0, 16) }))
);

if (!APPLY) {
  console.log(`dry-run: pass --apply to set ${KEY_NAME} on [${TARGETS.join(", ")}]`);
  process.exit(0);
}

// Only touch rows that serve at least one of the requested targets — a run
// scoped to production must never rewrite a preview-only row.
const matching = rows.filter((r) => r.target.some((t) => TARGETS.includes(t)));
const skipped = rows.filter((r) => !matching.includes(r));
for (const row of skipped) console.log("skipping row (targets not requested):", row.id, row.target);

if (matching.length === 0) {
  const createRes = await fetch(`${base}/v10/projects/${projectId}/env${teamQs}`, {
    method: "POST",
    headers,
    body: JSON.stringify({ key: KEY_NAME, value: NEW_VALUE, type: "plain", target: TARGETS })
  });
  if (!createRes.ok) throw new Error(`env create HTTP ${createRes.status}: ${await createRes.text()}`);
  console.log("created", KEY_NAME, "targets", TARGETS);
} else {
  for (const row of matching) {
    if (!row.target.every((t) => TARGETS.includes(t))) {
      throw new Error(
        `row ${row.id} spans targets [${row.target.join(", ")}] beyond the requested ` +
          `[${TARGETS.join(", ")}] — re-run with --targets covering all of them, or split the row in Vercel first`
      );
    }
    const patchRes = await fetch(`${base}/v9/projects/${projectId}/env/${row.id}${teamQs}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ value: NEW_VALUE })
    });
    if (!patchRes.ok) throw new Error(`env patch HTTP ${patchRes.status}: ${await patchRes.text()}`);
    console.log("patched row", row.id, "targets", row.target);
  }
}
console.log("done — takes effect on the next production deployment (see debug/vercel-redeploy.ts)");

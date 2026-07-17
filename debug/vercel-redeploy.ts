/**
 * Redeploy the latest READY Vercel production deployment in place, so newly
 * set env vars (see debug/vercel-env-set.ts) take effect without waiting for
 * the next merge to main.
 *
 * Requires VERCEL_TOKEN / VERCEL_PROJECT_ID (and VERCEL_ORG_ID for team
 * projects) in the repo-root .env.
 *
 * Dry-run by default (prints the deployment it would rebuild);
 * ⚠️ --apply starts a real production build.
 *
 * Usage: tsx debug/vercel-redeploy.ts [--apply]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const APPLY = process.argv.includes("--apply");
const token = process.env.VERCEL_TOKEN ?? "";
const projectId = process.env.VERCEL_PROJECT_ID ?? "";
const orgId = process.env.VERCEL_ORG_ID ?? "";
if (!token || !projectId) throw new Error("VERCEL_TOKEN / VERCEL_PROJECT_ID missing");
const teamQs = orgId.startsWith("team_") ? `&teamId=${orgId}` : "";
const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

const res = await fetch(
  `https://api.vercel.com/v6/deployments?projectId=${projectId}&target=production&state=READY&limit=1${teamQs}`,
  { headers }
);
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
const j = (await res.json()) as {
  deployments: Array<{ uid: string; name: string; createdAt: number; meta?: Record<string, string> }>;
};
const latest = j.deployments[0];
if (!latest) throw new Error("no READY production deployment found");
console.log(
  "latest READY:",
  latest.uid,
  new Date(latest.createdAt).toISOString(),
  latest.meta?.githubCommitMessage?.slice(0, 60) ?? ""
);

if (!APPLY) {
  console.log("dry-run: pass --apply to redeploy");
  process.exit(0);
}

const redeployRes = await fetch(`https://api.vercel.com/v13/deployments?forceNew=1${teamQs}`, {
  method: "POST",
  headers,
  body: JSON.stringify({ name: latest.name, deploymentId: latest.uid, target: "production" })
});
if (!redeployRes.ok) throw new Error(`redeploy HTTP ${redeployRes.status}: ${await redeployRes.text()}`);
const out = (await redeployRes.json()) as { id: string; readyState: string };
console.log("redeploy started:", out.id, out.readyState);

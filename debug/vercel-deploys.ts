/**
 * Read-only: list the latest Vercel production deployments + state.
 *
 * Useful right after a merge to confirm the `Vercel Deploy` job's app deploy
 * actually reached READY, or to see whether an env-var change still needs a
 * redeploy (`debug/vercel-redeploy.ts`).
 *
 * Requires VERCEL_TOKEN / VERCEL_PROJECT_ID (and VERCEL_ORG_ID for team
 * projects) in the repo-root .env. Strictly read-only.
 *
 * Usage: tsx debug/vercel-deploys.ts [--limit=5]
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const limitArg = process.argv.find((a) => a.startsWith("--limit="));
const limit = Math.max(1, Number(limitArg?.split("=")[1] ?? 5) || 5);

const token = process.env.VERCEL_TOKEN ?? "";
const projectId = process.env.VERCEL_PROJECT_ID ?? "";
const orgId = process.env.VERCEL_ORG_ID ?? "";
if (!token || !projectId) throw new Error("VERCEL_TOKEN / VERCEL_PROJECT_ID missing");
const teamQs = orgId.startsWith("team_") ? `&teamId=${orgId}` : "";

const res = await fetch(
  `https://api.vercel.com/v6/deployments?projectId=${projectId}&target=production&limit=${limit}${teamQs}`,
  { headers: { Authorization: `Bearer ${token}` } }
);
if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
const j = (await res.json()) as {
  deployments: Array<{ uid: string; state: string; createdAt: number; meta?: Record<string, string> }>;
};
for (const d of j.deployments) {
  console.log(new Date(d.createdAt).toISOString(), d.state, d.meta?.githubCommitMessage?.slice(0, 60) ?? "");
}

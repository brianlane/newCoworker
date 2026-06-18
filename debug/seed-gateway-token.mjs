// One-shot: seed the existing tenant's per-tenant gateway token row.
// Binds the CURRENT shared ROWBOAT_GATEWAY_TOKEN value to the live VPS tenant so
// inbound binding (sha256 lookup + per-tenant JWT secret) works without touching
// the VPS yet. Idempotent: skips if an active row already exists for the business.
import fs from "node:fs";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const BUSINESS_ID = process.argv[2];
if (!BUSINESS_ID) {
  console.error("usage: node seed-gateway-token.mjs <business_id>");
  process.exit(1);
}

const env = fs.readFileSync(new URL("../.env", import.meta.url), "utf8");
function get(key) {
  const m = env.match(new RegExp(`^${key}=(.*)$`, "m"));
  if (!m) return "";
  let v = m[1].trim();
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
  return v;
}

const token = get("ROWBOAT_GATEWAY_TOKEN");
const dbUrl = get("DIRECT_DATABASE_URL") || get("DATABASE_URL");
if (!token || !dbUrl) {
  console.error("missing ROWBOAT_GATEWAY_TOKEN or DIRECT_DATABASE_URL in .env");
  process.exit(1);
}
const sha = crypto.createHash("sha256").update(token).digest("hex");

// Dollar-quote the token to avoid SQL injection / escaping issues.
const tag = "$seedtok$";
const sql = `
insert into vps_gateway_tokens (business_id, token, token_sha256, label)
select '${BUSINESS_ID}', ${tag}${token}${tag}, '${sha}', 'seed-shared-token-transition'
where not exists (
  select 1 from vps_gateway_tokens where business_id = '${BUSINESS_ID}' and revoked_at is null
);
select business_id, token_sha256, label, created_at, revoked_at
from vps_gateway_tokens where business_id = '${BUSINESS_ID}';
`;

const tmp = path.join(os.tmpdir(), `seed-gw-${Date.now()}.sql`);
fs.writeFileSync(tmp, sql, { mode: 0o600 });
try {
  const out = execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", tmp], {
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "15" }
  });
  console.log(out);
  console.log(`sha256(shared token) = ${sha}`);
} finally {
  fs.rmSync(tmp, { force: true });
}

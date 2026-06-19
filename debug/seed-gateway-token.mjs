// One-shot: ensure the given tenant has a UNIQUE per-tenant gateway token row
// (logged in the DB), without touching the live VPS yet.
//
// Why unique (not the shared ROWBOAT_GATEWAY_TOKEN value): storing the shared
// secret as a per-tenant row would bind it to one business and break the
// legacy fallback for every other tenant still presenting the shared token.
// The VPS keeps working on the shared token via verifyGatewayTokenForBusiness's
// fallback; deploying this unique value to the VPS is a deferred operator step.
//
// Self-healing + idempotent:
//   * Revokes any active row whose token == the shared ROWBOAT_GATEWAY_TOKEN
//     (cleans up an earlier bad seed).
//   * Inserts a fresh unique token only if the business has no active row left.
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

const sharedToken = get("ROWBOAT_GATEWAY_TOKEN");
const dbUrl = get("DIRECT_DATABASE_URL") || get("DATABASE_URL");
if (!dbUrl) {
  console.error("missing DIRECT_DATABASE_URL in .env");
  process.exit(1);
}
const sharedSha = sharedToken
  ? crypto.createHash("sha256").update(sharedToken).digest("hex")
  : "";

const uniqueToken = crypto.randomBytes(32).toString("base64url");
const uniqueSha = crypto.createHash("sha256").update(uniqueToken).digest("hex");

const tag = "$seedtok$";
const revokeShared = sharedSha
  ? `update vps_gateway_tokens set revoked_at = now()
     where business_id = '${BUSINESS_ID}' and revoked_at is null and token_sha256 = '${sharedSha}';`
  : "";
const sql = `
${revokeShared}
insert into vps_gateway_tokens (business_id, token, token_sha256, label)
select '${BUSINESS_ID}', ${tag}${uniqueToken}${tag}, '${uniqueSha}', 'seed-unique-deferred-vps-rotation'
where not exists (
  select 1 from vps_gateway_tokens where business_id = '${BUSINESS_ID}' and revoked_at is null
);
select id, business_id, token_sha256, label, created_at, revoked_at
from vps_gateway_tokens where business_id = '${BUSINESS_ID}' order by created_at;
`;

const tmp = path.join(os.tmpdir(), `seed-gw-${Date.now()}.sql`);
fs.writeFileSync(tmp, sql, { mode: 0o600 });
try {
  const out = execFileSync("psql", [dbUrl, "-v", "ON_ERROR_STOP=1", "-f", tmp], {
    encoding: "utf8",
    env: { ...process.env, PGCONNECT_TIMEOUT: "15" }
  });
  console.log(out);
  console.log(`active per-tenant token sha256 = ${uniqueSha} (unique; shared token NOT stored)`);
} finally {
  fs.rmSync(tmp, { force: true });
}

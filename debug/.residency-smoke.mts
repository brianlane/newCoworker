/** One-shot CRUD + latency smoke against the pilot box data-api (untracked). */
import { loadEnv } from "./_shared.ts";
loadEnv();

const BIZ = "7e2b9d4a-1f3c-4e5d-9a6b-8c7d0e1f2a3b";
const BASE = `https://data-${BIZ}.newcoworker.com/v1`;

const { getActiveGatewayTokenForBusiness } = await import("../src/lib/db/vps-gateway-tokens.ts");
const token = await getActiveGatewayTokenForBusiness(BIZ);
if (!token) {
  console.error("no gateway token");
  process.exit(1);
}

async function call(path: string, body: unknown): Promise<{ ms: number; json: { ok: boolean; rows?: unknown[]; count?: number; error?: string; message?: string } }> {
  const t0 = performance.now();
  const res = await fetch(`${BASE}/${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const json = await res.json();
  return { ms: performance.now() - t0, json };
}

const results: string[] = [];
function report(label: string, ms: number, ok: boolean, extra = "") {
  results.push(`${label.padEnd(28)} ${ms.toFixed(0).padStart(5)}ms ok=${ok} ${extra}`);
}

// auth negative
{
  const t0 = performance.now();
  const res = await fetch(`${BASE}/select`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer wrong" },
    body: JSON.stringify({ table: "contacts" })
  });
  report("auth reject (bad bearer)", performance.now() - t0, res.status === 401, `http=${res.status}`);
}

// insert
const row = {
  business_id: BIZ,
  customer_e164: "+15550001111",
  display_name: "Smoke Test",
  summary_md: "residency smoke row",
  type: "customer"
};
{
  const { ms, json } = await call("insert", { table: "contacts", rows: [row], onConflict: ["business_id", "customer_e164"], returning: true });
  report("insert contact (upsert)", ms, json.ok, json.ok ? `id=${(json.rows?.[0] as { id?: string })?.id?.slice(0, 8)}` : `${json.error}: ${json.message}`);
}
// select warm x5
for (let i = 1; i <= 5; i++) {
  const { ms, json } = await call("select", {
    table: "contacts",
    filters: [{ column: "customer_e164", op: "eq", value: "+15550001111" }],
    limit: 1,
    count: true
  });
  report(`select by e164 (warm ${i})`, ms, json.ok, `rows=${json.rows?.length} count=${json.count}`);
}
// list w/ order
{
  const { ms, json } = await call("select", {
    table: "contacts",
    order: [{ column: "created_at", ascending: false }],
    limit: 50
  });
  report("list contacts desc limit50", ms, json.ok, `rows=${json.rows?.length}`);
}
// update
{
  const { ms, json } = await call("update", {
    table: "contacts",
    set: { display_name: "Smoke Updated", alias_e164s: ["+15550001111", "+15550002222"] },
    filters: [{ column: "customer_e164", op: "eq", value: "+15550001111" }],
    returning: true
  });
  const name = (json.rows?.[0] as { display_name?: string; alias_e164s?: string[] })?.display_name;
  const aliases = (json.rows?.[0] as { alias_e164s?: string[] })?.alias_e164s?.length;
  report("update (incl text[] col)", ms, json.ok && name === "Smoke Updated" && aliases === 2, `aliases=${aliases}`);
}
// unfiltered delete must refuse
{
  const { ms, json } = await call("delete", { table: "contacts", filters: [] });
  report("unfiltered delete refused", ms, !json.ok && json.error === "invalid_request");
}
// delete
{
  const { ms, json } = await call("delete", {
    table: "contacts",
    filters: [{ column: "customer_e164", op: "eq", value: "+15550001111" }],
    returning: true
  });
  report("delete contact", ms, json.ok && json.rows?.length === 1);
}
// unknown table
{
  const { ms, json } = await call("select", { table: "businesses" });
  report("control-plane table refused", ms, !json.ok && json.error === "unknown_table");
}

console.log(results.join("\n"));

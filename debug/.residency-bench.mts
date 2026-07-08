/** One-off: head-to-head latency, central Supabase vs pilot box data-api (untracked). */
import { loadEnv } from "./_shared.ts";
loadEnv();

const BIZ = "7e2b9d4a-1f3c-4e5d-9a6b-8c7d0e1f2a3b";
const N = 30;

const { createSupabaseServiceClient } = await import("../src/lib/supabase/server.ts");
const { DataApiClient } = await import("../src/lib/residency/client.ts");

const db = await createSupabaseServiceClient();
const api = new DataApiClient(BIZ);

function stats(ms: number[]): string {
  const s = [...ms].sort((a, b) => a - b);
  const p = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))].toFixed(0);
  const mean = (s.reduce((a, b) => a + b, 0) / s.length).toFixed(0);
  return `p50=${p(0.5)}ms p95=${p(0.95)}ms mean=${mean}ms min=${s[0].toFixed(0)} max=${s[s.length - 1].toFixed(0)}`;
}

async function bench(label: string, fn: () => Promise<unknown>): Promise<void> {
  await fn(); // warm
  const times: number[] = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    const res = await fn();
    times.push(performance.now() - t0);
    if ((res as { error?: unknown })?.error) throw new Error(`${label}: query error`);
  }
  console.log(`${label.padEnd(44)} ${stats(times)}`);
}

console.log(`n=${N} per cell (1 warmup discarded), vantage: local machine\n`);

// 1) point lookup by unique key
await bench("supabase: contact by e164", () =>
  db.from("contacts").select("*").eq("business_id", BIZ).eq("customer_e164", "+15550001001").maybeSingle()
);
await bench("box:      contact by e164", () =>
  api.select({
    table: "contacts",
    filters: [
      { column: "business_id", op: "eq", value: BIZ },
      { column: "customer_e164", op: "eq", value: "+15550001001" }
    ],
    limit: 1
  })
);

// 2) ordered list
await bench("supabase: list contacts desc limit 50", () =>
  db.from("contacts").select("*").eq("business_id", BIZ).order("created_at", { ascending: false }).limit(50)
);
await bench("box:      list contacts desc limit 50", () =>
  api.select({
    table: "contacts",
    filters: [{ column: "business_id", op: "eq", value: BIZ }],
    order: [{ column: "created_at", ascending: false }],
    limit: 50
  })
);

// 3) count
await bench("supabase: count notifications", () =>
  db.from("notifications").select("id", { count: "exact", head: true }).eq("business_id", BIZ)
);
await bench("box:      count notifications", () =>
  api.select({
    table: "notifications",
    columns: ["id"],
    filters: [{ column: "business_id", op: "eq", value: BIZ }],
    limit: 1,
    count: true
  })
);

// 4) sequential burst of 5 (page render shape: several reads per request)
await bench("supabase: 5 sequential point reads", async () => {
  for (let i = 0; i < 5; i++) {
    await db.from("contacts").select("id").eq("business_id", BIZ).limit(1);
  }
  return {};
});
await bench("box:      5 sequential point reads", async () => {
  for (let i = 0; i < 5; i++) {
    await api.select({ table: "contacts", columns: ["id"], filters: [{ column: "business_id", op: "eq", value: BIZ }], limit: 1 });
  }
  return {};
});

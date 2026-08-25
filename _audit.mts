import { loadEnv } from "./debug/_shared.ts";
loadEnv();
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? process.env.SUPABASE_URL ?? "";
const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const { createClient } = await import("@supabase/supabase-js");
const db = createClient(url, key, { auth: { persistSession: false } });
const BID = "621a5b0d-c2ad-449f-9d74-9d50e7b27fa3";
const { data: flows } = await db.from("ai_flows").select("id,name,enabled,definition").eq("business_id", BID).is("deleted_at", null).eq("enabled", true);
const walk = (s: any[], path: string[] = [], o: any[] = []): any[] => {
  for (const x of s ?? []) {
    o.push({ step: x, path: path.join(" > ") });
    for (const k of ["steps", "else"]) if (Array.isArray(x[k])) walk(x[k], [...path, `${x.id}.${k}`], o);
    if (Array.isArray(x.branches)) for (const b of x.branches) walk(b.steps ?? [], [...path, `${x.id}[${b.id} ${JSON.stringify(b.condition ?? {})}]`], o);
  }
  return o;
};
console.log("=== every place a LIVE TRANSFER ladder exists ===");
for (const f of flows ?? []) {
  for (const { step, path } of walk((f.definition as any).steps)) {
    if (!step.reachTeammate) continue;
    const refs = (step.reachTeammate.refs ?? []).map((r: any) => r.label);
    const ctx = path + " " + step.id + " " + JSON.stringify(step.when ?? {});
    const isBuyer = /buyer/i.test(ctx);
    console.log(`${isBuyer ? "BUYER " : "      "}${f.name} :: ${step.id}`);
    console.log(`        refs=[${refs.join(", ")}] jason=${refs.includes("Jason Lane") ? "YES" : "NO"} rotateFirst=${step.reachTeammate.rotateFirst}`);
    if (step.when) console.log(`        when=${JSON.stringify(step.when)}`);
    if (path) console.log(`        under: ${path}`);
  }
}

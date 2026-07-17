/**
 * One-shot read-only probe: confirm KYP Ads' Calendly event types have Zoom
 * as their location (i.e. Calendly's native Zoom integration is wired up),
 * so the AI worker's link-mode booking flow yields meetings with Zoom links.
 */
import { loadEnv } from "./_shared.ts";

loadEnv();

const { createClient } = await import("@supabase/supabase-js");
const { decryptIntegrationSecret } = await import("../src/lib/integrations/secrets.ts");

const BIZ = "056034a7-e84c-444d-8d15-747eeb1fa899"; // KYP Ads

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL ?? "",
  process.env.SUPABASE_SERVICE_ROLE_KEY ?? ""
);

const { data, error } = await supabase
  .from("calendly_connections")
  .select("access_token_encrypted, account_email, is_active")
  .eq("business_id", BIZ)
  .maybeSingle();
if (error || !data) throw new Error(`no calendly connection: ${error?.message}`);
console.log(`Connection: ${data.account_email} active=${data.is_active}`);

const pat = decryptIntegrationSecret(data.access_token_encrypted);
if (!pat) throw new Error("token decrypt failed");

async function calendly(path: string): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.calendly.com${path}`, {
    headers: { Authorization: `Bearer ${pat}` }
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

const me = (await calendly("/users/me")) as { resource: { uri: string; name: string } };
console.log(`Calendly user: ${me.resource.name}`);

const list = (await calendly(
  `/event_types?user=${encodeURIComponent(me.resource.uri)}&count=50`
)) as {
  collection: Array<{
    name: string;
    slug: string;
    active: boolean;
    duration: number;
    scheduling_url: string;
    locations: Array<{ kind: string }> | null;
  }>;
};

for (const et of list.collection) {
  const locs = (et.locations ?? []).map((l) => l.kind).join(", ") || "(none set)";
  console.log(
    `- ${et.name} [${et.slug}] active=${et.active} ${et.duration}min\n    url: ${et.scheduling_url}\n    location: ${locs}`
  );
}

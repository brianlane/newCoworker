import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getBusinessConfig } from "@/lib/db/configs";
import { Card } from "@/components/ui/Card";
import { MemoryEditor } from "@/components/dashboard/MemoryEditor";

export const dynamic = "force-dynamic";

export default async function MemoryPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  if (!user.email) redirect("/login");

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, tier")
    .eq("owner_email", user.email)
    .limit(1);

  const businessId = businesses?.[0]?.id ?? null;
  const tier = businesses?.[0]?.tier ?? null;
  const config = businessId ? await getBusinessConfig(businessId) : null;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Coworker Memory</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Review and manage what your AI coworker knows about your business
        </p>
      </div>

      {!config ? (
        <Card>
          <p className="text-parchment/50 text-sm">Memory not initialized. Provision your coworker first.</p>
        </Card>
      ) : (
        <MemoryEditor
          businessId={businessId!}
          tier={tier ?? undefined}
          initialSoul={config.soul_md}
          initialIdentity={config.identity_md}
          initialMemory={config.memory_md}
        />
      )}
    </div>
  );
}

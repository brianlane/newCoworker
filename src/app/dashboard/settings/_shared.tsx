/**
 * Shared plumbing for the Settings sub-pages (BizBlasts-style hub → pages).
 *
 * Every page under /dashboard/settings/* resolves the same context: the
 * signed-in user, the admin view-as state, the active business row (one
 * SELECT carrying every column any settings page needs), and the owner flag
 * that gates owner-only cards. Not a route file — the underscore prefix
 * keeps Next from treating this as a segment.
 */
import Link from "next/link";
import { redirect } from "next/navigation";
import { getAuthUser, type AuthUser } from "@/lib/auth";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

export type SettingsBusinessRow = {
  id: string;
  name: string;
  tier: "starter" | "standard" | "enterprise";
  enterprise_limits: Record<string, unknown> | null;
  timezone: string | null;
  branding: unknown;
  aiflow_protect_staff_contacts: boolean | null;
  address: string | null;
  business_hours: unknown;
  business_type: string | null;
  owner_name: string | null;
  phone: string | null;
};

export type SettingsContext = {
  user: AuthUser;
  /** Non-null while an admin is impersonating a tenant (read-only). */
  viewAs: Awaited<ReturnType<typeof resolveViewAsContext>>["viewAs"];
  db: Awaited<ReturnType<typeof createSupabaseServiceClient>>;
  business: SettingsBusinessRow | null;
  /** `manage_billing` (= owner in the role policy) gates owner-only cards. */
  isOwner: boolean;
};

export async function loadSettingsContext(): Promise<SettingsContext> {
  const user = await getAuthUser();
  if (!user || !user.email) redirect("/login");

  const { viewAs } = await resolveViewAsContext(user);

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const isOwner = (await resolveActiveBusinessIdForAction(user, "manage_billing")) !== null;
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, name, tier, enterprise_limits, timezone, branding, aiflow_protect_staff_contacts, address, business_hours, business_type, owner_name, phone"
    )
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);

  return {
    user,
    viewAs,
    db,
    business: (businesses?.[0] as SettingsBusinessRow | undefined) ?? null,
    isOwner
  };
}

/** Standard sub-page shell: back link to the hub + title + blurb. */
export function SettingsPageShell({
  title,
  blurb,
  children
}: {
  title: string;
  blurb: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <Link
          href="/dashboard/settings"
          className="text-xs text-parchment/40 hover:text-parchment/70"
        >
          ← Settings
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-1">{title}</h1>
        <p className="text-sm text-parchment/50 mt-1">{blurb}</p>
      </div>
      {children}
    </div>
  );
}

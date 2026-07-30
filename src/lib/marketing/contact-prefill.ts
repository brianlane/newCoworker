import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Known ?topic= values map to a prefilled form subject so CTAs elsewhere
 * (e.g. the white-glove lead button on /pricing and /dashboard/billing) land
 * as labeled leads. The message template gets the business name when the
 * visitor is a signed-in owner, so the lead arrives ready to send.
 */
export const CONTACT_TOPIC_DEFS_BY_PARAM: Record<
  string,
  { subjectKey: string; msgKey: string; msgForKey: string }
> = {
  "white-glove": {
    subjectKey: "subjectWhiteGlove",
    msgKey: "msgWhiteGlove",
    msgForKey: "msgWhiteGloveFor"
  },
  enterprise: {
    subjectKey: "subjectEnterprise",
    msgKey: "msgEnterprise",
    msgForKey: "msgEnterpriseFor"
  },
  support: { subjectKey: "subjectSupport", msgKey: "msgSupport", msgForKey: "msgSupportFor" }
};

export type ContactPrefill = {
  name?: string;
  email?: string;
  businessName?: string;
};

/**
 * Prefill for signed-in visitors: their email, plus the active business's
 * owner name + business name. Best-effort: any failure (signed out, no
 * business, DB hiccup) returns an empty object so the public form stays usable.
 *
 * Kept off the /contact RSC tree so anonymous scrapes never pay for auth/DB.
 */
export async function resolveContactPrefill(): Promise<ContactPrefill> {
  try {
    const user = await getAuthUser();
    if (!user?.email) return {};
    const businessId = await resolveActiveBusinessId(user);
    if (!businessId) return { email: user.email };
    const db = await createSupabaseServiceClient();
    const { data } = await db
      .from("businesses")
      .select("name, owner_name, owner_email")
      .eq("id", businessId)
      .maybeSingle();
    const row = (data ?? null) as {
      name?: string | null;
      owner_name?: string | null;
      owner_email?: string | null;
    } | null;
    // Team members reach the business too: only claim the owner's name for
    // the "Name" field when the login actually is the owner.
    const isOwner =
      (row?.owner_email ?? "").trim().toLowerCase() === user.email.trim().toLowerCase();
    return {
      name: isOwner ? row?.owner_name?.trim() || undefined : undefined,
      email: user.email,
      businessName: row?.name?.trim() || undefined
    };
  } catch {
    return {};
  }
}

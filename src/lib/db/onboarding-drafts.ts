import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { OnboardingData } from "@/lib/onboarding/storage";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;
type SupabaseError = { code?: string; message: string };

export type OnboardingDraftRow = {
  business_id: string;
  draft_token: string;
  payload: OnboardingData;
  created_at: string;
  updated_at: string;
};

function isSupabaseNotFoundError(error: SupabaseError | null): boolean {
  return error?.code === "PGRST116";
}

export async function upsertOnboardingDraft(
  data: {
    businessId: string;
    draftToken: string;
    payload: OnboardingData;
  },
  client?: SupabaseClient
): Promise<OnboardingDraftRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("onboarding_drafts")
    .upsert({
      business_id: data.businessId,
      draft_token: data.draftToken,
      payload: data.payload,
      updated_at: new Date().toISOString()
    })
    .select()
    .single();

  if (error) {
    throw new Error(`upsertOnboardingDraft: ${error.message}`);
  }

  return row as OnboardingDraftRow;
}

/**
 * Drop a business's saved onboarding draft.
 *
 * `onboarding_drafts` has no foreign key to `businesses`, so deleting a
 * business does NOT cascade here and the draft (which carries the owner's
 * name, email, and phone) would outlive the row it belongs to. Called by the
 * abandoned-signup sweep, which deletes never-paid signups.
 */
export async function deleteOnboardingDraft(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("onboarding_drafts")
    .delete()
    .eq("business_id", businessId);
  if (error) {
    throw new Error(`deleteOnboardingDraft: ${error.message}`);
  }
}

export async function getOnboardingDraft(
  businessId: string,
  draftToken?: string,
  client?: SupabaseClient
): Promise<OnboardingDraftRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  let query = db
    .from("onboarding_drafts")
    .select()
    .eq("business_id", businessId);

  /* c8 ignore next */
  if (draftToken) {
    query = query.eq("draft_token", draftToken);
  }

  const { data, error } = await query.single();
  if (error) {
    if (isSupabaseNotFoundError(error as SupabaseError)) {
      return null;
    }
    throw new Error(`getOnboardingDraft: ${error.message}`);
  }
  return data as OnboardingDraftRow;
}

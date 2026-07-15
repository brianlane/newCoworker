/**
 * White-glove client intake questionnaires — DB access layer.
 *
 * A row is one questionnaire sent to one prospective white-glove client:
 * the admin enters their email, the system emails the public
 * /intake/<token> link, and the prospect's submitted answers land in
 * `answers` (validated against `intakeAnswersSchema` at the submit route).
 * Lifecycle: sent → completed (prospect submits) or sent → revoked (admin).
 * Completed intakes are immutable — the submit UPDATE only matches
 * status='sent'. See migration 20260817000000_white_glove_intakes.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { IntakeAnswers } from "@/lib/white-glove/template";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type WhiteGloveIntakeStatus = "sent" | "completed" | "revoked";

export type WhiteGloveIntakeRow = {
  id: string;
  /** Unguessable capability behind the public /intake/<token> link. */
  token: string;
  /** The prospect's business name (admin-supplied — not asked in the form). */
  business_name: string;
  /** INDUSTRY_OPTIONS value driving the questionnaire's suggested wording. */
  industry: string;
  /** Null when the admin generated a link without an email to send to. */
  recipient_email: string | null;
  /** Null for prospects with no account yet. */
  business_id: string | null;
  /** The prospect's submitted answers; null until completed. */
  answers: IntakeAnswers | null;
  status: WhiteGloveIntakeStatus;
  created_by: string;
  created_at: string;
  completed_at: string | null;
  /** When an admin last applied this intake to a tenant; null = never. */
  applied_at: string | null;
  /** The follow-up flow the apply installed (re-applies update it in place). */
  applied_flow_id: string | null;
  /** Apply-in-progress lease stamp; see claimWhiteGloveIntakeForBusiness. */
  apply_started_at: string | null;
};

/**
 * How long an apply's claim lease lasts. Long enough for the whole write
 * phase (a handful of DB round-trips), short enough that a crashed apply
 * doesn't block the admin's retry for more than a couple of minutes.
 */
export const WHITE_GLOVE_APPLY_LEASE_MS = 2 * 60 * 1000;

export async function createWhiteGloveIntake(
  data: {
    businessName: string;
    industry: string;
    /** Optional — omit to just generate a shareable link (no email sent). */
    recipientEmail?: string | null;
    /** Optional: tie the questionnaire to an existing business. */
    businessId?: string | null;
    createdBy: string;
  },
  client?: SupabaseClient
): Promise<WhiteGloveIntakeRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data: row, error } = await db
    .from("white_glove_intakes")
    .insert({
      business_name: data.businessName,
      industry: data.industry,
      recipient_email: data.recipientEmail ?? null,
      business_id: data.businessId ?? null,
      created_by: data.createdBy
    })
    .select("*")
    .single();
  if (error) throw new Error(`createWhiteGloveIntake: ${error.message}`);
  return row as WhiteGloveIntakeRow;
}

/** All intakes, newest first (admin panel). */
export async function listWhiteGloveIntakes(
  client?: SupabaseClient
): Promise<WhiteGloveIntakeRow[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_intakes")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) throw new Error(`listWhiteGloveIntakes: ${error.message}`);
  return (data ?? []) as WhiteGloveIntakeRow[];
}

/** Single intake by id, or null (admin build-document view). */
export async function getWhiteGloveIntake(
  intakeId: string,
  client?: SupabaseClient
): Promise<WhiteGloveIntakeRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_intakes")
    .select("*")
    .eq("id", intakeId)
    .maybeSingle();
  if (error) throw new Error(`getWhiteGloveIntake: ${error.message}`);
  return (data as WhiteGloveIntakeRow | null) ?? null;
}

/** Resolve the intake behind a public questionnaire link, or null. */
export async function getWhiteGloveIntakeByToken(
  token: string,
  client?: SupabaseClient
): Promise<WhiteGloveIntakeRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_intakes")
    .select("*")
    .eq("token", token)
    .maybeSingle();
  if (error) throw new Error(`getWhiteGloveIntakeByToken: ${error.message}`);
  return (data as WhiteGloveIntakeRow | null) ?? null;
}

/**
 * Store the prospect's answers and mark the intake completed — an atomic
 * claim guarded on status='sent', so a completed questionnaire can never be
 * overwritten (double-submits and stale tabs lose quietly) and a revoked
 * link can't be submitted. Returns whether the submission landed.
 */
export async function submitWhiteGloveIntake(
  token: string,
  answers: IntakeAnswers,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_intakes")
    .update({
      answers,
      status: "completed",
      completed_at: new Date().toISOString()
    })
    .eq("token", token)
    .eq("status", "sent")
    .select("id");
  if (error) throw new Error(`submitWhiteGloveIntake: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Revoke a SENT intake (admin). Guarded on status so a submission that
 * raced the revoke wins — completed answers are never discarded. Returns
 * whether a row actually flipped.
 */
export async function revokeWhiteGloveIntake(
  intakeId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("white_glove_intakes")
    .update({ status: "revoked" })
    .eq("id", intakeId)
    .eq("status", "sent")
    .select("id");
  if (error) throw new Error(`revokeWhiteGloveIntake: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Atomically claim a completed intake for ONE apply run before any tenant
 * writes. The conditional UPDATE succeeds only while the intake is
 * completed, unlinked (or already linked to this same business), AND no
 * other apply holds a fresh lease — so overlapping applies can never both
 * run the write phase, whether they target different tenants (cross-write)
 * or the same one (duplicate flow installs from a double-click). The loser
 * sees `false` before it has written anything. Postgres re-evaluates the
 * WHERE clause on the committed row after a lock wait, which is what makes
 * two perfectly concurrent claims decide a single winner.
 */
export async function claimWhiteGloveIntakeForBusiness(
  intakeId: string,
  businessId: string,
  client?: SupabaseClient
): Promise<boolean> {
  const db = client ?? (await createSupabaseServiceClient());
  const leaseCutoff = new Date(Date.now() - WHITE_GLOVE_APPLY_LEASE_MS).toISOString();
  const { data, error } = await db
    .from("white_glove_intakes")
    .update({ business_id: businessId, apply_started_at: new Date().toISOString() })
    .eq("id", intakeId)
    .eq("status", "completed")
    .or(`business_id.is.null,business_id.eq.${businessId}`)
    .or(`apply_started_at.is.null,apply_started_at.lt.${leaseCutoff}`)
    .select("id");
  if (error) throw new Error(`claimWhiteGloveIntakeForBusiness: ${error.message}`);
  return ((data as unknown[] | null) ?? []).length > 0;
}

/**
 * Record a successful apply: link the tenant, stamp `applied_at`, and
 * remember the installed flow so the next apply updates it in place.
 * Guarded on status='completed' — only a completed intake can be applied.
 */
export async function markWhiteGloveIntakeApplied(
  intakeId: string,
  data: { businessId: string; flowId: string },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("white_glove_intakes")
    .update({
      business_id: data.businessId,
      applied_at: new Date().toISOString(),
      applied_flow_id: data.flowId,
      // Release the apply lease — the next (re-)apply shouldn't wait it out.
      apply_started_at: null
    })
    .eq("id", intakeId)
    .eq("status", "completed");
  if (error) throw new Error(`markWhiteGloveIntakeApplied: ${error.message}`);
}

/** The emailable public questionnaire link for an intake. */
export function whiteGloveIntakeUrl(intake: Pick<WhiteGloveIntakeRow, "token">): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${appUrl}/intake/${intake.token}`;
}

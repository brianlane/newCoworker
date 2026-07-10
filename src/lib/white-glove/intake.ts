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
  recipient_email: string;
  /** Null for prospects with no account yet. */
  business_id: string | null;
  /** The prospect's submitted answers; null until completed. */
  answers: IntakeAnswers | null;
  status: WhiteGloveIntakeStatus;
  created_by: string;
  created_at: string;
  completed_at: string | null;
};

export async function createWhiteGloveIntake(
  data: {
    recipientEmail: string;
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
      recipient_email: data.recipientEmail,
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

/** The emailable public questionnaire link for an intake. */
export function whiteGloveIntakeUrl(intake: Pick<WhiteGloveIntakeRow, "token">): string {
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return `${appUrl}/intake/${intake.token}`;
}

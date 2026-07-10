/**
 * Admin CRUD for white-glove intake questionnaires.
 *
 * POST   — send a questionnaire to a prospective white-glove client: creates
 *          the intake row and emails the public /intake/<token> link to the
 *          recipient. Email is best-effort (a Resend hiccup never fails the
 *          creation); the response reports `emailedTo` (or null) plus the
 *          copyable intakeUrl so the admin can send the link manually.
 * GET    — list every intake, newest first (admin panel).
 * DELETE — revoke a SENT intake (a completed one can't be revoked; its
 *          answers are the build record).
 */
import { z } from "zod";
import { requireAdmin } from "@/lib/auth";
import {
  createWhiteGloveIntake,
  listWhiteGloveIntakes,
  revokeWhiteGloveIntake,
  whiteGloveIntakeUrl,
  type WhiteGloveIntakeRow
} from "@/lib/white-glove/intake";
import { buildWhiteGloveIntakeEmail } from "@/lib/email/templates/white-glove-intake";
import { sendOwnerEmail } from "@/lib/email/client";
import { logger } from "@/lib/logger";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";

/**
 * Email the freshly created intake link to its recipient. Best-effort:
 * returns the address it emailed, or null (no RESEND key / send failure) so
 * the caller can tell the admin to copy the link manually instead.
 */
async function emailIntakeToRecipient(
  intake: WhiteGloveIntakeRow,
  intakeUrl: string
): Promise<string | null> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    logger.warn("white_glove_intake create: RESEND_API_KEY unset; intake not emailed", {
      intakeId: intake.id
    });
    return null;
  }
  try {
    const siteUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
    const { subject, text, html } = buildWhiteGloveIntakeEmail({
      intakeUrl,
      recipientEmail: intake.recipient_email,
      siteUrl
    });
    // Resend can reject WITHOUT throwing (returns no message id) — treat that
    // as a failed send so the admin copies the link manually instead of the
    // notice claiming an email that never went out.
    const messageId = await sendOwnerEmail(apiKey, intake.recipient_email, subject, {
      text,
      html
    });
    if (!messageId) {
      logger.error("white_glove_intake create: Resend rejected the intake email (non-fatal)", {
        intakeId: intake.id
      });
      return null;
    }
    return intake.recipient_email;
  } catch (err) {
    logger.error("white_glove_intake create: intake email failed (non-fatal)", {
      intakeId: intake.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return null;
  }
}

const createSchema = z.object({
  recipientEmail: z.string().trim().email().max(320),
  businessId: z.string().uuid().optional()
});

export async function POST(request: Request) {
  try {
    const admin = await requireAdmin();
    const body = createSchema.parse(await request.json());

    const intake = await createWhiteGloveIntake({
      recipientEmail: body.recipientEmail,
      businessId: body.businessId ?? null,
      createdBy: admin.email ?? admin.userId
    });
    const intakeUrl = whiteGloveIntakeUrl(intake);
    const emailedTo = await emailIntakeToRecipient(intake, intakeUrl);
    return successResponse({ intake, intakeUrl, emailedTo });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

export async function GET() {
  try {
    await requireAdmin();
    const intakes = await listWhiteGloveIntakes();
    return successResponse({
      intakes: intakes.map((i) => ({ ...i, intakeUrl: whiteGloveIntakeUrl(i) }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

const revokeSchema = z.object({ intakeId: z.string().uuid() });

export async function DELETE(request: Request) {
  try {
    await requireAdmin();
    const body = revokeSchema.parse(await request.json());
    const revoked = await revokeWhiteGloveIntake(body.intakeId);
    if (!revoked) {
      return errorResponse("CONFLICT", "Intake is not open (already completed or revoked)");
    }
    return successResponse({ ok: true });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return errorResponse("VALIDATION_ERROR", err.issues[0]?.message ?? "Invalid body");
    }
    return handleRouteError(err);
  }
}

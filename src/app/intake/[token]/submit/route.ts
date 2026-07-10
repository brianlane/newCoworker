/**
 * Public submit endpoint for the white-glove intake questionnaire
 * (POST /intake/<token>/submit). Unauthenticated by design — the token IS
 * the capability, mirroring /offer/<pay_token> — so it is IP rate-limited,
 * the token shape is checked before any DB hit, and the answers are
 * validated against the questionnaire schema. The underlying UPDATE is
 * guarded on status='sent', so a completed or revoked intake can never be
 * (re)submitted.
 */
import { NextResponse } from "next/server";
import { intakeAnswersSchema } from "@/lib/white-glove/template";
import { submitWhiteGloveIntake } from "@/lib/white-glove/intake";
import { rateLimitDurable, rateLimitIdentifierFromRequest } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";

const SUBMIT_RATE_LIMIT = { interval: 10 * 60 * 1000, maxRequests: 10 };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params;
  // Fail closed on malformed tokens without hitting the DB.
  if (!UUID_RE.test(token)) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  const identifier = `white-glove-intake:${rateLimitIdentifierFromRequest(request)}`;
  const limit = await rateLimitDurable(identifier, SUBMIT_RATE_LIMIT);
  if (!limit.success) {
    return NextResponse.json(
      { error: "Too many submissions. Please try again in a few minutes." },
      { status: 429 }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const parsed = intakeAnswersSchema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return NextResponse.json(
      { error: `${issue?.path.join(".") ?? "answers"}: ${issue?.message ?? "invalid"}` },
      { status: 400 }
    );
  }

  try {
    const submitted = await submitWhiteGloveIntake(token, parsed.data);
    if (!submitted) {
      // Unknown token, already completed, or revoked — one answer for all
      // three so the public endpoint doesn't oracle which tokens exist.
      return NextResponse.json(
        { error: "This questionnaire is no longer open." },
        { status: 409 }
      );
    }
  } catch (err) {
    logger.error("white_glove_intake submit failed", {
      error: err instanceof Error ? err.message : String(err)
    });
    return NextResponse.json(
      { error: "Something went wrong saving your answers. Please try again." },
      { status: 500 }
    );
  }

  return NextResponse.json({ ok: true });
}

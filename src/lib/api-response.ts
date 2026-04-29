import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { logger } from "@/lib/logger";

type ErrorCode =
  | "DB_ERROR"
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

const STATUS_MAP: Record<ErrorCode, number> = {
  DB_ERROR: 500,
  VALIDATION_ERROR: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  INTERNAL_SERVER_ERROR: 500
};

export function successResponse<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ ok: true, data }, { status });
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  status?: number
): NextResponse {
  return NextResponse.json(
    { ok: false, error: { code, message } },
    { status: status ?? STATUS_MAP[code] }
  );
}

export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return errorResponse("VALIDATION_ERROR", error.issues[0]?.message ?? "Invalid request");
  }
  if (error instanceof Error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 401) return errorResponse("UNAUTHORIZED", error.message);
    if (status === 403) return errorResponse("FORBIDDEN", error.message);
    if (status === 404) return errorResponse("NOT_FOUND", error.message);
  }

  // Log the underlying error before collapsing it into the generic 500 we
  // return to clients. Without this, every "An unexpected error occurred"
  // surfaced in the UI is a black hole in Vercel/Datadog: the runtime log
  // shows a 500 but no stack, no message, no diagnostic. Routes catch with
  // `handleRouteError(err)` precisely because they don't want to leak the
  // raw error to callers (DB messages can contain schema/internals); the
  // log keeps the diagnostic on the server where it belongs.
  logger.error("Unhandled route error", {
    message: error instanceof Error ? error.message : String(error),
    name: error instanceof Error ? error.name : typeof error,
    stack: error instanceof Error ? error.stack : undefined
  });

  return errorResponse("INTERNAL_SERVER_ERROR", "An unexpected error occurred");
}

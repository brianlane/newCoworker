import { NextResponse } from "next/server";

type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "INTERNAL_SERVER_ERROR";

const STATUS_MAP: Record<ErrorCode, number> = {
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
  if (error instanceof Error) {
    const status = (error as Error & { status?: number }).status;
    if (status === 401) return errorResponse("UNAUTHORIZED", error.message);
    if (status === 403) return errorResponse("FORBIDDEN", error.message);
    if (status === 404) return errorResponse("NOT_FOUND", error.message);
  }
  return errorResponse("INTERNAL_SERVER_ERROR", "An unexpected error occurred");
}

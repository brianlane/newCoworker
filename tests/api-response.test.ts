import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}));

import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
import { logger } from "@/lib/logger";
import { z } from "zod";

describe("api-response", () => {
  it("successResponse returns ok:true with data and default 200", async () => {
    const res = successResponse({ id: "abc" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.id).toBe("abc");
  });

  it("successResponse accepts custom status", async () => {
    const res = successResponse({}, 201);
    expect(res.status).toBe(201);
  });

  it("errorResponse maps known codes to correct status", async () => {
    const cases: [Parameters<typeof errorResponse>[0], number][] = [
      ["DB_ERROR", 500],
      ["UNAUTHORIZED", 401],
      ["FORBIDDEN", 403],
      ["NOT_FOUND", 404],
      ["VALIDATION_ERROR", 400],
      ["CONFLICT", 409],
      ["INTERNAL_SERVER_ERROR", 500]
    ];
    for (const [code, expectedStatus] of cases) {
      const res = errorResponse(code, "msg");
      expect(res.status).toBe(expectedStatus);
      const body = await res.json();
      expect(body.ok).toBe(false);
      expect(body.error.code).toBe(code);
    }
  });

  it("errorResponse uses custom status when provided", async () => {
    const res = errorResponse("VALIDATION_ERROR", "bad input", 422);
    expect(res.status).toBe(422);
  });

  it("handleRouteError maps 401 error", async () => {
    const err = Object.assign(new Error("Auth required"), { status: 401 });
    const res = handleRouteError(err);
    expect(res.status).toBe(401);
  });

  it("handleRouteError maps 403 error", async () => {
    const err = Object.assign(new Error("Forbidden"), { status: 403 });
    const res = handleRouteError(err);
    expect(res.status).toBe(403);
  });

  it("handleRouteError maps 404 error", async () => {
    const err = Object.assign(new Error("Not found"), { status: 404 });
    const res = handleRouteError(err);
    expect(res.status).toBe(404);
  });

  it("handleRouteError returns 500 for unknown errors", async () => {
    const res = handleRouteError(new Error("boom"));
    expect(res.status).toBe(500);
  });

  it("handleRouteError maps ZodError to 400", async () => {
    const schema = z.object({ businessId: z.string().uuid() });
    const result = schema.safeParse({ businessId: "bad" });
    if (result.success) {
      throw new Error("expected validation to fail");
    }

    const res = handleRouteError(result.error);
    expect(res.status).toBe(400);
  });

  it("handleRouteError uses fallback message for empty ZodError issues", async () => {
    const res = handleRouteError(new z.ZodError([]));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toBe("Invalid request");
  });

  it("handleRouteError handles non-Error values", async () => {
    const res = handleRouteError("string error");
    expect(res.status).toBe(500);
  });

  it("handleRouteError logs the underlying error before collapsing to 500", async () => {
    vi.mocked(logger.error).mockClear();
    const err = new Error("supabase: insert failed");
    handleRouteError(err);
    expect(logger.error).toHaveBeenCalledWith(
      "Unhandled route error",
      expect.objectContaining({
        message: "supabase: insert failed",
        name: "Error",
        stack: expect.any(String)
      })
    );
  });

  it("handleRouteError logs non-Error values with stringified message", async () => {
    vi.mocked(logger.error).mockClear();
    handleRouteError({ kind: "weird non-error" });
    expect(logger.error).toHaveBeenCalledWith(
      "Unhandled route error",
      expect.objectContaining({
        message: "[object Object]",
        name: "object"
      })
    );
  });

  it("handleRouteError does NOT log when collapsing a known status-coded error", async () => {
    // 401/403/404 errors take their own dedicated branches and are
    // returned to clients with the same surface message — no need to
    // double-log them as 'unhandled'.
    vi.mocked(logger.error).mockClear();
    handleRouteError(Object.assign(new Error("nope"), { status: 403 }));
    expect(logger.error).not.toHaveBeenCalled();
  });
});

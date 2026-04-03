import { describe, it, expect } from "vitest";
import { successResponse, errorResponse, handleRouteError } from "@/lib/api-response";
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
});

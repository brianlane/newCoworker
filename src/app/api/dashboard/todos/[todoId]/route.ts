/**
 * Manage one to-do.
 *
 * PATCH  /api/dashboard/todos/:todoId?businessId=<uuid>
 *   body: todoPatchSchema → { todo }. `completed` runs the completion-stamp
 *   rules (stamps completed_at/completed_by, clears both on uncheck); a
 *   patch that hands the to-do to a NEW assignee texts that roster member
 *   (best-effort).
 * DELETE /api/dashboard/todos/:todoId?businessId=<uuid>
 *   Deletes the to-do record; linked contact and deal are untouched.
 *
 * Auth: manage_settings (manager+), same bar as the deals routes.
 */

import { z } from "zod";
import type { NextResponse } from "next/server";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { todoPatchSchema } from "@/lib/todos/core";
import { TodoError, deleteTodo, updateTodo } from "@/lib/todos/db";
import { isNewAssignment, notifyTodoAssignment } from "@/lib/todos/notify";

export const dynamic = "force-dynamic";

const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });
const paramsSchema = z.object({ todoId: z.string().uuid() });

type Ctx = { params: Promise<{ todoId: string }> };

function todoErrorResponse(err: TodoError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

/** Explicitly annotated so `"error" in auth` narrows cleanly (an inferred
 * union would synthesize `error?: undefined` onto the success branch). */
async function authorize(
  request: Request,
  params: Ctx["params"]
): Promise<
  { error: NextResponse } | { businessId: string; todoId: string; userId: string | null }
> {
  const user = await getAuthUser();
  if (!user) return { error: errorResponse("UNAUTHORIZED", "Authentication required") };

  const url = new URL(request.url);
  const { businessId } = querySchema.parse({
    businessId: url.searchParams.get("businessId") ?? ""
  });
  const { todoId } = paramsSchema.parse(await params);
  if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

  const limiter = rateLimit(`todos-write:${businessId}:${user.userId}`, WRITE_RATE);
  if (!limiter.success) {
    return { error: errorResponse("CONFLICT", "Too many edits, slow down.", 429) };
  }
  return { businessId, todoId, userId: user.userId ?? null };
}

export async function PATCH(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    const body = todoPatchSchema.parse(await request.json());
    try {
      const { todo, previousAssigneeEmployeeId } = await updateTodo(
        auth.businessId,
        auth.todoId,
        body,
        auth.userId
      );
      // Reassignment text, best-effort by contract (never throws). Only a
      // patch that TOUCHED the assignee can be one, so an unrelated save
      // (title edit, check-off) never re-pings the same person.
      if (
        body.assigneeEmployeeId !== undefined &&
        isNewAssignment(previousAssigneeEmployeeId, todo.assigneeEmployeeId)
      ) {
        await notifyTodoAssignment(auth.businessId, todo);
      }
      return successResponse({ todo });
    } catch (err) {
      if (err instanceof TodoError) return todoErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    const auth = await authorize(request, params);
    if ("error" in auth) return auth.error;

    try {
      await deleteTodo(auth.businessId, auth.todoId);
      return successResponse({ deleted: true });
    } catch (err) {
      if (err instanceof TodoError) return todoErrorResponse(err);
      throw err;
    }
  } catch (err) {
    return handleRouteError(err);
  }
}

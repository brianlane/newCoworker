/**
 * To-dos (assignable follow-up work).
 *
 * GET  /api/dashboard/todos?businessId=<uuid>[&status=open|overdue|done][&assigneeEmployeeId=<uuid>]
 *        → { todos: TodoWithRefs[], employees: {id,name}[] } (newest due
 *          first; employees is the same roster the lead card editor's Owner
 *          dropdown offers, for the assignee filter and quick-add)
 *
 * POST /api/dashboard/todos?businessId=<uuid>
 *        body: todoCreateSchema → { todo }
 *        Creating with an assignee texts that roster member (best-effort;
 *        the response never waits on Telnyx failing).
 *
 * Auth: viewing needs view_dashboard (staff work the list); creating needs
 * manage_settings (manager+), same bar as the deals and segments routes.
 */

import { z } from "zod";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import { todoCreateSchema, todoListFilterSchema } from "@/lib/todos/core";
import { TodoError, createTodo, listTodosWithRefs } from "@/lib/todos/db";
import { isNewAssignment, notifyTodoAssignment } from "@/lib/todos/notify";
import { listTeamMembers } from "@/lib/db/employees";

export const dynamic = "force-dynamic";

const READ_RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 30 };

const querySchema = z.object({ businessId: z.string().uuid() });

/** Map a typed lib failure onto the right HTTP class (route-local; Next
 * route modules may only export handlers). */
function todoErrorResponse(err: TodoError) {
  if (err.code === "not_found") return errorResponse("NOT_FOUND", err.message);
  return errorResponse("VALIDATION_ERROR", err.message);
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    const filter = todoListFilterSchema.parse({
      status: url.searchParams.get("status") ?? undefined,
      assigneeEmployeeId: url.searchParams.get("assigneeEmployeeId") ?? undefined
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "view_dashboard");

    const limiter = rateLimit(`todos:${businessId}:${user.userId}`, READ_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const [todos, members] = await Promise.all([
      listTodosWithRefs(businessId, filter),
      listTeamMembers(businessId)
    ]);
    return successResponse({
      todos,
      employees: members.map((m) => ({ id: m.id, name: m.name }))
    });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const { businessId } = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? ""
    });
    if (!user.isAdmin) await requireBusinessRole(businessId, "manage_settings");

    const limiter = rateLimit(`todos-write:${businessId}:${user.userId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many edits, slow down.", 429);
    }

    const body = todoCreateSchema.parse(await request.json());

    try {
      const todo = await createTodo(businessId, body, user.userId ?? null);
      // Best-effort by contract (never throws): the row is already written.
      if (isNewAssignment(null, todo.assigneeEmployeeId)) {
        await notifyTodoAssignment(businessId, todo);
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

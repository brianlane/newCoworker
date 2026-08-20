import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  requireBusinessRole: vi.fn(),
  getAuthUser: vi.fn()
}));

vi.mock("@/lib/todos/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/todos/db")>();
  return {
    TodoError: actual.TodoError,
    listTodosWithRefs: vi.fn(),
    createTodo: vi.fn(),
    updateTodo: vi.fn(),
    deleteTodo: vi.fn()
  };
});

// Keep isNewAssignment real (it decides WHEN to text); stub only the send.
vi.mock("@/lib/todos/notify", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/todos/notify")>();
  return { ...actual, notifyTodoAssignment: vi.fn() };
});

vi.mock("@/lib/db/employees", () => ({ listTeamMembers: vi.fn() }));

import { GET, POST } from "@/app/api/dashboard/todos/route";
import { PATCH, DELETE } from "@/app/api/dashboard/todos/[todoId]/route";
import { getAuthUser, requireBusinessRole } from "@/lib/auth";
import {
  TodoError,
  createTodo,
  deleteTodo,
  listTodosWithRefs,
  updateTodo
} from "@/lib/todos/db";
import { notifyTodoAssignment } from "@/lib/todos/notify";
import { listTeamMembers } from "@/lib/db/employees";

const BIZ = "11111111-1111-4111-8111-111111111111";
const TODO_ID = "22222222-2222-4222-8222-222222222222";
const EMP = "33333333-3333-4333-8333-333333333333";

const USER = { userId: "u-1", email: "owner@example.com", isAdmin: false };

const TODO = {
  id: TODO_ID,
  businessId: BIZ,
  contactId: null,
  dealId: null,
  title: "Send the packet",
  details: null,
  assigneeEmployeeId: null as string | null,
  dueAt: null,
  completedAt: null,
  completedBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  contactE164: null,
  contactName: null,
  dealTitle: null
};

function post(body: unknown) {
  return POST(
    new Request(`http://localhost/api/dashboard/todos?businessId=${BIZ}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    })
  );
}

function patch(body: unknown, todoId = TODO_ID) {
  return PATCH(
    new Request(`http://localhost/api/dashboard/todos/${todoId}?businessId=${BIZ}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }),
    { params: Promise.resolve({ todoId }) }
  );
}

describe("api/dashboard/todos routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getAuthUser).mockResolvedValue(USER as never);
    vi.mocked(requireBusinessRole).mockResolvedValue(USER as never);
    vi.mocked(listTodosWithRefs).mockResolvedValue([TODO] as never);
    vi.mocked(listTeamMembers).mockResolvedValue([
      { id: EMP, name: "Gabby", phone_e164: "+15550009999" }
    ] as never);
    vi.mocked(createTodo).mockResolvedValue(TODO as never);
    vi.mocked(updateTodo).mockResolvedValue({
      todo: TODO,
      previousAssigneeEmployeeId: null
    } as never);
    vi.mocked(deleteTodo).mockResolvedValue(undefined as never);
    vi.mocked(notifyTodoAssignment).mockResolvedValue("sent" as never);
  });

  it("GET lists to-dos + the roster behind view_dashboard, passing the filters through", async () => {
    const res = await GET(
      new Request(
        `http://localhost/api/dashboard/todos?businessId=${BIZ}&status=overdue&assigneeEmployeeId=${EMP}`
      )
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.todos).toHaveLength(1);
    // Roster trimmed to the Owner-dropdown shape: no phone numbers leak out.
    expect(body.data.employees).toEqual([{ id: EMP, name: "Gabby" }]);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "view_dashboard");
    expect(listTodosWithRefs).toHaveBeenCalledWith(BIZ, {
      status: "overdue",
      assigneeEmployeeId: EMP
    });
  });

  it("GET validates the query and requires auth", async () => {
    const invalid = await GET(new Request("http://localhost/api/dashboard/todos?businessId=x"));
    expect(invalid.status).toBe(400);

    const badStatus = await GET(
      new Request(`http://localhost/api/dashboard/todos?businessId=${BIZ}&status=late`)
    );
    expect(badStatus.status).toBe(400);

    vi.mocked(getAuthUser).mockResolvedValue(null as never);
    const anon = await GET(new Request(`http://localhost/api/dashboard/todos?businessId=${BIZ}`));
    expect(anon.status).toBe(401);
  });

  it("POST creates behind manage_settings, stamps the creator, and skips the text when unassigned", async () => {
    const res = await post({ title: "Send the packet" });
    expect(res.status).toBe(200);
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
    expect(createTodo).toHaveBeenCalledWith(BIZ, { title: "Send the packet" }, "u-1");
    expect(notifyTodoAssignment).not.toHaveBeenCalled();
  });

  it("POST with an assignee texts that roster member (best-effort)", async () => {
    const assigned = { ...TODO, assigneeEmployeeId: EMP };
    vi.mocked(createTodo).mockResolvedValue(assigned as never);
    const res = await post({ title: "Send the packet", assigneeEmployeeId: EMP });
    expect(res.status).toBe(200);
    expect(notifyTodoAssignment).toHaveBeenCalledWith(BIZ, assigned);
  });

  it("POST validates the body and maps typed lib failures", async () => {
    const invalid = await post({ title: "" });
    expect(invalid.status).toBe(400);
    expect(createTodo).not.toHaveBeenCalled();

    vi.mocked(createTodo).mockRejectedValue(new TodoError("invalid", "bad link"));
    const badLink = await post({ title: "ok" });
    expect(badLink.status).toBe(400);

    vi.mocked(createTodo).mockRejectedValue(new Error("boom"));
    const boom = await post({ title: "ok" });
    expect(boom.status).toBe(500);
  });

  it("PATCH updates behind manage_settings, threading the actor for completed_by", async () => {
    const ok = await patch({ completed: true });
    expect(ok.status).toBe(200);
    expect(updateTodo).toHaveBeenCalledWith(BIZ, TODO_ID, { completed: true }, "u-1");
    expect(requireBusinessRole).toHaveBeenCalledWith(BIZ, "manage_settings");
    expect(notifyTodoAssignment).not.toHaveBeenCalled();

    vi.mocked(updateTodo).mockRejectedValue(new TodoError("not_found", "gone"));
    expect((await patch({ completed: true })).status).toBe(404);

    vi.mocked(updateTodo).mockRejectedValue(new TodoError("invalid", "bad link"));
    expect((await patch({ dealId: TODO_ID })).status).toBe(400);

    vi.mocked(updateTodo).mockRejectedValue(new Error("boom"));
    expect((await patch({ title: "x" })).status).toBe(500);

    const empty = await patch({});
    expect(empty.status).toBe(400);

    const badId = await patch({ completed: true }, "not-a-uuid");
    expect(badId.status).toBe(400);
  });

  it("PATCH texts on a real reassignment, and only then", async () => {
    const reassigned = { ...TODO, assigneeEmployeeId: EMP };

    // Handed to someone new: text them.
    vi.mocked(updateTodo).mockResolvedValue({
      todo: reassigned,
      previousAssigneeEmployeeId: "44444444-4444-4444-8444-444444444444"
    } as never);
    await patch({ assigneeEmployeeId: EMP });
    expect(notifyTodoAssignment).toHaveBeenCalledWith(BIZ, reassigned);

    // Same assignee re-sent: no text.
    vi.mocked(notifyTodoAssignment).mockClear();
    vi.mocked(updateTodo).mockResolvedValue({
      todo: reassigned,
      previousAssigneeEmployeeId: EMP
    } as never);
    await patch({ assigneeEmployeeId: EMP });
    expect(notifyTodoAssignment).not.toHaveBeenCalled();

    // Unassigned: no text.
    vi.mocked(updateTodo).mockResolvedValue({
      todo: TODO,
      previousAssigneeEmployeeId: EMP
    } as never);
    await patch({ assigneeEmployeeId: null });
    expect(notifyTodoAssignment).not.toHaveBeenCalled();

    // A patch that never touched the assignee cannot re-ping, even though
    // the row still carries one.
    vi.mocked(updateTodo).mockResolvedValue({
      todo: reassigned,
      previousAssigneeEmployeeId: null
    } as never);
    await patch({ title: "still yours" });
    expect(notifyTodoAssignment).not.toHaveBeenCalled();
  });

  it("DELETE removes a to-do and maps not_found", async () => {
    const res = await DELETE(
      new Request(`http://localhost/api/dashboard/todos/${TODO_ID}?businessId=${BIZ}`, {
        method: "DELETE"
      }),
      { params: Promise.resolve({ todoId: TODO_ID }) }
    );
    expect(res.status).toBe(200);
    expect(deleteTodo).toHaveBeenCalledWith(BIZ, TODO_ID);

    vi.mocked(deleteTodo).mockRejectedValue(new TodoError("not_found", "gone"));
    const missing = await DELETE(
      new Request(`http://localhost/api/dashboard/todos/${TODO_ID}?businessId=${BIZ}`, {
        method: "DELETE"
      }),
      { params: Promise.resolve({ todoId: TODO_ID }) }
    );
    expect(missing.status).toBe(404);
  });

  it("admins skip the business-role check", async () => {
    vi.mocked(getAuthUser).mockResolvedValue({ ...USER, isAdmin: true } as never);
    const res = await GET(new Request(`http://localhost/api/dashboard/todos?businessId=${BIZ}`));
    expect(res.status).toBe(200);
    expect(requireBusinessRole).not.toHaveBeenCalled();
  });
});

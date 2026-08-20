import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TodoError,
  createTodo,
  deleteTodo,
  listTodos,
  listTodosWithRefs,
  updateTodo
} from "@/lib/todos/db";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/db/contact-names", () => ({
  resolveContactNames: vi.fn()
}));

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";

type Result = { data: unknown; error: unknown };

/** Thenable PostgREST-chain stub (mirrors deals-db.test.ts). */
function chain(result: Result) {
  const c: Record<string, unknown> = {};
  for (const m of [
    "select",
    "insert",
    "update",
    "delete",
    "eq",
    "in",
    "is",
    "not",
    "lt",
    "order",
    "limit",
    "single",
    "maybeSingle"
  ]) {
    c[m] = vi.fn(() => c);
  }
  (c as { then: unknown }).then = (
    resolve: (v: Result) => unknown,
    reject: (e: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return c as Record<string, ReturnType<typeof vi.fn>> & PromiseLike<Result>;
}

function mockDb(queue: Result[]) {
  const remaining = [...queue];
  const chains: ReturnType<typeof chain>[] = [];
  const from = vi.fn(() => {
    const result =
      remaining.length > 1
        ? remaining.shift()!
        : remaining[0] ?? { data: null, error: { message: "no mock" } };
    const c = chain(result);
    chains.push(c);
    return c;
  });
  return { from, chains };
}

const ROW = {
  id: "todo-1",
  business_id: "biz-1",
  contact_id: null as string | null,
  deal_id: null as string | null,
  title: "Send the packet",
  details: null as string | null,
  assignee_employee_id: null as string | null,
  due_at: "2026-08-25T21:00:00.000Z" as string | null,
  completed_at: null as string | null,
  completed_by: null as string | null,
  created_at: "2026-08-01T00:00:00.000Z",
  updated_at: "2026-08-01T00:00:00.000Z"
};

const TODO = {
  id: "todo-1",
  businessId: "biz-1",
  contactId: null,
  dealId: null,
  title: "Send the packet",
  details: null,
  assigneeEmployeeId: null,
  dueAt: "2026-08-25T21:00:00.000Z",
  completedAt: null,
  completedBy: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z"
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolveContactNames).mockResolvedValue(new Map());
});

describe("listTodos", () => {
  it("maps rows onto the camelCase Todo shape, newest due first with nulls last", async () => {
    const db = mockDb([{ data: [ROW], error: null }]);
    expect(await listTodos("biz-1", {}, db as never)).toEqual([TODO]);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].order).toHaveBeenCalledWith("due_at", {
      ascending: false,
      nullsFirst: false
    });
    expect(db.chains[0].order).toHaveBeenCalledWith("created_at", { ascending: false });
    // No status filter: none of the completion predicates apply.
    expect(db.chains[0].is).not.toHaveBeenCalled();
    expect(db.chains[0].not).not.toHaveBeenCalled();
  });

  it("translates each status filter and the assignee filter into predicates", async () => {
    const open = mockDb([{ data: [], error: null }]);
    await listTodos("biz-1", { status: "open" }, open as never);
    expect(open.chains[0].is).toHaveBeenCalledWith("completed_at", null);
    expect(open.chains[0].lt).not.toHaveBeenCalled();

    const done = mockDb([{ data: [], error: null }]);
    await listTodos("biz-1", { status: "done" }, done as never);
    expect(done.chains[0].not).toHaveBeenCalledWith("completed_at", "is", null);

    const now = new Date("2026-08-20T12:00:00.000Z");
    const overdue = mockDb([{ data: [], error: null }]);
    await listTodos(
      "biz-1",
      { status: "overdue", assigneeEmployeeId: "emp-1" },
      overdue as never,
      now
    );
    expect(overdue.chains[0].is).toHaveBeenCalledWith("completed_at", null);
    expect(overdue.chains[0].lt).toHaveBeenCalledWith("due_at", now.toISOString());
    expect(overdue.chains[0].eq).toHaveBeenCalledWith("assignee_employee_id", "emp-1");
  });

  it("handles null rows and creates a service client when none is passed", async () => {
    const db = mockDb([{ data: null, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listTodos("biz-1")).toEqual([]);
  });

  it("throws on a read error", async () => {
    const db = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(listTodos("biz-1", {}, db as never)).rejects.toThrow("listTodos: down");
  });
});

describe("listTodosWithRefs", () => {
  it("resolves contact names (resolver > stored label > raw key) and deal titles", async () => {
    const db = mockDb([
      {
        data: [
          { ...ROW, id: "t1", contact_id: "c1", deal_id: "d1" },
          { ...ROW, id: "t2", contact_id: "c2", deal_id: "d-gone" },
          { ...ROW, id: "t3", contact_id: "c3", deal_id: null },
          { ...ROW, id: "t4", contact_id: null, deal_id: null },
          { ...ROW, id: "t5", contact_id: "c-gone", deal_id: "d1" }
        ],
        error: null
      },
      {
        data: [
          { id: "c1", customer_e164: "+15550001111", display_name: "Stored One" },
          { id: "c2", customer_e164: "+15550002222", display_name: "Stored Two" },
          { id: "c3", customer_e164: "+15550003333", display_name: null }
        ],
        error: null
      },
      { data: [{ id: "d1", title: "Roof job" }], error: null }
    ]);
    vi.mocked(resolveContactNames).mockResolvedValue(
      new Map([["+15550001111", { name: "Resolved One", kind: "customer" as const }]])
    );

    const todos = await listTodosWithRefs("biz-1", {}, db as never);
    expect(todos.map((t) => [t.id, t.contactE164, t.contactName, t.dealTitle])).toEqual([
      ["t1", "+15550001111", "Resolved One", "Roof job"],
      ["t2", "+15550002222", "Stored Two", null],
      ["t3", "+15550003333", "+15550003333", null],
      ["t4", null, null, null],
      ["t5", null, null, "Roof job"]
    ]);
    expect(resolveContactNames).toHaveBeenCalledWith(
      "biz-1",
      ["+15550001111", "+15550002222", "+15550003333"],
      db
    );
  });

  it("skips the linkage queries when nothing is linked", async () => {
    const db = mockDb([{ data: [ROW], error: null }]);
    const todos = await listTodosWithRefs("biz-1", {}, db as never);
    expect(todos[0]).toMatchObject({ contactE164: null, contactName: null, dealTitle: null });
    expect(db.from).toHaveBeenCalledTimes(1);
  });

  it("throws when the contacts or deals read fails, and tolerates null pages", async () => {
    const contactsDown = mockDb([
      { data: [{ ...ROW, contact_id: "c1" }], error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(listTodosWithRefs("biz-1", {}, contactsDown as never)).rejects.toThrow(
      "listTodosWithRefs: contacts: down"
    );

    const dealsDown = mockDb([
      { data: [{ ...ROW, deal_id: "d1" }], error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(listTodosWithRefs("biz-1", {}, dealsDown as never)).rejects.toThrow(
      "listTodosWithRefs: deals: down"
    );

    const nullPages = mockDb([
      { data: [{ ...ROW, contact_id: "c1", deal_id: "d1" }], error: null },
      { data: null, error: null },
      { data: null, error: null }
    ]);
    const todos = await listTodosWithRefs("biz-1", {}, nullPages as never);
    expect(todos[0]).toMatchObject({ contactE164: null, contactName: null, dealTitle: null });
  });

  it("a name-resolution blip degrades to the stored label instead of failing", async () => {
    const db = mockDb([
      { data: [{ ...ROW, contact_id: "c1" }], error: null },
      {
        data: [{ id: "c1", customer_e164: "+15550001111", display_name: "Stored One" }],
        error: null
      }
    ]);
    vi.mocked(resolveContactNames).mockRejectedValue(new Error("resolver down"));
    const todos = await listTodosWithRefs("biz-1", {}, db as never);
    expect(todos[0]).toMatchObject({
      contactE164: "+15550001111",
      contactName: "Stored One"
    });
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: [], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    expect(await listTodosWithRefs("biz-1")).toEqual([]);
  });
});

describe("createTodo", () => {
  it("inserts defaults for a minimal to-do", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    const todo = await createTodo("biz-1", { title: "Send the packet" }, "user-1", db as never);
    expect(todo.id).toBe("todo-1");
    const insert = db.chains[0].insert.mock.calls[0][0];
    expect(insert).toEqual({
      business_id: "biz-1",
      contact_id: null,
      deal_id: null,
      title: "Send the packet",
      details: null,
      assignee_employee_id: null,
      due_at: null,
      created_by: "user-1"
    });
  });

  it("carries every provided field through", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    await createTodo(
      "biz-1",
      {
        title: "Send the packet",
        details: "the signed one",
        contactId: "c1",
        dealId: "d1",
        assigneeEmployeeId: "emp-1",
        dueAt: "2026-08-25T21:00:00.000Z"
      },
      null,
      db as never
    );
    expect(db.chains[0].insert.mock.calls[0][0]).toEqual({
      business_id: "biz-1",
      contact_id: "c1",
      deal_id: "d1",
      title: "Send the packet",
      details: "the signed one",
      assignee_employee_id: "emp-1",
      due_at: "2026-08-25T21:00:00.000Z",
      created_by: null
    });
  });

  it("maps a broken FK onto the invalid error; other failures throw plainly", async () => {
    const fk = mockDb([{ data: null, error: { code: "23503", message: "fk" } }]);
    await expect(
      createTodo("biz-1", { title: "x", contactId: "c-gone" }, null, fk as never)
    ).rejects.toMatchObject({ code: "invalid" });

    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(createTodo("biz-1", { title: "x" }, null, down as never)).rejects.toThrow(
      "createTodo: down"
    );

    const empty = mockDb([{ data: null, error: null }]);
    await expect(createTodo("biz-1", { title: "x" }, null, empty as never)).rejects.toThrow(
      "insert returned no row"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: ROW, error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const todo = await createTodo("biz-1", { title: "Send the packet" }, null);
    expect(todo.id).toBe("todo-1");
  });
});

describe("updateTodo", () => {
  it("patches fields, reports the previous assignee, and leaves completion alone", async () => {
    const db = mockDb([
      { data: { ...ROW, assignee_employee_id: "emp-old" }, error: null },
      { data: { ...ROW, title: "Resend the packet", assignee_employee_id: "emp-new" }, error: null }
    ]);
    const { todo, previousAssigneeEmployeeId } = await updateTodo(
      "biz-1",
      "todo-1",
      {
        title: "Resend the packet",
        details: "with the addendum",
        contactId: "c1",
        dealId: "d1",
        assigneeEmployeeId: "emp-new",
        dueAt: "2026-08-26T21:00:00.000Z"
      },
      "user-1",
      db as never
    );
    expect(todo.title).toBe("Resend the packet");
    expect(previousAssigneeEmployeeId).toBe("emp-old");
    const update = db.chains[1].update.mock.calls[0][0];
    expect(update).toMatchObject({
      title: "Resend the packet",
      details: "with the addendum",
      contact_id: "c1",
      deal_id: "d1",
      assignee_employee_id: "emp-new",
      due_at: "2026-08-26T21:00:00.000Z"
    });
    expect(update).not.toHaveProperty("completed_at");
    expect(update).not.toHaveProperty("completed_by");
  });

  it("checking off stamps completed_at/by; unchecking clears both", async () => {
    const check = mockDb([
      { data: ROW, error: null },
      { data: { ...ROW, completed_at: "2026-08-20T12:00:00.000Z" }, error: null }
    ]);
    await updateTodo("biz-1", "todo-1", { completed: true }, "user-1", check as never);
    const checkUpdate = check.chains[1].update.mock.calls[0][0];
    expect(typeof checkUpdate.completed_at).toBe("string");
    expect(checkUpdate.completed_by).toBe("user-1");

    const uncheck = mockDb([
      {
        data: { ...ROW, completed_at: "2026-08-20T12:00:00.000Z", completed_by: "user-1" },
        error: null
      },
      { data: ROW, error: null }
    ]);
    await updateTodo("biz-1", "todo-1", { completed: false }, "user-2", uncheck as never);
    const uncheckUpdate = uncheck.chains[1].update.mock.calls[0][0];
    expect(uncheckUpdate.completed_at).toBeNull();
    expect(uncheckUpdate.completed_by).toBeNull();
  });

  it("re-sending the current completion state never rewrites the stamp", async () => {
    const db = mockDb([
      {
        data: { ...ROW, completed_at: "2026-08-01T00:00:00.000Z", completed_by: "user-0" },
        error: null
      },
      {
        data: { ...ROW, completed_at: "2026-08-01T00:00:00.000Z", completed_by: "user-0" },
        error: null
      }
    ]);
    await updateTodo("biz-1", "todo-1", { completed: true }, "user-2", db as never);
    const update = db.chains[1].update.mock.calls[0][0];
    expect(update).not.toHaveProperty("completed_at");
    expect(update).not.toHaveProperty("completed_by");
  });

  it("read failures, missing rows, and write failures map distinctly", async () => {
    const readDown = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(
      updateTodo("biz-1", "todo-1", { title: "x" }, null, readDown as never)
    ).rejects.toThrow("updateTodo: read: down");

    const missing = mockDb([{ data: null, error: null }]);
    await expect(
      updateTodo("biz-1", "todo-x", { title: "x" }, null, missing as never)
    ).rejects.toMatchObject({ code: "not_found" });

    const fk = mockDb([
      { data: ROW, error: null },
      { data: null, error: { code: "23503", message: "fk" } }
    ]);
    await expect(
      updateTodo("biz-1", "todo-1", { dealId: "d-gone" }, null, fk as never)
    ).rejects.toMatchObject({ code: "invalid" });

    const writeDown = mockDb([
      { data: ROW, error: null },
      { data: null, error: { message: "down" } }
    ]);
    await expect(
      updateTodo("biz-1", "todo-1", { title: "x" }, null, writeDown as never)
    ).rejects.toThrow("updateTodo: down");

    // A no-match write returns no error and no row: still not found.
    const vanished = mockDb([
      { data: ROW, error: null },
      { data: null, error: null }
    ]);
    await expect(
      updateTodo("biz-1", "todo-1", { title: "x" }, null, vanished as never)
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([
      { data: ROW, error: null },
      { data: ROW, error: null }
    ]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const { todo } = await updateTodo("biz-1", "todo-1", { title: "Send the packet" }, null);
    expect(todo.id).toBe("todo-1");
  });
});

describe("deleteTodo", () => {
  it("deletes by business + id", async () => {
    const db = mockDb([{ data: [{ id: "todo-1" }], error: null }]);
    await deleteTodo("biz-1", "todo-1", db as never);
    expect(db.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");
    expect(db.chains[0].eq).toHaveBeenCalledWith("id", "todo-1");
  });

  it("zero deleted rows is not_found; a db error throws plainly", async () => {
    const missing = mockDb([{ data: [], error: null }]);
    await expect(deleteTodo("biz-1", "todo-x", missing as never)).rejects.toMatchObject({
      code: "not_found"
    });
    await expect(
      deleteTodo("biz-1", "todo-x", mockDb([{ data: null, error: null }]) as never)
    ).rejects.toBeInstanceOf(TodoError);

    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(deleteTodo("biz-1", "todo-1", down as never)).rejects.toThrow(
      "deleteTodo: down"
    );
  });

  it("creates a service client when none is passed", async () => {
    const db = mockDb([{ data: [{ id: "todo-1" }], error: null }]);
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await deleteTodo("biz-1", "todo-1");
    expect(db.from).toHaveBeenCalled();
  });
});

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
  // The table name is recorded (not used here) so a test can assert WHICH
  // table each query hit, which is how the in-business checks are proven.
  const from = vi.fn((_table: string) => {
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

/**
 * The three linked rows a to-do can name, each with the table its
 * in-business lookup must hit and the word the refusal uses. Drives the
 * cross-tenant cases for both createTodo and updateTodo.
 */
const REFS = [
  {
    noun: "contact",
    table: "contacts",
    column: "contact_id",
    create: (id: string) => ({ title: "x", contactId: id }),
    patch: (id: string) => ({ contactId: id })
  },
  {
    noun: "deal",
    table: "deals",
    column: "deal_id",
    create: (id: string) => ({ title: "x", dealId: id }),
    patch: (id: string) => ({ dealId: id })
  },
  {
    noun: "teammate",
    table: "ai_flow_team_members",
    column: "assignee_employee_id",
    create: (id: string) => ({ title: "x", assigneeEmployeeId: id }),
    patch: (id: string) => ({ assigneeEmployeeId: id })
  }
] as const;

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

  it("chunks the contact and deal lookups so the .in() URLs stay bounded", async () => {
    // A full page can carry TODOS_LIST_LIMIT (500) distinct ids; one .in()
    // of that many uuids rides the GET URL and blows past URI limits.
    const linked = Array.from({ length: 151 }, (_, i) => ({
      ...ROW,
      id: `t${i}`,
      contact_id: `c${i}`,
      deal_id: `d${i}`
    }));
    const db = mockDb([
      { data: linked, error: null },
      // contacts chunk 1 (150) then chunk 2 (1), same for deals.
      {
        data: Array.from({ length: 150 }, (_, i) => ({
          id: `c${i}`,
          customer_e164: `+1555000${i}`,
          display_name: `Name ${i}`
        })),
        error: null
      },
      {
        data: [{ id: "c150", customer_e164: "+1555000150", display_name: "Name 150" }],
        error: null
      },
      {
        data: Array.from({ length: 150 }, (_, i) => ({ id: `d${i}`, title: `Deal ${i}` })),
        error: null
      },
      { data: [{ id: "d150", title: "Deal 150" }], error: null }
    ]);

    const todos = await listTodosWithRefs("biz-1", {}, db as never);
    expect(db.from.mock.calls.map((c) => c[0])).toEqual([
      "todos",
      "contacts",
      "contacts",
      "deals",
      "deals"
    ]);
    expect(db.chains[1].in.mock.calls[0][1]).toHaveLength(150);
    expect(db.chains[2].in.mock.calls[0][1]).toHaveLength(1);
    expect(db.chains[3].in.mock.calls[0][1]).toHaveLength(150);
    expect(db.chains[4].in.mock.calls[0][1]).toHaveLength(1);
    // Every row on the page still resolves, including the ones past chunk 1.
    expect(todos).toHaveLength(151);
    expect(todos.every((t) => t.contactName !== null && t.dealTitle !== null)).toBe(true);
    expect(todos[150]).toMatchObject({ contactName: "Name 150", dealTitle: "Deal 150" });
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

  it("carries every provided field through, after all three in-business checks", async () => {
    const db = mockDb([
      { data: { id: "c1" }, error: null }, // contact lookup
      { data: { id: "d1" }, error: null }, // deal lookup
      { data: { id: "emp-1" }, error: null }, // assignee lookup
      { data: ROW, error: null }
    ]);
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
    // Each link was proven to belong to this business before the write.
    expect(db.from.mock.calls.map((c) => c[0])).toEqual([
      "contacts",
      "deals",
      "ai_flow_team_members",
      "todos"
    ]);
    for (const [i, id] of [
      [0, "c1"],
      [1, "d1"],
      [2, "emp-1"]
    ] as const) {
      expect(db.chains[i].eq).toHaveBeenCalledWith("business_id", "biz-1");
      expect(db.chains[i].eq).toHaveBeenCalledWith("id", id);
    }
    expect(db.chains[3].insert.mock.calls[0][0]).toEqual({
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

  it("refuses a contact, deal, or teammate outside this business, and leaks nothing", async () => {
    for (const ref of REFS) {
      // Another tenant's row: the lookup scoped to THIS business finds
      // nothing, exactly as for an id that exists nowhere at all.
      const foreign = mockDb([{ data: null, error: null }]);
      const foreignErr = await createTodo(
        "biz-1",
        ref.create("11111111-1111-1111-1111-111111111111"),
        null,
        foreign as never
      ).catch((e: TodoError) => e);
      expect(foreignErr).toMatchObject({
        code: "invalid",
        message: `That ${ref.noun} does not exist.`
      });
      // The insert never ran: the lookup was the only query.
      expect(foreign.from).toHaveBeenCalledTimes(1);
      expect(foreign.from).toHaveBeenCalledWith(ref.table);
      expect(foreign.chains[0].eq).toHaveBeenCalledWith("business_id", "biz-1");

      const missing = mockDb([{ data: null, error: null }]);
      const missingErr = await createTodo(
        "biz-1",
        ref.create("22222222-2222-2222-2222-222222222222"),
        null,
        missing as never
      ).catch((e: TodoError) => e);
      // Identical failure either way, so a caller cannot probe for real ids.
      expect((missingErr as TodoError).message).toBe((foreignErr as TodoError).message);
      expect((missingErr as TodoError).code).toBe((foreignErr as TodoError).code);
      expect(missing.from).toHaveBeenCalledTimes(1);
    }
  });

  it("a failing in-business lookup throws plainly instead of reading as a bad id", async () => {
    const down = mockDb([{ data: null, error: { message: "down" } }]);
    await expect(
      createTodo("biz-1", { title: "x", contactId: "c1" }, null, down as never)
    ).rejects.toThrow("todos contact lookup: down");
  });

  it("maps only a link-FK race onto invalid; other failures throw plainly", async () => {
    // Each link deleted between its in-business check and the insert.
    for (const ref of REFS) {
      const race = mockDb([
        { data: { id: "ref-1" }, error: null },
        {
          data: null,
          error: {
            code: "23503",
            message: `violates foreign key constraint "todos_${ref.column}_fkey"`
          }
        }
      ]);
      await expect(
        createTodo("biz-1", ref.create("33333333-3333-3333-3333-333333333333"), null, race as never)
      ).rejects.toMatchObject({ code: "invalid", message: `That ${ref.noun} does not exist.` });
    }

    // A 23503 that names no link (business FK) is not a link's fault.
    const bizFk = mockDb([
      {
        data: null,
        error: { code: "23503", message: 'violates foreign key constraint "todos_business_id_fkey"' }
      }
    ]);
    await expect(createTodo("biz-1", { title: "x" }, null, bizFk as never)).rejects.toThrow(
      "createTodo: violates foreign key"
    );

    // A 23503 with no message at all cannot be attributed to any link.
    const bareFk = mockDb([{ data: null, error: { code: "23503" } }]);
    await expect(createTodo("biz-1", { title: "x" }, null, bareFk as never)).rejects.toThrow(
      "createTodo:"
    );

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
      { data: { id: "c1" }, error: null }, // contact lookup
      { data: { id: "d1" }, error: null }, // deal lookup
      { data: { id: "emp-new" }, error: null }, // assignee lookup
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
    // Re-linking is checked against this business before the write lands.
    expect(db.from.mock.calls.map((c) => c[0])).toEqual([
      "todos",
      "contacts",
      "deals",
      "ai_flow_team_members",
      "todos"
    ]);
    const update = db.chains[4].update.mock.calls[0][0];
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

  it("refuses re-linking to another business's contact, deal, or teammate", async () => {
    for (const ref of REFS) {
      const foreign = mockDb([
        { data: ROW, error: null },
        { data: null, error: null } // the in-business lookup finds nothing
      ]);
      const foreignErr = await updateTodo(
        "biz-1",
        "todo-1",
        ref.patch("11111111-1111-1111-1111-111111111111"),
        null,
        foreign as never
      ).catch((e: TodoError) => e);
      expect(foreignErr).toMatchObject({
        code: "invalid",
        message: `That ${ref.noun} does not exist.`
      });
      // Read plus lookup only: the update never ran.
      expect(foreign.from.mock.calls.map((c) => c[0])).toEqual(["todos", ref.table]);

      const missing = mockDb([
        { data: ROW, error: null },
        { data: null, error: null }
      ]);
      const missingErr = await updateTodo(
        "biz-1",
        "todo-1",
        ref.patch("22222222-2222-2222-2222-222222222222"),
        null,
        missing as never
      ).catch((e: TodoError) => e);
      // Same refusal for an id that exists nowhere: nothing to probe with.
      expect((missingErr as TodoError).message).toBe((foreignErr as TodoError).message);
      expect(missing.from).toHaveBeenCalledTimes(2);
    }
  });

  it("clearing the links writes null without any lookup", async () => {
    const db = mockDb([
      {
        data: { ...ROW, contact_id: "c1", deal_id: "d1", assignee_employee_id: "emp-1" },
        error: null
      },
      { data: ROW, error: null }
    ]);
    await updateTodo(
      "biz-1",
      "todo-1",
      { contactId: null, dealId: null, assigneeEmployeeId: null },
      null,
      db as never
    );
    expect(db.from).toHaveBeenCalledTimes(2);
    const update = db.chains[1].update.mock.calls[0][0];
    expect(update.contact_id).toBeNull();
    expect(update.deal_id).toBeNull();
    expect(update.assignee_employee_id).toBeNull();
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

    // The deal passed its in-business check and was deleted before the write.
    const fk = mockDb([
      { data: ROW, error: null },
      { data: { id: "d1" }, error: null },
      {
        data: null,
        error: { code: "23503", message: 'violates foreign key constraint "todos_deal_id_fkey"' }
      }
    ]);
    await expect(
      updateTodo("biz-1", "todo-1", { dealId: "d1" }, null, fk as never)
    ).rejects.toMatchObject({ code: "invalid", message: "That deal does not exist." });

    // A 23503 naming no link surfaces plainly rather than blaming a link.
    const otherFk = mockDb([
      { data: ROW, error: null },
      {
        data: null,
        error: { code: "23503", message: 'violates foreign key constraint "todos_business_id_fkey"' }
      }
    ]);
    await expect(
      updateTodo("biz-1", "todo-1", { title: "x" }, null, otherFk as never)
    ).rejects.toThrow("updateTodo: violates foreign key");

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

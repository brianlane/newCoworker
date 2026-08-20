/**
 * Supabase access for to-dos. Service-role only; authorization is the API
 * route's job via requireBusinessRole, same trust model as the deals /
 * documents db modules. The overdue predicate and the completion-stamp rules
 * live in ./core; this module translates list filters into PostgREST
 * queries and writes the outcome.
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { resolveContactNames } from "@/lib/db/contact-names";
import {
  todoCompletionStamps,
  type Todo,
  type TodoCreateInput,
  type TodoListFilter,
  type TodoPatchInput
} from "./core";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/**
 * Explicit list cap: PostgREST silently truncates un-limited selects at
 * 1000 rows, so the cap is stated where the reader can see it.
 */
export const TODOS_LIST_LIMIT = 500;

/** Typed failure the API routes map onto 4xx responses. */
export class TodoError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid",
    message: string
  ) {
    super(message);
    this.name = "TodoError";
  }
}

type TodoRow = {
  id: string;
  business_id: string;
  contact_id: string | null;
  deal_id: string | null;
  title: string;
  details: string | null;
  assignee_employee_id: string | null;
  due_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  created_at: string;
  updated_at: string;
};

// One literal (never concatenated): supabase-js parses the select string at
// the type level, and a widened `string` degrades every row to a parse error.
const TODO_COLUMNS =
  "id, business_id, contact_id, deal_id, title, details, assignee_employee_id, due_at, completed_at, completed_by, created_at, updated_at";

function toTodo(row: TodoRow): Todo {
  return {
    id: row.id,
    businessId: row.business_id,
    contactId: row.contact_id,
    dealId: row.deal_id,
    title: row.title,
    details: row.details,
    assigneeEmployeeId: row.assignee_employee_id,
    dueAt: row.due_at,
    completedAt: row.completed_at,
    completedBy: row.completed_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * A business's to-dos, newest due date first (no due date sorts last, ties
 * break newest created first), filtered server-side:
 *
 *   open    - not completed (includes overdue rows; the UI derives the flag)
 *   overdue - not completed AND due before `now` (the ./core predicate,
 *             expressed as a range so the index serves it)
 *   done    - completed
 *
 * plus an optional assignee filter. No status filter = everything.
 */
export async function listTodos(
  businessId: string,
  filter: TodoListFilter = {},
  client?: SupabaseClient,
  now: Date = new Date()
): Promise<Todo[]> {
  const db = client ?? (await createSupabaseServiceClient());
  let query = db.from("todos").select(TODO_COLUMNS).eq("business_id", businessId);
  if (filter.status === "open") {
    query = query.is("completed_at", null);
  } else if (filter.status === "done") {
    query = query.not("completed_at", "is", null);
  } else if (filter.status === "overdue") {
    query = query.is("completed_at", null).lt("due_at", now.toISOString());
  }
  if (filter.assigneeEmployeeId) {
    query = query.eq("assignee_employee_id", filter.assigneeEmployeeId);
  }
  const { data, error } = await query
    .order("due_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false })
    .limit(TODOS_LIST_LIMIT);
  if (error) throw new Error(`listTodos: ${error.message}`);
  return ((data ?? []) as TodoRow[]).map(toTodo);
}

/** A to-do plus the display facts the list needs about its links. */
export type TodoWithRefs = Todo & {
  /** The linked contact's key (E.164 or an email: key); null when unlinked. */
  contactE164: string | null;
  /** Resolved display name, falling back to the stored label then the key. */
  contactName: string | null;
  /** The linked deal's title; null when unlinked or the deal is gone. */
  dealTitle: string | null;
};

/**
 * The list read: to-dos plus each linked contact's key and resolved name
 * (same resolver precedence as the deals board) and each linked deal's
 * title. Name-resolution blips degrade to the stored display label rather
 * than failing the list.
 */
export async function listTodosWithRefs(
  businessId: string,
  filter: TodoListFilter = {},
  client?: SupabaseClient
): Promise<TodoWithRefs[]> {
  const db = client ?? (await createSupabaseServiceClient());
  const todos = await listTodos(businessId, filter, db);
  const contactIds = [
    ...new Set(todos.map((t) => t.contactId).filter((id): id is string => !!id))
  ];
  const dealIds = [...new Set(todos.map((t) => t.dealId).filter((id): id is string => !!id))];

  const contacts = new Map<string, { e164: string; displayName: string | null }>();
  if (contactIds.length > 0) {
    const { data, error } = await db
      .from("contacts")
      .select("id, customer_e164, display_name")
      .eq("business_id", businessId)
      .in("id", contactIds);
    if (error) throw new Error(`listTodosWithRefs: contacts: ${error.message}`);
    for (const row of (data ?? []) as {
      id: string;
      customer_e164: string;
      display_name: string | null;
    }[]) {
      contacts.set(row.id, { e164: row.customer_e164, displayName: row.display_name });
    }
  }

  const dealTitles = new Map<string, string>();
  if (dealIds.length > 0) {
    const { data, error } = await db
      .from("deals")
      .select("id, title")
      .eq("business_id", businessId)
      .in("id", dealIds);
    if (error) throw new Error(`listTodosWithRefs: deals: ${error.message}`);
    for (const row of (data ?? []) as { id: string; title: string }[]) {
      dealTitles.set(row.id, row.title);
    }
  }

  const names = await resolveContactNames(
    businessId,
    [...contacts.values()].map((c) => c.e164),
    db
  ).catch(() => new Map<string, { name: string }>());

  return todos.map((todo) => {
    const contact = todo.contactId ? contacts.get(todo.contactId) ?? null : null;
    return {
      ...todo,
      contactE164: contact?.e164 ?? null,
      contactName: contact
        ? names.get(contact.e164)?.name ?? contact.displayName ?? contact.e164
        : null,
      dealTitle: todo.dealId ? dealTitles.get(todo.dealId) ?? null : null
    };
  });
}

/** Insert a new to-do (always created open; completion is a later PATCH). */
export async function createTodo(
  businessId: string,
  input: TodoCreateInput,
  createdBy: string | null,
  client?: SupabaseClient
): Promise<Todo> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("todos")
    .insert({
      business_id: businessId,
      contact_id: input.contactId ?? null,
      deal_id: input.dealId ?? null,
      title: input.title,
      details: input.details ?? null,
      assignee_employee_id: input.assigneeEmployeeId ?? null,
      due_at: input.dueAt ?? null,
      created_by: createdBy
    })
    .select(TODO_COLUMNS)
    .single();
  if (error || !data) {
    // A bogus contact/deal/assignee id (23503) is caller input, not an outage.
    if ((error as { code?: string } | null)?.code === "23503") {
      throw new TodoError("invalid", "That contact, deal, or teammate does not exist.");
    }
    throw new Error(`createTodo: ${error?.message ?? "insert returned no row"}`);
  }
  return toTodo(data as TodoRow);
}

/** An update plus who held the to-do before it, so the caller can tell a
 * reassignment from a no-op without a second read. */
export type TodoUpdateResult = {
  todo: Todo;
  previousAssigneeEmployeeId: string | null;
};

/**
 * Patch a to-do. `completed` runs through the ./core stamp rules and only
 * when it actually flips, so re-sending `completed: true` never rewrites
 * WHEN (or by whom) it was originally checked off.
 */
export async function updateTodo(
  businessId: string,
  todoId: string,
  patch: TodoPatchInput,
  /** auth.users id stamped into completed_by when this patch checks it off. */
  actorUserId: string | null,
  client?: SupabaseClient
): Promise<TodoUpdateResult> {
  const db = client ?? (await createSupabaseServiceClient());

  const { data: currentRow, error: readError } = await db
    .from("todos")
    .select(TODO_COLUMNS)
    .eq("business_id", businessId)
    .eq("id", todoId)
    .maybeSingle();
  if (readError) throw new Error(`updateTodo: read: ${readError.message}`);
  if (!currentRow) throw new TodoError("not_found", "To-do not found.");
  const current = toTodo(currentRow as TodoRow);

  const updates: Record<string, unknown> = {
    updated_at: new Date().toISOString(),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.details !== undefined ? { details: patch.details } : {}),
    ...(patch.contactId !== undefined ? { contact_id: patch.contactId } : {}),
    ...(patch.dealId !== undefined ? { deal_id: patch.dealId } : {}),
    ...(patch.assigneeEmployeeId !== undefined
      ? { assignee_employee_id: patch.assigneeEmployeeId }
      : {}),
    ...(patch.dueAt !== undefined ? { due_at: patch.dueAt } : {})
  };
  if (patch.completed !== undefined && patch.completed !== (current.completedAt !== null)) {
    Object.assign(
      updates,
      todoCompletionStamps(patch.completed, new Date().toISOString(), actorUserId)
    );
  }

  const { data, error } = await db
    .from("todos")
    .update(updates)
    .eq("business_id", businessId)
    .eq("id", todoId)
    .select(TODO_COLUMNS)
    .maybeSingle();
  if (error) {
    if ((error as { code?: string }).code === "23503") {
      throw new TodoError("invalid", "That contact, deal, or teammate does not exist.");
    }
    throw new Error(`updateTodo: ${error.message}`);
  }
  // A no-match update returns no error and no row (PostgREST), so the
  // deleted-between-read-and-write race still reads as not found.
  if (!data) throw new TodoError("not_found", "To-do not found.");
  return {
    todo: toTodo(data as TodoRow),
    previousAssigneeEmployeeId: current.assigneeEmployeeId
  };
}

/** Delete a to-do (work record only; contact and deal are untouched). */
export async function deleteTodo(
  businessId: string,
  todoId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("todos")
    .delete()
    .eq("business_id", businessId)
    .eq("id", todoId)
    .select("id");
  if (error) throw new Error(`deleteTodo: ${error.message}`);
  if ((data ?? []).length === 0) throw new TodoError("not_found", "To-do not found.");
}

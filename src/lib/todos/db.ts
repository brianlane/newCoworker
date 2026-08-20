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

/**
 * Linked ids per .in() chunk: a PostgREST .in() rides the GET URL, and a
 * full page of to-dos can carry TODOS_LIST_LIMIT (500) distinct uuids, which
 * blows past common URI limits. Same bound the deals board uses.
 */
const REF_CHUNK = 150;

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
  for (let i = 0; i < contactIds.length; i += REF_CHUNK) {
    const chunk = contactIds.slice(i, i + REF_CHUNK);
    const { data, error } = await db
      .from("contacts")
      .select("id, customer_e164, display_name")
      .eq("business_id", businessId)
      .in("id", chunk);
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
  for (let i = 0; i < dealIds.length; i += REF_CHUNK) {
    const chunk = dealIds.slice(i, i + REF_CHUNK);
    const { data, error } = await db
      .from("deals")
      .select("id, title")
      .eq("business_id", businessId)
      .in("id", chunk);
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

/**
 * The three rows a to-do can point at: the table each link lives in, the
 * column the FK error names, and the word the caller sees when the link is
 * refused. One map so the lookup and the error mapping can never drift.
 */
const TODO_REFS = {
  contact: { table: "contacts", column: "contact_id", noun: "contact" },
  deal: { table: "deals", column: "deal_id", noun: "deal" },
  assignee: {
    table: "ai_flow_team_members",
    column: "assignee_employee_id",
    noun: "teammate"
  }
} as const;

type TodoRefKind = keyof typeof TODO_REFS;

/** The link ids a create or a patch can carry. */
type TodoRefInput = {
  contactId?: string | null;
  dealId?: string | null;
  assigneeEmployeeId?: string | null;
};

/**
 * Cross-tenant guard, the same lookup the deals module runs before linking:
 * a row being linked must exist IN THIS BUSINESS. The bare FK only proves
 * the uuid exists somewhere, so without this a manager could attach another
 * tenant's contact, deal, or roster member, and could tell a real uuid from
 * a made-up one by whether the write succeeded. A foreign id and a
 * nonexistent id fail identically here, so nothing leaks either way. No-op
 * when no link is being written (undefined = untouched, null = clearing).
 */
async function assertRefInBusiness(
  db: SupabaseClient,
  businessId: string,
  kind: TodoRefKind,
  id: string | null | undefined
): Promise<void> {
  if (!id) return;
  const { table, noun } = TODO_REFS[kind];
  const { data, error } = await db
    .from(table)
    .select("id")
    .eq("business_id", businessId)
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`todos ${noun} lookup: ${error.message}`);
  if (!data) throw new TodoError("invalid", `That ${noun} does not exist.`);
}

/** All three links, checked in a fixed order so the refusal is stable. */
async function assertRefsInBusiness(
  db: SupabaseClient,
  businessId: string,
  refs: TodoRefInput
): Promise<void> {
  await assertRefInBusiness(db, businessId, "contact", refs.contactId);
  await assertRefInBusiness(db, businessId, "deal", refs.dealId);
  await assertRefInBusiness(db, businessId, "assignee", refs.assigneeEmployeeId);
}

/**
 * The word for the link an FK failure blames, or null when the failure is
 * not one of ours (a business_id FK failure, or a 23503 with no message,
 * must surface plainly rather than be blamed on a link the caller sent).
 * Reached only by the delete race: the row passed its in-business check and
 * was deleted before the write landed.
 */
function fkViolationNoun(error: { code?: string; message?: string } | null): string | null {
  if (error?.code !== "23503") return null;
  const message = error.message ?? "";
  for (const ref of Object.values(TODO_REFS)) {
    if (message.includes(ref.column)) return ref.noun;
  }
  return null;
}

/** Insert a new to-do (always created open; completion is a later PATCH). */
export async function createTodo(
  businessId: string,
  input: TodoCreateInput,
  createdBy: string | null,
  client?: SupabaseClient
): Promise<Todo> {
  const db = client ?? (await createSupabaseServiceClient());
  await assertRefsInBusiness(db, businessId, input);
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
    // A link passed its in-business check but was deleted mid-flight.
    const noun = fkViolationNoun(error as { code?: string; message?: string } | null);
    if (noun) throw new TodoError("invalid", `That ${noun} does not exist.`);
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

  // Re-linking is a cross-tenant surface exactly like creating; clearing a
  // link (null) needs no lookup.
  await assertRefsInBusiness(db, businessId, patch);

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
    // A link passed its in-business check but was deleted mid-flight.
    const noun = fkViolationNoun(error as { code?: string; message?: string });
    if (noun) throw new TodoError("invalid", `That ${noun} does not exist.`);
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

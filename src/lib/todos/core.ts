/**
 * To-dos (assignable follow-up work), pure domain rules.
 *
 * A to-do is a short piece of work the business is tracking: a title, an
 * optional due instant, optional notes, and optional links to the contact it
 * is about, the deal it advances, and the roster member on the hook for it.
 * Deliberately named "todo", never "task": on this codebase a task is a lead
 * in motion (the Tasks board), and the two concepts must not collide.
 *
 * Completion is a stamp (`completedAt`), and "overdue" is DERIVED from it:
 * due in the past AND not completed. Nothing stores an overdue flag, so it
 * can never go stale (no cron in v1; overdue is a UI state).
 *
 * Types-only + pure functions (no Supabase import) so client components can
 * validate and format without server code.
 */
import { z } from "zod";

export const MAX_TODO_TITLE_LENGTH = 200;
export const MAX_TODO_DETAILS_LENGTH = 2000;

/** The three list filters the UI offers. `open` includes overdue rows. */
export const TODO_STATUS_FILTERS = ["open", "overdue", "done"] as const;
export type TodoStatusFilter = (typeof TODO_STATUS_FILTERS)[number];

/** ISO instant with an explicit offset ("2026-08-25T21:00:00.000Z"). */
const dueAtSchema = z.string().datetime({ offset: true });

const todoFields = {
  title: z.string().trim().min(1).max(MAX_TODO_TITLE_LENGTH),
  /** Longer notes; null = none. Trimmed-empty normalizes to null. */
  details: z
    .string()
    .trim()
    .max(MAX_TODO_DETAILS_LENGTH)
    .transform((v) => (v.length > 0 ? v : null))
    .nullable(),
  /** Contact this to-do is about; null = not linked. */
  contactId: z.string().uuid().nullable(),
  /** Deal this to-do advances; null = not linked. */
  dealId: z.string().uuid().nullable(),
  /** Roster member on the hook; null = unassigned. */
  assigneeEmployeeId: z.string().uuid().nullable(),
  dueAt: dueAtSchema.nullable(),
  /** PATCH-only: true stamps completion, false clears it. */
  completed: z.boolean()
};

/** POST body: title required, everything else optional. `strict()` so a
 * typo'd key is a validation error instead of a silently-dropped field. */
export const todoCreateSchema = z
  .object({
    title: todoFields.title,
    details: todoFields.details.optional(),
    contactId: todoFields.contactId.optional(),
    dealId: todoFields.dealId.optional(),
    assigneeEmployeeId: todoFields.assigneeEmployeeId.optional(),
    dueAt: todoFields.dueAt.optional()
  })
  .strict();

export type TodoCreateInput = z.infer<typeof todoCreateSchema>;

/** PATCH body: any subset of the fields, but not an empty patch. */
export const todoPatchSchema = z
  .object({
    title: todoFields.title.optional(),
    details: todoFields.details.optional(),
    contactId: todoFields.contactId.optional(),
    dealId: todoFields.dealId.optional(),
    assigneeEmployeeId: todoFields.assigneeEmployeeId.optional(),
    dueAt: todoFields.dueAt.optional(),
    completed: todoFields.completed.optional()
  })
  .strict()
  .refine((b) => Object.values(b).some((v) => v !== undefined), {
    message: "Nothing to update."
  });

export type TodoPatchInput = z.infer<typeof todoPatchSchema>;

/** GET query filters (businessId is validated separately by the route). */
export const todoListFilterSchema = z.object({
  status: z.enum(TODO_STATUS_FILTERS).optional(),
  assigneeEmployeeId: z.string().uuid().optional()
});

export type TodoListFilter = z.infer<typeof todoListFilterSchema>;

/** A to-do as the API serves it. */
export type Todo = {
  id: string;
  businessId: string;
  contactId: string | null;
  dealId: string | null;
  title: string;
  details: string | null;
  assigneeEmployeeId: string | null;
  dueAt: string | null;
  completedAt: string | null;
  completedBy: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * The overdue predicate, the ONE definition every surface shares: due in the
 * past and not completed. A to-do with no due date is never overdue, and a
 * completed one stops being overdue however late it was finished.
 */
export function isTodoOverdue(
  todo: Pick<Todo, "dueAt" | "completedAt">,
  now: Date = new Date()
): boolean {
  if (todo.completedAt !== null) return false;
  if (todo.dueAt === null) return false;
  const due = new Date(todo.dueAt).getTime();
  return Number.isFinite(due) && due < now.getTime();
}

/**
 * Whether a row (still) belongs under a list filter chip. Mirrors the
 * server-side predicates in listTodos (src/lib/todos/db.ts) so the client can
 * settle membership after a local edit without refetching the whole list.
 * `overdue` leans on isTodoOverdue, which already excludes completed rows.
 */
export function todoMatchesStatusFilter(
  todo: Pick<Todo, "dueAt" | "completedAt">,
  status: TodoStatusFilter,
  now: Date = new Date()
): boolean {
  if (status === "done") return todo.completedAt !== null;
  if (status === "overdue") return isTodoOverdue(todo, now);
  return todo.completedAt === null;
}

/**
 * Where a just-created to-do is actually visible, given the chip the list is
 * showing right now. `null` means it belongs under that chip already, so the
 * list only needs a reload.
 *
 * Quick-add is offered under every chip, but a new to-do is always OPEN
 * (nothing is created checked off). Under Done it can therefore never
 * appear, and under Overdue it appears only when its due date is already
 * past. Reloading in place there clears the form and changes nothing on
 * screen, which reads as a failed save and invites the user to add the same
 * to-do again. Open is the answer whenever the current chip cannot hold it,
 * since Open covers every not-completed row, overdue ones included.
 */
export function todoAddDestination(
  todo: Pick<Todo, "dueAt" | "completedAt">,
  status: TodoStatusFilter,
  now: Date = new Date()
): TodoStatusFilter | null {
  return todoMatchesStatusFilter(todo, status, now) ? null : "open";
}

/**
 * A loaded to-do list together with the filter chip it was loaded UNDER.
 *
 * The two travel as one value on purpose. A completion request can resolve
 * after the user switched chips and a newer list already landed, so the chip
 * captured when that request went out is not the one the rows on screen
 * belong to. Carrying the chip with the rows means membership is always
 * judged against the list being changed, never against a filter that has
 * since moved on.
 */
export type TodoListView<T extends Todo> = {
  status: TodoStatusFilter;
  rows: T[];
};

/**
 * Fold the authoritative row a completion request returned into a loaded
 * list: refresh that row's fields, then drop it when it no longer belongs
 * under the list's own chip (a checked-off row leaves Open and Overdue, an
 * unchecked one leaves Done).
 *
 * When the list no longer holds that row at all (the filter moved on, or a
 * newer load replaced the rows) the view comes back untouched, by reference,
 * so a late response can never write over a fresher fetch.
 */
export function applyTodoCompletion<T extends Todo>(
  view: TodoListView<T>,
  updated: Todo,
  now: Date = new Date()
): TodoListView<T> {
  if (!view.rows.some((row) => row.id === updated.id)) return view;
  return {
    status: view.status,
    rows: view.rows
      .map((row) => (row.id === updated.id ? { ...row, ...updated } : row))
      .filter((row) => row.id !== updated.id || todoMatchesStatusFilter(row, view.status, now))
  };
}

/**
 * The `completed_at`/`completed_by` values a completion change must write:
 * checking off stamps both, unchecking clears both, so the pair always
 * describes the CURRENT state, never a stale one.
 */
export function todoCompletionStamps(
  completed: boolean,
  nowIso: string,
  completedBy: string | null
): { completed_at: string | null; completed_by: string | null } {
  return {
    completed_at: completed ? nowIso : null,
    completed_by: completed ? completedBy : null
  };
}

/**
 * The calendar year a date falls in AS SEEN FROM one timezone (undefined =
 * whatever zone the runtime is in). Always read through en-US so the value
 * is a plain Gregorian year, and only ever compared against another value
 * from this same function.
 */
function yearIn(date: Date, timeZone: string | undefined): string {
  return date.toLocaleString("en-US", { timeZone, year: "numeric" });
}

/**
 * One rendering rule for both surfaces: the date, and the year appended only
 * when the due date's year DIFFERS FROM the current year in the very zone
 * the rest of the string is rendered in. Deciding the year in a different
 * zone from the clock time is how a Dec 31 / Jan 1 due date ends up labelled
 * with the wrong year (or with the year silently dropped): 2027-01-01T02:00Z
 * is still Dec 31 2026 in Phoenix, so a Phoenix business must not see the
 * "2027" suffix on a date its own calendar calls this year.
 */
function renderTodoDueAt(
  due: Date,
  now: Date,
  locale: string | undefined,
  timeZone: string | undefined
): string {
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(yearIn(due, timeZone) === yearIn(now, timeZone) ? {} : { year: "numeric" }),
    timeZone
  };
  // ICU 72+ separates the time from AM/PM with a narrow no-break space
  // (U+202F). Normalized to a plain space: it reads the same, keeps string
  // assertions sane, and keeps the SMS inside the GSM-7 charset (one
  // exotic space would force UCS-2 and triple the message's size on the
  // wire).
  return due.toLocaleString(locale, options).replace(/[\u202f\u00a0]/g, " ");
}

/**
 * "Tue, Aug 25, 2:00 PM" for the assignment SMS, rendered in the business's
 * timezone (null timezone, or one the runtime cannot format, falls back to
 * UTC rather than crashing a render). Null in, null out. The year rule is
 * renderTodoDueAt's, so it is decided in the same timezone shown.
 */
export function formatTodoDueAt(
  dueAtIso: string | null,
  timeZone: string | null,
  now: Date = new Date()
): string | null {
  const due = dueAtIso === null ? null : new Date(dueAtIso);
  if (due === null || Number.isNaN(due.getTime())) return null;
  try {
    return renderTodoDueAt(due, now, "en-US", timeZone ?? "UTC");
  } catch {
    return renderTodoDueAt(due, now, "en-US", "UTC");
  }
}

/**
 * The same phrase for the dashboard list, in the VIEWER's own locale and
 * timezone instead of the business's. Shares renderTodoDueAt, so the year
 * suffix follows one rule everywhere: the dashboard and the SMS can no
 * longer disagree about whether a due date needs its year spelled out.
 */
export function formatTodoDueAtLocal(
  dueAtIso: string | null,
  now: Date = new Date()
): string | null {
  const due = dueAtIso === null ? null : new Date(dueAtIso);
  if (due === null || Number.isNaN(due.getTime())) return null;
  // undefined locale and timezone: the viewer's own, which is what a
  // dashboard row should show.
  return renderTodoDueAt(due, now, undefined, undefined);
}

/**
 * The one concise assignment SMS: the title, plus the due date when there
 * is one. English-only on purpose, same precedent as the booking-alert
 * employee texts: an employee SMS resolves no locale, so there is nothing
 * to render it in.
 */
export function buildTodoAssignmentSms(input: {
  title: string;
  /** Pre-rendered due phrase (formatTodoDueAt), null = no due date. */
  dueLabel: string | null;
}): string {
  const due = input.dueLabel ? ` Due ${input.dueLabel}.` : "";
  return `New Coworker: you were assigned a to-do: "${input.title}".${due}`;
}

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
 * "Tue, Aug 25, 2:00 PM" for list rows and the assignment SMS, rendered in
 * the business's timezone (null timezone, or one the runtime cannot format,
 * falls back to UTC rather than crashing a render). Null in, null out. The
 * year is appended only when it is not the current one.
 */
export function formatTodoDueAt(
  dueAtIso: string | null,
  timeZone: string | null,
  now: Date = new Date()
): string | null {
  if (dueAtIso === null) return null;
  const due = new Date(dueAtIso);
  if (Number.isNaN(due.getTime())) return null;
  const options: Intl.DateTimeFormatOptions = {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(due.getUTCFullYear() === now.getUTCFullYear() ? {} : { year: "numeric" })
  };
  // ICU 72+ separates the time from AM/PM with a narrow no-break space
  // (U+202F). Normalized to a plain space: it reads the same, keeps string
  // assertions sane, and keeps the SMS inside the GSM-7 charset (one
  // exotic space would force UCS-2 and triple the message's size on the
  // wire).
  const render = (tz: string) =>
    due.toLocaleString("en-US", { ...options, timeZone: tz }).replace(/[\u202f\u00a0]/g, " ");
  try {
    return render(timeZone ?? "UTC");
  } catch {
    return render("UTC");
  }
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

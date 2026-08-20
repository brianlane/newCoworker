/**
 * Assignment notification: tell the roster member a to-do just landed on.
 *
 * The audience is a specific ai_flow_team_members row, and on Standard-tier
 * accounts that person may have NO dashboard login at all, so the reach that
 * always works is a text to their roster phone. That is the established
 * employee leg of the notifications machinery (the booking alert's
 * textEmployees in src/lib/calendar-tools/unassigned-booking-alert.ts sends
 * the same way): getTelnyxMessagingForBusiness + sendTelnyxSms with the
 * business metered, English-only copy (an employee SMS resolves no locale).
 * The owner-facing dispatcher (src/lib/notifications/dispatch.ts) is NOT
 * used here on purpose: it addresses the business owner and can only
 * redirect by contact ownership, never to an arbitrary teammate.
 *
 * Best-effort BY CONTRACT: the to-do row is already written, so this never
 * throws; every failure is a warn log and an honest outcome string.
 */
import { getTeamMember } from "@/lib/db/employees";
import { getBusinessTimezone } from "@/lib/db/businesses";
import { getTelnyxMessagingForBusiness, sendTelnyxSms } from "@/lib/telnyx/messaging";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";
import { buildTodoAssignmentSms, formatTodoDueAt, type Todo } from "./core";

/**
 * Whether a create/patch outcome is an ASSIGNMENT worth a text: someone now
 * holds the to-do who did not hold it before. Unassigning (next null) and
 * saves that keep the same assignee stay silent.
 */
export function isNewAssignment(
  previousAssigneeEmployeeId: string | null,
  nextAssigneeEmployeeId: string | null
): boolean {
  return (
    nextAssigneeEmployeeId !== null &&
    nextAssigneeEmployeeId !== previousAssigneeEmployeeId
  );
}

export type TodoAssignmentNotifyOutcome =
  | "sent"
  | "skipped_unassigned"
  | "skipped_member_missing"
  | "skipped_member_inactive"
  | "failed";

export type TodoAssignmentNotifyDeps = {
  /** Injectable service client (tests). */
  client?: Awaited<ReturnType<typeof createSupabaseServiceClient>>;
  /** Injectable roster read (tests). */
  getMember?: typeof getTeamMember;
  /** Injectable timezone read (tests). */
  getTimezone?: typeof getBusinessTimezone;
  /** Injectable SMS leg (tests). */
  sendSms?: (businessId: string, toE164: string, body: string) => Promise<void>;
};

/**
 * Text the assignee about `todo`. One concise message: the title, plus the
 * due date (rendered in the business timezone) when there is one.
 */
export async function notifyTodoAssignment(
  businessId: string,
  todo: Todo,
  deps: TodoAssignmentNotifyDeps = {}
): Promise<TodoAssignmentNotifyOutcome> {
  if (!todo.assigneeEmployeeId) return "skipped_unassigned";
  try {
    const db = deps.client ?? (await createSupabaseServiceClient());
    const getMember = deps.getMember ?? getTeamMember;
    const getTimezone = deps.getTimezone ?? getBusinessTimezone;

    const member = await getMember(businessId, todo.assigneeEmployeeId, db);
    if (!member || !member.phone_e164) {
      logger.warn("todo assignment notify: assignee has no roster phone", {
        businessId,
        todoId: todo.id,
        assigneeEmployeeId: todo.assigneeEmployeeId
      });
      return "skipped_member_missing";
    }
    // A deactivated member has left the team's working set; texting them
    // about new work would be worse than staying quiet. The row still holds
    // the assignment, and the list shows it, so nothing is hidden.
    if (!member.active) {
      logger.warn("todo assignment notify: assignee is inactive, not texting", {
        businessId,
        todoId: todo.id,
        assigneeEmployeeId: todo.assigneeEmployeeId
      });
      return "skipped_member_inactive";
    }

    // Timezone read degrades to null (UTC) inside the helper, never throws.
    const timezone = await getTimezone(businessId, db);
    const body = buildTodoAssignmentSms({
      title: todo.title,
      dueLabel: formatTodoDueAt(todo.dueAt, timezone)
    });

    const send =
      deps.sendSms ??
      (async (bid: string, to: string, text: string) => {
        const config = await getTelnyxMessagingForBusiness(bid, db);
        await sendTelnyxSms(config, to, text, { meterBusinessId: bid });
      });
    await send(businessId, member.phone_e164, body);
    return "sent";
  } catch (err) {
    logger.warn("todo assignment notify failed (to-do unaffected)", {
      businessId,
      todoId: todo.id,
      error: err instanceof Error ? err.message : String(err)
    });
    return "failed";
  }
}

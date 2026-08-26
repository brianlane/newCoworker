/**
 * The action-tool gate map for an owner-capable surface, written once.
 *
 * owner-sms-turn and slack/worker each carried their own copy of this, ~40
 * lines apiece. They agreed, but only because someone kept them in step by
 * hand. The two copies differ in exactly one way: Slack applies `isOwner &&`
 * to the owner-power tools because a teammate can be in the workspace,
 * while the SMS route omits it because that route is owner-only by
 * construction. Those are the same rule with the flag pinned true, so one
 * function serves both, and the next surface cannot quietly disagree with
 * either.
 *
 * The line this file draws, in words: a staff speaker may READ the business
 * and ACT within it (text a customer, book, run an automation, fill in a
 * table). Only the verified OWNER may RECONFIGURE it (edit an automation,
 * change notification settings, silence a contact, change the roster,
 * create or destroy a table).
 */

/** Settings-level toggles this map is derived from. */
export type OwnerSurfaceToolStates = {
  send_sms: boolean;
  send_whatsapp: boolean;
  calendar_find_slots: boolean;
  calendar_book_appointment: boolean;
  calendar_reschedule_appointment: boolean;
  calendar_cancel_appointment: boolean;
  calendar_join_waitlist: boolean;
  run_aiflow: boolean;
  edit_aiflow: boolean;
  update_notification_preferences: boolean;
  flag_contact_spam: boolean;
  set_contact_reply_mode: boolean;
  manage_employee: boolean;
  custom_table_read: boolean;
  custom_table_write: boolean;
  custom_table_manage: boolean;
};

export type OwnerSurfaceGateArgs = {
  toolStates: OwnerSurfaceToolStates;
  /** True only for a speaker the platform verified as the OWNER. */
  isOwner: boolean;
  /** Whether the tenant's WhatsApp Business connection is live right now. */
  whatsappConnected: boolean;
};

/**
 * Every key this map declares. Exported so a test can refuse drift: a key
 * added here that the engine does not know is dead config, and a key lost
 * silently disables a working tool.
 */
export const OWNER_SURFACE_TOOL_KEYS = [
  "send_sms",
  "send_whatsapp",
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist",
  "list_aiflows",
  "run_aiflow",
  "edit_aiflow",
  "undo_aiflow_edit",
  "generate_image",
  "update_notification_preferences",
  "flag_contact_spam",
  "set_contact_reply_mode",
  "manage_employee",
  "custom_table_list",
  "custom_table_find_rows",
  "custom_table_history",
  "custom_table_add_row",
  "custom_table_update_row",
  "custom_table_delete_row",
  "custom_table_undo",
  "custom_table_create",
  "custom_table_update_schema",
  "custom_table_delete",
  "custom_table_restore"
] as const;

export type OwnerSurfaceToolKey = (typeof OWNER_SURFACE_TOOL_KEYS)[number];

export function ownerSurfaceToolGates(
  args: OwnerSurfaceGateArgs
): Record<OwnerSurfaceToolKey, boolean> {
  const { toolStates: t, isOwner } = args;
  /** Owner-power: the settings toggle AND a verified owner. */
  const owned = (enabled: boolean): boolean => isOwner && enabled;
  return {
    send_sms: t.send_sms,
    // Connection-aware, like dashboard chat: never declare a tool that can
    // only fail.
    send_whatsapp: t.send_whatsapp && args.whatsappConnected,
    calendar_find_slots: t.calendar_find_slots,
    calendar_book_appointment: t.calendar_book_appointment,
    calendar_reschedule_appointment: t.calendar_reschedule_appointment,
    calendar_cancel_appointment: t.calendar_cancel_appointment,
    calendar_join_waitlist: t.calendar_join_waitlist,
    // Listing and running are one capability from the owner's point of
    // view: a coworker that can run an automation has to be able to say
    // which ones exist.
    list_aiflows: t.run_aiflow,
    run_aiflow: t.run_aiflow,
    edit_aiflow: owned(t.edit_aiflow),
    // Same toggle on purpose: a surface that can rewrite a live automation
    // must be able to take that rewrite back from the same surface.
    undo_aiflow_edit: owned(t.edit_aiflow),
    // Off on every messaging surface. The image tool answers with an
    // /api/dashboard/images URL plus markdown, and there is nowhere to
    // render that in a text message.
    generate_image: false,
    update_notification_preferences: owned(t.update_notification_preferences),
    flag_contact_spam: owned(t.flag_contact_spam),
    set_contact_reply_mode: owned(t.set_contact_reply_mode),
    manage_employee: owned(t.manage_employee),
    // Reading and filling in a table is open to staff; BUILDING or
    // destroying one is the owner's alone. Same line the surfaces already
    // draw in words.
    custom_table_list: t.custom_table_read,
    custom_table_find_rows: t.custom_table_read,
    custom_table_history: t.custom_table_read,
    custom_table_add_row: t.custom_table_write,
    custom_table_update_row: t.custom_table_write,
    custom_table_delete_row: t.custom_table_write,
    custom_table_undo: t.custom_table_write,
    custom_table_create: owned(t.custom_table_manage),
    custom_table_update_schema: owned(t.custom_table_manage),
    custom_table_delete: owned(t.custom_table_manage),
    custom_table_restore: owned(t.custom_table_manage)
  };
}

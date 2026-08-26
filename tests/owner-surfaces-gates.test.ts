import { describe, expect, it } from "vitest";
import {
  OWNER_SURFACE_TOOL_KEYS,
  ownerSurfaceToolGates,
  type OwnerSurfaceToolStates
} from "@/lib/owner-surfaces/gates";

/**
 * The action-tool gate map, written once instead of twice.
 *
 * owner-sms-turn and slack/worker each carried their own ~40 line copy of
 * this. They agreed, but only because someone kept them in step by hand:
 * the Slack copy applies `isOwner &&` to the owner-power tools, and the SMS
 * copy omits it because that route is owner-only by construction. Those are
 * the same rule with the flag pinned true, so one function serves both, and
 * a third surface cannot quietly disagree with either.
 */

const ALL_ON: OwnerSurfaceToolStates = {
  send_sms: true,
  send_whatsapp: true,
  calendar_find_slots: true,
  calendar_book_appointment: true,
  calendar_reschedule_appointment: true,
  calendar_cancel_appointment: true,
  calendar_join_waitlist: true,
  run_aiflow: true,
  edit_aiflow: true,
  update_notification_preferences: true,
  flag_contact_spam: true,
  set_contact_reply_mode: true,
  manage_employee: true,
  custom_table_read: true,
  custom_table_write: true,
  custom_table_manage: true
};

/** Tools only the verified OWNER may reach, whatever the settings say. */
const OWNER_ONLY = [
  "edit_aiflow",
  "undo_aiflow_edit",
  "update_notification_preferences",
  "flag_contact_spam",
  "set_contact_reply_mode",
  "manage_employee",
  "custom_table_create",
  "custom_table_update_schema",
  "custom_table_delete",
  "custom_table_restore"
] as const;

/** Tools any staff speaker may reach: read the business, act, fill a table. */
const STAFF_SHARED = [
  "send_sms",
  "calendar_find_slots",
  "calendar_book_appointment",
  "calendar_reschedule_appointment",
  "calendar_cancel_appointment",
  "calendar_join_waitlist",
  "list_aiflows",
  "run_aiflow",
  "custom_table_list",
  "custom_table_find_rows",
  "custom_table_history",
  "custom_table_add_row",
  "custom_table_update_row",
  "custom_table_delete_row",
  "custom_table_undo"
] as const;

describe("ownerSurfaceToolGates", () => {
  it("declares exactly the tool keys the surfaces expect, no more", () => {
    // Drift guard. A gate map that grows a key the engine does not know is
    // dead config; one that loses a key silently disables a tool.
    const gates = ownerSurfaceToolGates({
      toolStates: ALL_ON,
      isOwner: true,
      whatsappConnected: true
    });
    expect(Object.keys(gates).sort()).toEqual([...OWNER_SURFACE_TOOL_KEYS].sort());
  });

  it("gives a verified owner everything their settings allow", () => {
    const gates = ownerSurfaceToolGates({
      toolStates: ALL_ON,
      isOwner: true,
      whatsappConnected: true
    });
    for (const key of [...OWNER_ONLY, ...STAFF_SHARED]) {
      expect(gates[key], key).toBe(true);
    }
    expect(gates.send_whatsapp).toBe(true);
  });

  it("lets a teammate read and act, never reconfigure", () => {
    const gates = ownerSurfaceToolGates({
      toolStates: ALL_ON,
      isOwner: false,
      whatsappConnected: true
    });
    for (const key of OWNER_ONLY) {
      expect(gates[key], key).toBe(false);
    }
    for (const key of STAFF_SHARED) {
      expect(gates[key], key).toBe(true);
    }
  });

  it("respects an owner's OFF toggle even for the owner themselves", () => {
    const gates = ownerSurfaceToolGates({
      toolStates: { ...ALL_ON, edit_aiflow: false, send_sms: false },
      isOwner: true,
      whatsappConnected: true
    });
    expect(gates.edit_aiflow).toBe(false);
    expect(gates.undo_aiflow_edit).toBe(false);
    expect(gates.send_sms).toBe(false);
  });

  it("ties undo_aiflow_edit to the same toggle as edit_aiflow", () => {
    // The surface that can rewrite a live automation must be able to take
    // that rewrite back on the same surface.
    for (const enabled of [true, false]) {
      const gates = ownerSurfaceToolGates({
        toolStates: { ...ALL_ON, edit_aiflow: enabled },
        isOwner: true,
        whatsappConnected: true
      });
      expect(gates.undo_aiflow_edit).toBe(gates.edit_aiflow);
    }
  });

  it("never declares send_whatsapp when the connection is not live", () => {
    // Same rule dashboard chat already applies: never declare a tool that
    // can only fail.
    const gates = ownerSurfaceToolGates({
      toolStates: ALL_ON,
      isOwner: true,
      whatsappConnected: false
    });
    expect(gates.send_whatsapp).toBe(false);
  });

  it("keeps list_aiflows and run_aiflow on the one toggle", () => {
    const gates = ownerSurfaceToolGates({
      toolStates: { ...ALL_ON, run_aiflow: false },
      isOwner: true,
      whatsappConnected: true
    });
    expect(gates.list_aiflows).toBe(false);
    expect(gates.run_aiflow).toBe(false);
  });

  it("keeps generate_image off on every messaging surface", () => {
    // The dashboard image tool answers with an /api/dashboard/images URL
    // and markdown. There is nowhere to render that in a text message.
    const gates = ownerSurfaceToolGates({
      toolStates: ALL_ON,
      isOwner: true,
      whatsappConnected: true
    });
    expect(gates.generate_image).toBe(false);
  });

  it("splits table access the way the surfaces already word it", () => {
    // Reading and filling a table is open to staff; building or deleting
    // one is the owner's alone.
    const readOnly = ownerSurfaceToolGates({
      toolStates: { ...ALL_ON, custom_table_write: false, custom_table_manage: false },
      isOwner: true,
      whatsappConnected: true
    });
    expect(readOnly.custom_table_find_rows).toBe(true);
    expect(readOnly.custom_table_add_row).toBe(false);
    expect(readOnly.custom_table_create).toBe(false);
  });
});

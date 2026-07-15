/**
 * Contact write tools: create/update contacts, including the lead-state
 * surface (tags + owning roster member) that drives the Task Center and
 * pipeline boards.
 *
 * Mirrors the dashboard customers routes: creates fire `contact_created`
 * triggers, tag edits diff against the stored row and fire `tag_changed`
 * (+ goal fast-forward) events, and a new owner assignment fires
 * `owner_assigned` — so automations react identically whether the edit
 * came from the dashboard or from Claude.
 */

import { z } from "zod";
import {
  McpToolError,
  requireMcpBusinessRole,
  resolveMcpBusinessId
} from "@/lib/mcp/auth";
import { defineMcpTool } from "@/lib/mcp/tooling";
import { normalizePhoneArg } from "@/lib/mcp/tools/read";
import { CONTACT_TYPES, normalizeContactTags } from "@/lib/customer-memory/types";

const businessIdField = z
  .string()
  .uuid()
  .optional()
  .describe("Business the contact belongs to. Optional when the account has exactly one business.");

export const createContactTool = defineMcpTool({
  name: "create_contact",
  description:
    "Add a new contact to the business's CRM. Fires the business's contact_created automations, same as adding from the dashboard.",
  schema: {
    business_id: businessIdField,
    phone: z.string().describe("The contact's phone number (any common format)."),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    notes: z.string().trim().max(4000).optional().describe("Pinned notes on the profile."),
    type: z.enum(CONTACT_TYPES).optional().describe("Contact classification; defaults to customer.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const phone = normalizePhoneArg(args.phone);

    const { createCustomerMemory, CustomerExistsError } = await import(
      "@/lib/customer-memory/db"
    );
    let row;
    try {
      row = await createCustomerMemory(businessId, {
        customerE164: phone,
        displayName: args.name ?? null,
        email: args.email ?? null,
        pinnedMd: args.notes ?? null,
        ...(args.type ? { type: args.type } : {})
      });
    } catch (err) {
      if (err instanceof CustomerExistsError) {
        throw new McpToolError(`A contact already exists for ${phone} — use update_contact.`);
      }
      throw err;
    }

    // contact_created triggers: best-effort inside fireContactEvent (it never
    // throws); a trigger failure never fails the add. Same as the dashboard.
    const { fireContactEvent } = await import("@/lib/ai-flows/contact-event-hooks");
    await fireContactEvent(businessId, {
      kind: "contact_created",
      contact: {
        e164: row.customer_e164,
        ...(row.display_name ? { name: row.display_name } : {}),
        ...(row.email ? { email: row.email } : {})
      },
      dedupeKey: `ce:created:${row.customer_e164}:${Date.now()}`
    });

    return {
      created: true,
      phone: row.customer_e164,
      name: row.display_name,
      email: row.email,
      type: row.type
    };
  }
});

export const updateContactTool = defineMcpTool({
  name: "update_contact",
  description:
    "Update an existing contact: name, email, pinned notes, classification, lead-state tags (pipeline stages are tags), owning team member, or birthday. Tag and owner changes fire the same automations as dashboard edits.",
  schema: {
    business_id: businessIdField,
    phone: z.string().describe("The contact's phone number (any common format)."),
    name: z.string().trim().min(1).max(120).optional(),
    email: z.string().trim().email().max(254).optional(),
    notes: z.string().trim().max(4000).optional().describe("Replaces the pinned notes."),
    type: z.enum(CONTACT_TYPES).optional(),
    tags: z
      .array(z.string().trim().min(1).max(40))
      .max(25)
      .optional()
      .describe("REPLACES the full tag set (fetch current tags with get_contact first)."),
    owner_employee_id: z
      .string()
      .uuid()
      .nullable()
      .optional()
      .describe("Roster member who owns this lead; null releases to unowned."),
    birthday: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .nullable()
      .optional()
      .describe("YYYY-MM-DD; null clears.")
  },
  handler: async (args, auth) => {
    const businessId = await resolveMcpBusinessId(auth, args.business_id);
    await requireMcpBusinessRole(auth, businessId, "operate_messages");
    const phone = normalizePhoneArg(args.phone);

    const { getCustomerMemory, updateCustomerOwnerFields } = await import(
      "@/lib/customer-memory/db"
    );
    const existing = await getCustomerMemory(businessId, phone);
    if (!existing) {
      throw new McpToolError(`No contact found for ${phone} — use create_contact.`);
    }

    // An assigned owner must be one of THIS business's roster members —
    // the FK alone is cross-tenant, so without this check a member id from
    // another business could be attached (same guard as the dashboard PATCH).
    let assignedOwnerName = "";
    if (args.owner_employee_id) {
      const { getTeamMember } = await import("@/lib/db/employees");
      const member = await getTeamMember(businessId, args.owner_employee_id);
      if (!member) {
        throw new McpToolError("That employee is not on this business's roster.");
      }
      assignedOwnerName = member.name;
    }

    await updateCustomerOwnerFields(businessId, existing.customer_e164, {
      ...(args.name !== undefined ? { displayName: args.name, nameSource: "manual" } : {}),
      ...(args.email !== undefined ? { email: args.email } : {}),
      ...(args.notes !== undefined ? { pinnedMd: args.notes } : {}),
      ...(args.type !== undefined ? { type: args.type } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      ...(args.owner_employee_id !== undefined
        ? { ownerEmployeeId: args.owner_employee_id }
        : {}),
      ...(args.birthday !== undefined ? { birthday: args.birthday } : {})
    });

    // Tag diff → goal fast-forward + tag_changed triggers, mirroring the
    // dashboard customer PATCH (both hooks are best-effort internally).
    if (args.tags !== undefined) {
      const { fireGoalEvent } = await import("@/lib/ai-flows/goal-hooks");
      const { fireContactEvent } = await import("@/lib/ai-flows/contact-event-hooks");
      const nextTags = normalizeContactTags(args.tags);
      const previousTags = normalizeContactTags(existing.tags ?? []);
      const before = new Set(previousTags.map((t) => t.toLowerCase()));
      const after = new Set(nextTags.map((t) => t.toLowerCase()));
      const eventStamp = Date.now();
      // Runs match goal events by the exact number they were triggered
      // with, which after a profile merge may be an ALIAS — fire for every
      // linked number so a parked run keyed on the old number still jumps.
      const goalNumbers = [existing.customer_e164, ...(existing.alias_e164s ?? [])];
      for (const tag of nextTags) {
        if (before.has(tag.toLowerCase())) continue;
        for (const number of goalNumbers) {
          await fireGoalEvent(businessId, number, { kind: "tag_added", tag });
        }
        await fireContactEvent(businessId, {
          kind: "tag_changed",
          contact: { e164: existing.customer_e164, tags: nextTags },
          tag,
          change: "added",
          dedupeKey: `ce:tag:${existing.customer_e164}:${tag.toLowerCase()}:added:${eventStamp}`
        });
      }
      for (const tag of previousTags) {
        if (after.has(tag.toLowerCase())) continue;
        await fireContactEvent(businessId, {
          kind: "tag_changed",
          contact: { e164: existing.customer_e164, tags: nextTags },
          tag,
          change: "removed",
          dedupeKey: `ce:tag:${existing.customer_e164}:${tag.toLowerCase()}:removed:${eventStamp}`
        });
      }
    }

    // owner_assigned triggers on a real change to a new (non-null) owner.
    // `assignedOwnerName` comes from the roster row validated before the write.
    if (
      args.owner_employee_id !== undefined &&
      args.owner_employee_id !== null &&
      args.owner_employee_id !== existing.owner_employee_id
    ) {
      const { fireContactEvent } = await import("@/lib/ai-flows/contact-event-hooks");
      await fireContactEvent(businessId, {
        kind: "owner_assigned",
        contact: { e164: existing.customer_e164 },
        ...(assignedOwnerName ? { ownerName: assignedOwnerName } : {}),
        dedupeKey: `ce:owner:${existing.customer_e164}:${args.owner_employee_id}:${Date.now()}`
      });
    }

    return { updated: true, phone: existing.customer_e164 };
  }
});

export const contactTools = [createContactTool, updateContactTool];

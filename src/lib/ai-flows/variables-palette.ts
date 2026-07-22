/**
 * "Variables you can use" palette for the AiFlows builder step editor.
 *
 * Pure scope math (kept out of the component for the coverage gate): given
 * the flow's steps, the selected step, and the trigger channel(s), compute
 * the placeholders the owner may template into that step — trigger fields
 * for the channel, vars produced by EARLIER steps (the engine's
 * earlier-steps-only rule), and the always-available engine scope. Entries
 * whose identifier looks like a person's name also carry `.first`/`.last`
 * variants (see engine.resolvePlaceholder), which is how owners discover
 * the name-part feature.
 */

import type { FlowStep } from "@/lib/ai-flows/schema";
import { varsInScopeBefore } from "@/lib/ai-flows/tree";

export type VariablePaletteEntry = {
  /** The ready-to-paste placeholder, e.g. "{{vars.lead_name}}". */
  placeholder: string;
  /** Short owner-facing hint (English inline copy, like the builder's own). */
  hint?: string;
  /** Present when the value looks like a person's name: the part variants. */
  nameParts?: { first: string; last: string };
};

export type VariablePaletteGroups = {
  /** Fields the trigger fills, per the flow's channel(s). */
  trigger: VariablePaletteEntry[];
  /** {{vars.x}} produced by steps BEFORE the selected one. */
  earlier: VariablePaletteEntry[];
  /** Engine-provided scope that is always available. */
  always: VariablePaletteEntry[];
};

/**
 * A person-name heuristic for offering `.first`/`.last` variants: the
 * identifier mentions "name" and is not an obviously non-person name
 * (document/file/event/business labels).
 */
export function isNameLikeVar(identifier: string): boolean {
  if (!/name/i.test(identifier)) return false;
  return !/(document|file|event|business|company)/i.test(identifier);
}

function entry(placeholder: string, hint?: string, identifier?: string): VariablePaletteEntry {
  const id = identifier ?? placeholder;
  const base = placeholder.replace(/\}\}$/, "");
  return {
    placeholder,
    ...(hint ? { hint } : {}),
    ...(isNameLikeVar(id)
      ? { nameParts: { first: `${base}.first}}`, last: `${base}.last}}` } }
      : {})
  };
}

/** The message-carrying channels where from/windowText/url are filled. */
const MESSAGE_CHANNELS = new Set([
  "sms",
  "email",
  "tenant_email",
  "webhook",
  "manual",
  "calendar",
  "birthday"
]);

/** Channel-specific trigger fields, beyond the common trio. */
function channelFields(channel: string): VariablePaletteEntry[] {
  switch (channel) {
    case "sms":
      return [
        entry("{{trigger.image}}", "photo attached to the text (MMS), if any")
      ];
    case "tenant_email":
      return [
        entry("{{trigger.document}}", "document attached to the email, if any"),
        entry("{{trigger.document_name}}", "that document's filename", "document_name"),
        entry("{{trigger.image}}", "image attached to the email, if any")
      ];
    case "calendar":
      return [
        entry("{{trigger.event_title}}", "the calendar event's title", "event_title"),
        entry("{{trigger.starts_at}}", "when the event starts"),
        entry("{{trigger.ends_at}}", "when the event ends")
      ];
    case "contact_created":
      return [
        entry("{{trigger.contact_name}}", "the new contact's name", "contact_name"),
        entry("{{trigger.contact_email}}", "the new contact's email")
      ];
    case "tag_changed":
      return [
        entry("{{trigger.contact_name}}", "the contact's name", "contact_name"),
        entry("{{trigger.contact_email}}", "the contact's email"),
        entry("{{trigger.tag}}", "the tag that changed")
      ];
    case "owner_assigned":
      return [
        entry("{{trigger.contact_name}}", "the contact's name", "contact_name"),
        entry("{{trigger.contact_email}}", "the contact's email"),
        entry("{{trigger.owner_name}}", "the assigned team member", "owner_name")
      ];
    case "birthday":
      return [
        entry("{{trigger.contact_name}}", "the birthday contact's name", "contact_name")
      ];
    default:
      return [];
  }
}

/**
 * Compute the palette for the step with `stepId`, given every trigger
 * channel the flow can start from (primary + extras). Voice flows carry no
 * templates, so callers skip the palette for them.
 */
export function variablesPaletteGroups(args: {
  steps: FlowStep[];
  stepId: string;
  channels: string[];
}): VariablePaletteGroups {
  const trigger: VariablePaletteEntry[] = [];
  const seen = new Set<string>();
  const push = (list: VariablePaletteEntry[], e: VariablePaletteEntry) => {
    if (seen.has(e.placeholder)) return;
    seen.add(e.placeholder);
    list.push(e);
  };

  if (args.channels.some((c) => MESSAGE_CHANNELS.has(c))) {
    push(trigger, entry("{{trigger.from}}", "who set it off — their phone or email"));
    push(trigger, entry("{{trigger.windowText}}", "the full trigger message text"));
    push(trigger, entry("{{trigger.url}}", "first link in the message, if any"));
  }
  for (const channel of args.channels) {
    for (const e of channelFields(channel)) push(trigger, e);
  }

  const earlier = varsInScopeBefore(args.steps, args.stepId).map((name) =>
    entry(`{{vars.${name}}}`, undefined, name)
  );

  // Engine scope that is always filled. The other ENGINE_PROVIDED_VARS
  // (claimed_agent*, group_lead_phone) only fill after specific steps or
  // trigger shapes — the condition pickers keep offering them, but the
  // palette sticks to what is reliably usable in any template.
  const always = [
    entry("{{vars.actions_taken}}", "running summary of what this run did so far", "actions_taken"),
    entry("{{coworker.email}}", "your AI coworker's own email address"),
    entry("{{now.today.iso}}", "today's date (also .weekday, .month, .day)"),
    entry("{{now.tomorrow.iso}}", "tomorrow's date (also .weekday, .month, .day)")
  ];

  return { trigger, earlier, always };
}

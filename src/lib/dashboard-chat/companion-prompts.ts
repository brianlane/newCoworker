/**
 * Route-aware suggested prompts for the Ask AI companion panel.
 *
 * Static by design: the suggestions are i18n KEYS (rendered from
 * `dashboard.companion.prompts.*` in the client), so both catalogs stay in
 * lockstep under the parity test and nothing here needs a model call. The
 * wording of each prompt is grounded in the asks owners actually type
 * (James's "look at david's text messages", "are we sending texts to the
 * vfm folks?", Amy's "has anyone reached out?"), scoped to the page the
 * owner is looking at.
 */

export type CompanionPromptGroup =
  | "default"
  | "home"
  | "calls"
  | "messages"
  | "contacts"
  | "aiflows"
  | "bookings"
  | "employees";

/** Longest-prefix wins, so /dashboard/calls/123 lands on the calls group. */
const PATH_GROUPS: Array<[prefix: string, group: CompanionPromptGroup]> = [
  ["/dashboard/calls", "calls"],
  ["/dashboard/texts", "messages"],
  ["/dashboard/messages", "messages"],
  ["/dashboard/webchat", "messages"],
  ["/dashboard/contacts", "contacts"],
  ["/dashboard/customers", "contacts"],
  ["/dashboard/aiflows", "aiflows"],
  ["/dashboard/agents", "aiflows"],
  ["/dashboard/bookings", "bookings"],
  ["/dashboard/employees", "employees"]
];

export function companionPromptGroupForPath(pathname: string): CompanionPromptGroup {
  const path = pathname.split("?")[0];
  for (const [prefix, group] of PATH_GROUPS) {
    if (path === prefix || path.startsWith(`${prefix}/`)) return group;
  }
  if (path === "/dashboard" || path === "/dashboard/") return "home";
  return "default";
}

/**
 * The i18n keys (relative to `dashboard.companion`) for one group, in
 * display order. Three per group keeps the empty state scannable.
 */
export function companionPromptKeys(group: CompanionPromptGroup): string[] {
  return [1, 2, 3].map((n) => `prompts.${group}${n}`);
}

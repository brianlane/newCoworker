/**
 * Central permission matrix for business-scoped actions (Pundit-style,
 * modeled on the bizblasts policy layer).
 *
 * Roles ladder (highest first): owner > manager > staff.
 *
 *  - owner   — the business's `owner_email` login. Everything, including the
 *              money surfaces (billing, cancel, API keys).
 *  - manager — runs the business day to day: settings, AiFlows,
 *              integrations, messages, and the team roster. NOT billing.
 *  - staff   — operates: sees the dashboard, works messages/calls/chat.
 *
 * Every business-scoped route asks `requireBusinessRole(businessId, action)`
 * (src/lib/auth.ts) instead of sprinkling its own role/ownership checks;
 * this module is the single source of truth for which role an action needs.
 */

export const BUSINESS_ROLES = ["owner", "manager", "staff"] as const;
export type BusinessRole = (typeof BUSINESS_ROLES)[number];

/** Higher = more privileged. */
const ROLE_RANK: Record<BusinessRole, number> = {
  owner: 3,
  manager: 2,
  staff: 1
};

export const BUSINESS_ACTIONS = [
  /** See the dashboard, activity, analytics, notifications. */
  "view_dashboard",
  /** Work the inboxes: messages, calls, owner chat. */
  "operate_messages",
  /** Business settings: agent config, mailbox, phone, integrations, employees. */
  "manage_settings",
  /** Create/edit/run AiFlows. */
  "manage_aiflows",
  /** Invite/revoke team members, change roles. */
  "manage_team",
  /** Billing, plan changes, cancel/refund, public API keys. */
  "manage_billing"
] as const;
export type BusinessAction = (typeof BUSINESS_ACTIONS)[number];

const ACTION_MIN_ROLE: Record<BusinessAction, BusinessRole> = {
  view_dashboard: "staff",
  operate_messages: "staff",
  manage_settings: "manager",
  manage_aiflows: "manager",
  manage_team: "manager",
  manage_billing: "owner"
};

export function roleAtLeast(role: BusinessRole, min: BusinessRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[min];
}

/** Whether `role` is allowed to perform `action`. */
export function can(role: BusinessRole, action: BusinessAction): boolean {
  return roleAtLeast(role, ACTION_MIN_ROLE[action]);
}

/** Runtime narrowing for raw DB role values. */
export function isBusinessRole(value: unknown): value is BusinessRole {
  return value === "owner" || value === "manager" || value === "staff";
}

/** Roles a member row may carry (owner is implicit via businesses.owner_email). */
export const MEMBER_ROLES = ["manager", "staff"] as const;
export type MemberRole = (typeof MEMBER_ROLES)[number];

export function isMemberRole(value: unknown): value is MemberRole {
  return value === "manager" || value === "staff";
}

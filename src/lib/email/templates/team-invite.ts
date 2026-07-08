/**
 * Transactional email: team-access invitation to a business's dashboard.
 *
 * Sent by POST /api/dashboard/team when the invitee ALREADY has a NewCoworker
 * login (Supabase's auth.admin.inviteUserByEmail only covers brand-new
 * users — it errors on existing ones, and those people just need to know
 * access was granted).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { MemberRole } from "@/lib/authz/policy";

export type TeamInviteEmailInput = {
  businessName: string;
  role: MemberRole;
  invitedBy: string;
  recipientEmail: string;
  /** App origin without trailing slash. */
  siteUrl: string;
};

export function buildTeamInviteEmail(input: TeamInviteEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `You've been added to ${input.businessName} on NewCoworker`;
  const roleLine =
    input.role === "manager"
      ? "As a manager you can run settings, AiFlows, integrations, and the team roster."
      : "As staff you can work the dashboard: messages, calls, and chat.";
  const loginUrl = `${input.siteUrl.replace(/\/$/, "")}/login`;
  const textLines = [
    `${input.invitedBy} added you to ${input.businessName}'s AI coworker dashboard as ${input.role}.`,
    roleLine,
    `Sign in with this email address to get started: ${loginUrl}`,
    "Questions? Just reply to this email.",
    "— The NewCoworker Team"
  ];
  const text = textLines.join("\n\n");
  const html = buildBrandedEmailHtml({
    siteUrl: input.siteUrl.replace(/\/$/, ""),
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: "Open the dashboard", href: loginUrl },
    recipientEmail: input.recipientEmail
  });
  return { subject, text, html };
}

/**
 * Transactional email: team-access invitation to a business's dashboard.
 *
 * Sent by POST /api/dashboard/team when the invitee ALREADY has a NewCoworker
 * login (Supabase's auth.admin.inviteUserByEmail only covers brand-new
 * users, it errors on existing ones, and those people just need to know
 * access was granted).
 */

import { buildBrandedEmailHtml } from "@/lib/email/branded-html";
import type { MemberRole } from "@/lib/authz/policy";
import type { AppLocale } from "@/i18n/routing";
import { defaultLocale } from "@/i18n/routing";
import { emailMessagesForLocale, fmtEmail } from "@/lib/i18n/email-copy";

export type TeamInviteEmailInput = {
  businessName: string;
  role: MemberRole;
  invitedBy: string;
  recipientEmail: string;
  /** App origin without trailing slash. */
  siteUrl: string;
  /** Recipient's UI locale; defaults to English. */
  locale?: AppLocale;
};

export function buildTeamInviteEmail(input: TeamInviteEmailInput): {
  subject: string;
  text: string;
  html: string;
} {
  const copy = emailMessagesForLocale(input.locale ?? defaultLocale);
  const c = copy.teamInvite;
  const subject = fmtEmail(c.subject, { businessName: input.businessName });
  const roleLine = input.role === "manager" ? c.roleManager : c.roleStaff;
  const loginUrl = `${input.siteUrl.replace(/\/$/, "")}/login`;
  const textLines = [
    fmtEmail(c.added, {
      invitedBy: input.invitedBy,
      businessName: input.businessName,
      role: input.role
    }),
    roleLine,
    fmtEmail(c.signIn, { loginUrl }),
    copy.questionsReply
  ];
  // Signoff rides only the plain-text body, the HTML shell renders the full
  // platform signature block, so repeating it there would double the contact info.
  const text = [...textLines, copy.ncSignoff].join("\n\n");
  const html = buildBrandedEmailHtml({
    siteUrl: input.siteUrl.replace(/\/$/, ""),
    documentTitle: subject,
    heading: subject,
    bodyBlocks: textLines.map((t) => ({ kind: "text" as const, text: t })),
    cta: { label: c.cta, href: loginUrl },
    recipientEmail: input.recipientEmail
  });
  return { subject, text, html };
}

/**
 * "Send from" options for the dashboard Emails composer.
 *
 * Mirrors the AiFlow send_email "From" picker (FromMailboxSelect): the business
 * can send AS its own AI coworker mailbox (id "") or AS one of the owner's
 * connected Gmail/Outlook mailboxes (id = workspace_oauth_connections.id). The
 * coworker option is always first and always available; connected mailboxes are
 * listed in connection order.
 *
 * Server-only: pulls the service-role-backed connection + mailbox helpers.
 */

import {
  isEmailProviderConfigKey,
  providerFromKey
} from "@/lib/voice-tools/connections";
import {
  getTenantMailbox,
  tenantMailboxAddress
} from "@/lib/email/tenant-mailbox";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";

export type SendFromOption = {
  /** "" = the AI coworker mailbox; otherwise a workspace_oauth_connections.id. */
  id: string;
  /** Human label for the dropdown. */
  label: string;
  /** The sender address when known (null for connections missing metadata). */
  email: string | null;
};

/**
 * Pull the connected mailbox's address from Nango metadata.
 * `provider_account_email` is the REAL account behind the OAuth grant (probed
 * from the provider after connect — see lib/nango/account-identity). The
 * `end_user_*` keys are only who was logged into OUR dashboard when the
 * session started (identical across every account the owner connects), so
 * they are last-resort fallbacks for legacy rows.
 */
export function connectionEmail(metadata: Record<string, unknown>): string | null {
  const m = metadata ?? {};
  const candidate =
    (typeof m.provider_account_email === "string" && m.provider_account_email) ||
    (typeof m.email === "string" && m.email) ||
    (typeof m.end_user_email === "string" && m.end_user_email) ||
    (typeof m.end_user_display_name === "string" && m.end_user_display_name) ||
    "";
  return candidate ? candidate : null;
}

/** Friendly provider name for a Nango provider-config key. */
function providerLabel(providerConfigKey: string): string {
  return providerFromKey(providerConfigKey) === "google" ? "Gmail" : "Outlook";
}

/**
 * Build the ordered list of sender options for a business. The coworker mailbox
 * is always first; its address is the reserved local-part (or the UUID default
 * when none is reserved yet — the send path creates the row on first use, so we
 * never write during a page render here).
 */
export async function listSendFromOptions(
  businessId: string
): Promise<SendFromOption[]> {
  const mailbox = await getTenantMailbox(businessId);
  const localPart = mailbox?.local_part ?? businessId.toLowerCase();
  const coworkerAddress = tenantMailboxAddress(localPart);
  const options: SendFromOption[] = [
    { id: "", label: `AI coworker: ${coworkerAddress}`, email: coworkerAddress }
  ];

  const conns = await listWorkspaceOAuthConnections(businessId);
  for (const c of conns) {
    if (!isEmailProviderConfigKey(c.provider_config_key)) continue;
    const email = connectionEmail(c.metadata);
    options.push({
      id: c.id,
      label: email ? `${providerLabel(c.provider_config_key)}: ${email}` : providerLabel(c.provider_config_key),
      email
    });
  }
  return options;
}

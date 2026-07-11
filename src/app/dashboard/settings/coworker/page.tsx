import { CoworkerToolsManager } from "@/components/dashboard/CoworkerToolsManager";
import { FlowSafetySettings } from "@/components/dashboard/FlowSafetySettings";
import { MailboxSettings } from "@/components/dashboard/MailboxSettings";
import { resolveAgentTools } from "@/lib/db/agent-tool-settings";
import {
  PERSONALIZE_TIERS,
  ensureTenantMailbox,
  getTenantMailbox,
  tenantEmailDomain
} from "@/lib/email/tenant-mailbox";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function CoworkerSettingsPage() {
  const { business, viewAs } = await loadSettingsContext();

  const agents = business ? await resolveAgentTools(business.id) : null;
  // Self-heals if provisioning hadn't reserved a mailbox yet (legacy
  // tenants). View-as stays strictly read-only: it must not provision
  // mailbox rows for the tenant as a page-load side effect, so it uses the
  // read-only lookup instead (a missing mailbox just renders no card).
  const mailbox = business
    ? viewAs
      ? await getTenantMailbox(business.id)
      : await ensureTenantMailbox(business.id)
    : null;

  return (
    <SettingsPageShell
      title="Coworker"
      blurb="What your coworker can do and how it behaves"
    >
      {business && mailbox && (
        <MailboxSettings
          businessId={business.id}
          domain={tenantEmailDomain()}
          initialLocalPart={mailbox.local_part}
          initialPersonalized={mailbox.personalized}
          canPersonalize={PERSONALIZE_TIERS.has(business.tier)}
        />
      )}

      {business && agents && (
        <CoworkerToolsManager businessId={business.id} initialAgents={agents} />
      )}

      {business && (
        <FlowSafetySettings
          businessId={business.id}
          initialProtectStaffContacts={business.aiflow_protect_staff_contacts !== false}
        />
      )}
    </SettingsPageShell>
  );
}

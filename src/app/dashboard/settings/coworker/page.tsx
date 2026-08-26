import { getTranslations } from "next-intl/server";
import { CoworkerStaffModeManager } from "@/components/dashboard/CoworkerStaffModeManager";
import { CoworkerToolsManager } from "@/components/dashboard/CoworkerToolsManager";
import { CustomerLanguageSettings } from "@/components/dashboard/CustomerLanguageSettings";
import { FlowSafetySettings } from "@/components/dashboard/FlowSafetySettings";
import { MailboxSettings } from "@/components/dashboard/MailboxSettings";
import { resolveAgentTools } from "@/lib/db/agent-tool-settings";
import { listStaffModes } from "@/lib/owner-surfaces/staff-mode";
import {
  PERSONALIZE_TIERS,
  ensureTenantMailbox,
  tenantEmailDomain
} from "@/lib/email/tenant-mailbox";
import { loadSettingsContext, SettingsPageShell } from "../_shared";

export const dynamic = "force-dynamic";

export default async function CoworkerSettingsPage() {
  const t = await getTranslations("dashboard.settings");
  const { business } = await loadSettingsContext();

  const agents = business ? await resolveAgentTools(business.id) : null;
  const staffModes = business ? await listStaffModes(business.id) : null;
  // Self-heals if provisioning hadn't reserved a mailbox yet (legacy
  // tenants). Runs under admin view-as as well: an operator opening this page
  // for a tenant should see (and be able to configure) the same mailbox the
  // owner's own visit would have reserved, not an empty card.
  const mailbox = business ? await ensureTenantMailbox(business.id) : null;

  return (
    <SettingsPageShell
      title={t("hubCoworkerTitle")}
      blurb={t("coworkerPageBlurb")}
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

      {business && staffModes && (
        <CoworkerStaffModeManager
          // Keyed by business so an admin/business switch remounts the card:
          // useState(initialModes) would otherwise keep the previous tenant's
          // switches on screen while saves already target the new business.
          key={business.id}
          businessId={business.id}
          initialModes={staffModes}
        />
      )}

      {business && agents && (
        <CoworkerToolsManager businessId={business.id} initialAgents={agents} />
      )}

      {business && (
        <CustomerLanguageSettings
          // Keyed by business so an admin/business switch remounts the card:
          // useState(initialLanguage) would otherwise keep the previous
          // tenant's value while saves target the newly active business.
          key={business.id}
          initialLanguage={business.default_customer_language === "es" ? "es" : "en"}
        />
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

import { getAuthUser } from "@/lib/auth";
import { resolveActiveBusinessIdForAction } from "@/lib/dashboard/active-business";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import { redirect } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { getSubscription } from "@/lib/db/subscriptions";
import { resolveActiveRenewalDate } from "@/lib/billing/renewal";
import type { PlanTier } from "@/lib/plans/tier";
import { smsMonthlyLine, voiceMinutesLine } from "@/lib/plans/usage-copy";
import { AccountSettingsForms } from "@/components/dashboard/AccountSettingsForms";
import { CoworkerToolsManager } from "@/components/dashboard/CoworkerToolsManager";
import { FlowSafetySettings } from "@/components/dashboard/FlowSafetySettings";
import { MailboxSettings } from "@/components/dashboard/MailboxSettings";
import { TeamAccessManager } from "@/components/dashboard/TeamAccessManager";
import { BrandingEditor } from "@/components/dashboard/BrandingEditor";
import { parseBranding } from "@/lib/plans/branding";
import { DedicatedSupportCard } from "@/components/dashboard/DedicatedSupportCard";
import { getEnterpriseSupportContact } from "@/lib/plans/enterprise-support";
import { listBusinessMembers } from "@/lib/db/business-members";
import { listTeamMembers } from "@/lib/db/employees";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { resolveAgentTools } from "@/lib/db/agent-tool-settings";
import { WebchatWidgetSettings } from "@/components/dashboard/WebchatWidgetSettings";
import { webchatAllowedForTier } from "@/lib/webchat/tier-gate";
import {
  getOrCreateWidgetSettings,
  getWidgetSettingsForBusiness
} from "@/lib/webchat/db";
import { parseWidgetTheme } from "@/lib/webchat/settings-schema";
import {
  PERSONALIZE_TIERS,
  ensureTenantMailbox,
  getTenantMailbox,
  tenantEmailDomain
} from "@/lib/email/tenant-mailbox";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const { ownerEmail: resolvedEmail, viewAs } = await resolveViewAsContext(user);
  const ownerEmail = resolvedEmail ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, name, tier, enterprise_limits, timezone, branding, aiflow_protect_staff_contacts"
    )
    .in("id", activeBusinessId ? [activeBusinessId] : [])
    .order("created_at", { ascending: false })
    .limit(1);

  const business = businesses?.[0] ?? null;
  const subscription = business ? await getSubscription(business.id) : null;
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
  // Website chat widget (Standard+). Mint-on-first-read only outside
  // view-as — view-as stays read-only (same rationale as the mailbox card).
  const webchatTierAllowed = webchatAllowedForTier(business?.tier);
  const widgetRow = business
    ? viewAs || !webchatTierAllowed
      ? await getWidgetSettingsForBusiness(business.id)
      : await getOrCreateWidgetSettings(business.id)
    : null;
  // Team access is enterprise-only; fetch the roster (and the employee list
  // for the optional person-profile link) only when the card will render.
  const isEnterprise = business?.tier === "enterprise";
  const [teamMembers, employees] =
    business && isEnterprise
      ? await Promise.all([listBusinessMembers(business.id), listTeamMembers(business.id)])
      : [[], []];
  // Same rolling next-charge date the Billing page shows (Stripe's
  // current_period_end, cached and webhook-advanced; see resolveActiveRenewalDate).
  const nextBillingAt =
    subscription?.status === "active" && !subscription.cancel_at_period_end
      ? await resolveActiveRenewalDate(subscription)
      : null;

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Account Settings</h1>
        <p className="text-sm text-parchment/50 mt-1">Billing, notifications, and preferences</p>
      </div>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Account</h2>
        <dl className="space-y-3 text-sm">
          <div className="flex justify-between">
            <dt className="text-parchment/50">Email</dt>
            <dd className="text-parchment">{user.email}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-parchment/50">Plan</dt>
            <dd>
              <Badge variant={business?.tier === "standard" ? "online" : "neutral"}>
                {business?.tier ?? "–"}
              </Badge>
            </dd>
          </div>
          {business?.tier && (
            <div className="pt-2 border-t border-parchment/10">
              <dt className="text-parchment/50 text-xs mb-1">Included usage</dt>
              <dd className="text-xs text-parchment/60 leading-relaxed">
                {voiceMinutesLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined
                )}
                <br />
                {smsMonthlyLine(
                  business.tier as PlanTier,
                  business.tier === "enterprise" ? business.enterprise_limits : undefined
                )}
              </dd>
            </div>
          )}
          <div className="flex justify-between">
            <dt className="text-parchment/50">Subscription status</dt>
            <dd>
              <Badge variant={subscription?.status === "active" ? "success" : "pending"}>
                {subscription?.status ?? "–"}
              </Badge>
            </dd>
          </div>
          {nextBillingAt && (
            <div className="flex justify-between">
              <dt className="text-parchment/50">Next billing date</dt>
              <dd className="text-parchment font-mono">
                <LocalDateTime iso={nextBillingAt} style="date" />
              </dd>
            </div>
          )}
        </dl>
        <a
          href="/dashboard/billing"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          Voice minutes and top-ups →
        </a>
        {subscription?.stripe_customer_id && (
          <form action="/api/billing/portal" method="POST" className="mt-2">
            <button
              type="submit"
              className="text-sm text-claw-green hover:underline"
            >
              Manage billing and payment methods
            </button>
          </form>
        )}
      </Card>

      <AccountSettingsForms
        businessName={business?.name ?? ""}
        businessTimezone={(business?.timezone as string | null) ?? null}
        email={user.email}
      />

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
        <WebchatWidgetSettings
          businessId={business.id}
          tierAllowed={webchatTierAllowed}
          initialSettings={
            widgetRow
              ? {
                  enabled: widgetRow.enabled,
                  publicKey: widgetRow.public_key,
                  allowedOrigins: widgetRow.allowed_origins ?? [],
                  requireContactForm: widgetRow.require_contact_form,
                  theme: parseWidgetTheme(widgetRow.theme)
                }
              : null
          }
        />
      )}

      {business && (
        <FlowSafetySettings
          businessId={business.id}
          initialProtectStaffContacts={
            (business as { aiflow_protect_staff_contacts?: boolean })
              .aiflow_protect_staff_contacts !== false
          }
        />
      )}

      {business && isEnterprise && (
        <DedicatedSupportCard contact={getEnterpriseSupportContact()} />
      )}

      {business && isEnterprise && (
        <BrandingEditor
          businessId={business.id}
          initialBranding={parseBranding((business as { branding?: unknown }).branding)}
        />
      )}

      {business && isEnterprise && (
        <TeamAccessManager
          businessId={business.id}
          initialMembers={teamMembers.map((m) => ({
            id: m.id,
            email: m.email,
            role: m.role,
            status: m.status,
            created_at: m.created_at,
            employee_id: m.employee_id
          }))}
          employees={employees.map((e) => ({ id: e.id, name: e.name }))}
        />
      )}

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Phone number</h2>
        <p className="text-xs text-parchment/40">
          Already have a business number your customers know? Transfer it to your AI coworker;
          most ports finish within a week.
        </p>
        <a
          href="/dashboard/settings/number"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          Bring your own number →
        </a>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-4">Notifications</h2>
        <p className="text-xs text-parchment/40">
          Choose how your coworker reaches you when something urgent happens, and review
          recent delivery history.
        </p>
        <a
          href="/dashboard/notifications"
          className="mt-4 inline-block text-sm text-claw-green hover:underline"
        >
          Manage notifications →
        </a>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">Danger Zone</h2>
        <p className="text-xs text-parchment/40 mb-4">
          These actions are irreversible. Contact support before proceeding.
        </p>
        <form action="/api/auth/signout" method="POST">
          <button
            type="submit"
            className="text-sm text-spark-orange hover:underline"
          >
            Sign out of all sessions
          </button>
        </form>
      </Card>
    </div>
  );
}

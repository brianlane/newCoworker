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
import { SidebarCustomizer } from "@/components/dashboard/SidebarCustomizer";
import { SmsOptOutsCard } from "@/components/dashboard/SmsOptOutsCard";
import { getSidebarLayout } from "@/lib/dashboard/sidebar-prefs";
import { BusinessProfileForm } from "@/components/dashboard/BusinessProfileForm";
import { OwnerProfileForm } from "@/components/dashboard/OwnerProfileForm";
import { DeleteAccountCard } from "@/components/dashboard/DeleteAccountCard";
import { CoworkerToolsManager } from "@/components/dashboard/CoworkerToolsManager";
import { FlowSafetySettings } from "@/components/dashboard/FlowSafetySettings";
import { MailboxSettings } from "@/components/dashboard/MailboxSettings";
import { TeamAccessManager } from "@/components/dashboard/TeamAccessManager";
import { BrandingEditor } from "@/components/dashboard/BrandingEditor";
import { parseBranding } from "@/lib/plans/branding";
import { parseBusinessHours } from "@/lib/business-profile/profile";
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

/**
 * Settings hub sections (BizBlasts-style categorized layout): a sticky
 * quick-nav jumps to anchored groups instead of one undifferentiated card
 * stack. Section ids double as the anchor targets.
 */
const SECTIONS = [
  { id: "account", label: "Account" },
  { id: "business", label: "Business" },
  { id: "coworker", label: "Coworker" },
  { id: "channels", label: "Channels" },
  { id: "team", label: "Team", enterpriseOnly: true },
  { id: "danger", label: "Danger Zone" }
] as const;

function SectionHeading({ id, title, blurb }: { id: string; title: string; blurb: string }) {
  return (
    <div id={id} className="pt-2 scroll-mt-24">
      <h2 className="text-lg font-semibold text-parchment">{title}</h2>
      <p className="text-xs text-parchment/40 mt-0.5">{blurb}</p>
    </div>
  );
}

export default async function SettingsPage() {
  const user = await getAuthUser();
  if (!user) redirect("/login");
  if (!user.email) redirect("/login");

  // Admin view-as swaps in the impersonated tenant's owner email.
  const { ownerEmail: resolvedEmail, viewAs } = await resolveViewAsContext(user);
  const ownerEmail = resolvedEmail ?? user.email;

  const db = await createSupabaseServiceClient();
  const activeBusinessId = await resolveActiveBusinessIdForAction(user, "manage_settings");
  // Owner-only surfaces (`manage_billing` = owner in the role policy):
  // managers see the settings page without the owner-profile card or the
  // delete-account card.
  const isOwner = (await resolveActiveBusinessIdForAction(user, "manage_billing")) !== null;
  const { data: businesses } = await db
    .from("businesses")
    .select(
      "id, name, tier, enterprise_limits, timezone, branding, aiflow_protect_staff_contacts, address, business_hours, business_type, owner_name, phone"
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

  const visibleSections = SECTIONS.filter(
    (s) => !("enterpriseOnly" in s && s.enterpriseOnly) || isEnterprise
  );

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">Settings</h1>
        <p className="text-sm text-parchment/50 mt-1">
          Account, business profile, coworker behavior, and channels
        </p>
      </div>

      {/* Quick nav — anchors into the section groups below. */}
      <nav
        className="flex flex-wrap gap-2 sticky top-0 z-10 bg-deep-ink/95 backdrop-blur py-2 -my-2"
        aria-label="Settings sections"
      >
        {visibleSections.map((s) => (
          <a
            key={s.id}
            href={`#${s.id}`}
            className="rounded-full border border-parchment/15 px-3 py-1 text-xs text-parchment/60 hover:text-parchment hover:border-signal-teal/50 transition-colors"
          >
            {s.label}
          </a>
        ))}
      </nav>

      {/* ============ Account ============ */}
      <SectionHeading
        id="account"
        title="Account"
        blurb="Plan, billing, login email, and password"
      />

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

      <SidebarCustomizer initialLayout={await getSidebarLayout(user.userId)} />

      {/* ============ Business ============ */}
      <SectionHeading
        id="business"
        title="Business"
        blurb="Who you are — your coworker answers customer questions from these facts"
      />

      {business && isOwner && (
        <OwnerProfileForm
          initialOwnerName={(business as { owner_name?: string | null }).owner_name ?? null}
          initialPhone={(business as { phone?: string | null }).phone ?? null}
        />
      )}

      {business && (
        <BusinessProfileForm
          initialAddress={(business as { address?: string | null }).address ?? null}
          initialBusinessType={
            (business as { business_type?: string | null }).business_type ?? null
          }
          initialHours={parseBusinessHours(
            (business as { business_hours?: unknown }).business_hours ?? null
          )}
        />
      )}

      {/* ============ Coworker ============ */}
      <SectionHeading
        id="coworker"
        title="Coworker"
        blurb="What your coworker can do and how it behaves"
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
        <FlowSafetySettings
          businessId={business.id}
          initialProtectStaffContacts={
            (business as { aiflow_protect_staff_contacts?: boolean })
              .aiflow_protect_staff_contacts !== false
          }
        />
      )}

      {/* ============ Channels ============ */}
      <SectionHeading
        id="channels"
        title="Channels"
        blurb="Phone number, website chat, and how we reach you"
      />

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

      {business && <SmsOptOutsCard businessId={business.id} />}

      {/* ============ Team (enterprise) ============ */}
      {business && isEnterprise && (
        <>
          <SectionHeading
            id="team"
            title="Team"
            blurb="Dashboard access, branding, and dedicated support"
          />

          <DedicatedSupportCard contact={getEnterpriseSupportContact()} />

          <BrandingEditor
            businessId={business.id}
            initialBranding={parseBranding((business as { branding?: unknown }).branding)}
          />

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
        </>
      )}

      {/* ============ Danger Zone ============ */}
      <SectionHeading
        id="danger"
        title="Danger Zone"
        blurb="Irreversible actions — read carefully"
      />

      <Card>
        <h2 className="text-sm font-semibold text-parchment mb-2">Sessions</h2>
        <p className="text-xs text-parchment/40 mb-4">
          Signs you out everywhere, including other devices.
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

      {/* Shown during admin view-as too — admins see everything the owner
          sees. Impersonation stays read-only at the API layer: the DELETE
          route refuses view-as, so the card is preview-only for admins. */}
      {isOwner && <DeleteAccountCard />}
    </div>
  );
}

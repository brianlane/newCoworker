import { listBusinesses } from "@/lib/db/businesses";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { listAllBusinessMembers } from "@/lib/db/business-members";
import {
  buildUserEngagementRows,
  listPlatformAuthUsers,
  quietOwnerBusinessIds
} from "@/lib/admin/user-engagement";
import { Card } from "@/components/ui/Card";
import { CreateClientModal } from "@/components/admin/CreateClientModal";
import { ClientsBatchTable } from "@/components/admin/ClientsBatchTable";
import { WhiteGloveOffersPanel } from "@/components/admin/WhiteGloveOffersPanel";
import { WhiteGloveIntakesPanel } from "@/components/admin/WhiteGloveIntakesPanel";
import {
  listProspectWhiteGloveOffers,
  whiteGloveOfferPayUrl
} from "@/lib/db/white-glove-offers";
import { listWhiteGloveIntakes, whiteGloveIntakeUrl } from "@/lib/white-glove/intake";
import { loadFleetMargins } from "@/lib/admin/margin-data";
import type { BusinessMarginEconomics } from "@/lib/admin/margin";

export const dynamic = "force-dynamic";

export default async function AdminClientsPage() {
  const businesses = await listBusinesses();
  const subscriptionMap = await listSubscriptionsByBusinessIds(businesses.map((b) => b.id));
  const prospectOffers = await listProspectWhiteGloveOffers();
  const intakes = await listWhiteGloveIntakes();

  // Per-tenant margin column (src/lib/admin/margin.ts) — best effort: a
  // failed load renders "—" cells, never an errored page.
  const marginByBusiness = await loadFleetMargins()
    .then((data) => data.byBusiness)
    .catch((err: unknown) => {
      console.error(
        "admin clients: margin load failed",
        err instanceof Error ? err.message : err
      );
      return new Map<string, BusinessMarginEconomics>();
    });

  // Churn-risk badge: businesses whose owner hasn't signed in for 90+ days
  // (see /admin/engagement). Best effort — an auth-directory read failure OR
  // a clipped (partial) directory degrades to "no badges" instead of
  // erroring the page or flagging users the scan never reached.
  const quietOwners = await listPlatformAuthUsers()
    .then(async ({ users, clipped }) => {
      if (clipped) return new Set<string>();
      return quietOwnerBusinessIds(
        buildUserEngagementRows({
          users,
          businesses,
          members: await listAllBusinessMembers()
        })
      );
    })
    .catch((err: unknown) => {
      console.error(
        "admin clients: engagement read failed",
        err instanceof Error ? err.message : err
      );
      return new Set<string>();
    });

  // "Active" means a paying client — active subscription backed by a real
  // Stripe payment — matching the dashboard's day-current MRR definition
  // (src/lib/admin/mrr.ts). Wiped rows, canceled internal pilots, and
  // no-subscription smoke clones count only toward the total.
  const activeClientCount = businesses.filter((b) => {
    const sub = subscriptionMap.get(b.id);
    return sub?.status === "active" && sub.stripe_subscription_id !== null;
  }).length;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-parchment">Admin Overview</h1>
          <p className="text-sm text-parchment/50 mt-1">
            {activeClientCount} active · {businesses.length} total
          </p>
        </div>
        <CreateClientModal />
      </div>

      {businesses.length === 0 ? (
        <Card>
          <p className="text-parchment/50 text-sm text-center py-8">
            No clients yet. Onboard the first one!
          </p>
        </Card>
      ) : (
        <Card padding="sm">
          <ClientsBatchTable
            rows={businesses.map((b) => ({
              id: b.id,
              name: b.name,
              ownerEmail: b.owner_email,
              tier: b.tier,
              createdAt: b.created_at,
              status: b.status,
              isPaused: !!b.is_paused,
              subscriptionStatus: subscriptionMap.get(b.id)?.status ?? null,
              ownerQuiet: quietOwners.has(b.id),
              marginCents: marginByBusiness.get(b.id)?.marginCents ?? null
            }))}
          />
        </Card>
      )}

      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          White-glove setup questionnaires
        </h2>
        <WhiteGloveIntakesPanel
          initialIntakes={intakes.map((i) => ({
            id: i.id,
            business_name: i.business_name,
            industry: i.industry,
            recipient_email: i.recipient_email,
            business_id: i.business_id,
            answers: i.answers,
            status: i.status,
            created_at: i.created_at,
            completed_at: i.completed_at,
            applied_at: i.applied_at,
            intakeUrl: whiteGloveIntakeUrl(i)
          }))}
          businesses={businesses.map((b) => ({
            id: b.id,
            name: b.name,
            ownerEmail: b.owner_email
          }))}
        />
      </Card>

      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-4">
          Prospect white-glove offers (pre-account)
        </h2>
        <WhiteGloveOffersPanel
          initialOffers={prospectOffers.map((o) => ({
            id: o.id,
            name: o.name,
            description: o.description,
            amount_cents: o.amount_cents,
            status: o.status,
            created_at: o.created_at,
            paid_at: o.paid_at,
            recipient_email: o.recipient_email,
            payUrl: whiteGloveOfferPayUrl(o)
          }))}
        />
      </Card>
    </div>
  );
}

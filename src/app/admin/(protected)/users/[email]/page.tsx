import Link from "next/link";
import { notFound } from "next/navigation";
import { listBusinesses } from "@/lib/db/businesses";
import { listAllBusinessMembers } from "@/lib/db/business-members";
import { listSubscriptionsByBusinessIds } from "@/lib/db/subscriptions";
import { findAuthUserIdByEmail } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { classifyEngagement } from "@/lib/analytics/engagement";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { StatusDot } from "@/components/ui/StatusDot";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { DeleteUserButton } from "@/components/admin/DeleteUserButton";

export const dynamic = "force-dynamic";

function segmentBadgeVariant(segment: string): "success" | "pending" | "neutral" | "error" {
  if (segment === "active") return "success";
  if (segment === "new") return "pending";
  if (segment === "cooling") return "neutral";
  return "error";
}

/**
 * Per-user admin detail page — the BizBlasts users-admin show page: auth
 * account facts, engagement segment, every business relationship (owned +
 * member), and the complete-delete action.
 */
export default async function AdminUserDetailPage({
  params
}: {
  params: Promise<{ email: string }>;
}) {
  const { email: rawEmail } = await params;
  const email = decodeURIComponent(rawEmail).trim().toLowerCase();
  if (!email) notFound();

  const [businesses, members] = await Promise.all([
    listBusinesses(),
    listAllBusinessMembers()
  ]);

  const ownedBusinesses = businesses.filter(
    (b) => (b.owner_email ?? "").trim().toLowerCase() === email
  );
  const memberships = members.filter(
    (m) => m.email.toLowerCase() === email && m.status !== "revoked"
  );

  // Full auth record (the engagement scan only carries a slim projection).
  const authUserId = await findAuthUserIdByEmail(email);
  let authUser: {
    id: string;
    created_at: string;
    last_sign_in_at: string | null;
    email_confirmed_at: string | null;
  } | null = null;
  if (authUserId) {
    const db = await createSupabaseServiceClient();
    const { data } = await db.auth.admin.getUserById(authUserId);
    if (data?.user) {
      authUser = {
        id: data.user.id,
        created_at: data.user.created_at,
        last_sign_in_at: data.user.last_sign_in_at ?? null,
        email_confirmed_at: data.user.email_confirmed_at ?? null
      };
    }
  }

  // A user with no auth account AND no business relationship doesn't exist.
  if (!authUser && ownedBusinesses.length === 0 && memberships.length === 0) {
    notFound();
  }

  const subscriptionMap = await listSubscriptionsByBusinessIds(ownedBusinesses.map((b) => b.id));

  // Same fallback chain the engagement table uses: auth account creation,
  // else the OLDEST business/invite date — so an invite-only member reads
  // "new" here too instead of "quiet", and a long-time owner's recent second
  // business can't make the whole account look new (listBusinesses is
  // newest-first; memberships are already oldest-first). The notFound guard
  // above guarantees at least one source exists.
  const oldestOwnedCreatedAt = ownedBusinesses.reduce<string | null>(
    (oldest, b) => (oldest === null || b.created_at < oldest ? b.created_at : oldest),
    null
  );
  const createdAt =
    authUser?.created_at ??
    oldestOwnedCreatedAt ??
    memberships[0]?.created_at ??
    new Date().toISOString();
  const segment = classifyEngagement({
    created_at: createdAt,
    last_interaction_at: authUser?.last_sign_in_at ?? null
  });

  const businessById = new Map(businesses.map((b) => [b.id, b]));

  return (
    <div className="space-y-6 max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-xs text-parchment/40">
            <Link href="/admin/engagement" className="hover:text-signal-teal">
              Engagement
            </Link>{" "}
            / user
          </p>
          <h1 className="text-2xl font-bold text-parchment mt-1 break-all">{email}</h1>
          <div className="flex items-center gap-2 mt-2">
            <Badge variant={segmentBadgeVariant(segment)}>{segment}</Badge>
            {!authUser && <Badge variant="pending">no login yet</Badge>}
          </div>
        </div>
        <DeleteUserButton email={email} ownedBusinessCount={ownedBusinesses.length} />
      </div>

      {/* Account facts */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
          Account
        </h2>
        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-3 text-sm">
          <div>
            <dt className="text-parchment/40 text-xs">Auth user id</dt>
            <dd className="text-parchment font-mono text-xs break-all">
              {authUser?.id ?? "– (invited, never signed up)"}
            </dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Created</dt>
            <dd className="text-parchment">
              {createdAt ? <LocalDateTime iso={createdAt} style="date" /> : "–"}
            </dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Last sign-in</dt>
            <dd className="text-parchment">
              {authUser?.last_sign_in_at ? (
                <LocalDateTime iso={authUser.last_sign_in_at} />
              ) : (
                "never"
              )}
            </dd>
          </div>
          <div>
            <dt className="text-parchment/40 text-xs">Email confirmed</dt>
            <dd>
              {!authUser ? (
                <span className="text-parchment/40 text-xs">– (no account)</span>
              ) : authUser.email_confirmed_at ? (
                <Badge variant="success">confirmed</Badge>
              ) : (
                <Badge variant="pending">unconfirmed</Badge>
              )}
            </dd>
          </div>
        </dl>
      </Card>

      {/* Owned businesses */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
          Owned Businesses ({ownedBusinesses.length})
        </h2>
        {ownedBusinesses.length === 0 ? (
          <p className="text-sm text-parchment/40">Owns no businesses.</p>
        ) : (
          <ul className="divide-y divide-parchment/8">
            {ownedBusinesses.map((b) => {
              const sub = subscriptionMap.get(b.id);
              return (
                <li key={b.id} className="py-2.5 flex flex-wrap items-center gap-2">
                  <a
                    href={`/admin/${b.id}`}
                    className="text-sm text-parchment font-medium hover:text-signal-teal"
                  >
                    {b.name}
                  </a>
                  <Badge variant="neutral">{b.tier}</Badge>
                  <StatusDot
                    status={b.status as "online" | "offline" | "high_load" | "wiped"}
                    showLabel
                  />
                  {sub ? (
                    <Badge
                      variant={
                        sub.status === "active"
                          ? "success"
                          : sub.status === "past_due"
                            ? "error"
                            : "pending"
                      }
                    >
                      {sub.status.replaceAll("_", " ")}
                    </Badge>
                  ) : (
                    <Badge variant="neutral">no subscription</Badge>
                  )}
                  <span className="text-xs text-parchment/30 ml-auto shrink-0">
                    since <LocalDateTime iso={b.created_at} style="date" />
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      {/* Team memberships on other tenants */}
      <Card>
        <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
          Team Memberships ({memberships.length})
        </h2>
        {memberships.length === 0 ? (
          <p className="text-sm text-parchment/40">No team memberships.</p>
        ) : (
          <ul className="divide-y divide-parchment/8">
            {memberships.map((m) => {
              const business = businessById.get(m.business_id);
              return (
                <li key={m.id} className="py-2.5 flex flex-wrap items-center gap-2">
                  {business ? (
                    <a
                      href={`/admin/${business.id}`}
                      className="text-sm text-parchment font-medium hover:text-signal-teal"
                    >
                      {business.name}
                    </a>
                  ) : (
                    <span className="text-sm text-parchment/60 font-mono">
                      {m.business_id.slice(0, 8)}…
                    </span>
                  )}
                  <Badge variant="neutral">{m.role}</Badge>
                  <Badge variant={m.status === "active" ? "success" : "pending"}>{m.status}</Badge>
                  <span className="text-xs text-parchment/30 ml-auto shrink-0">
                    {m.accepted_at ? (
                      <>
                        joined <LocalDateTime iso={m.accepted_at} style="date" />
                      </>
                    ) : (
                      <>
                        invited <LocalDateTime iso={m.created_at} style="date" />
                      </>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}

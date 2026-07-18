import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Card } from "@/components/ui/Card";
import { IntegrationTile } from "@/components/dashboard/IntegrationTile";
import {
  computeIntegrationStatuses,
  loadIntegrationsContext
} from "@/lib/dashboard/integrations-context";
import { INTEGRATION_CATEGORIES, INTEGRATIONS } from "@/lib/integrations/registry";

export const dynamic = "force-dynamic";

type SearchParams = Promise<{ error?: string; workspace?: string; meta?: string }>;

export default async function IntegrationsPage({ searchParams }: { searchParams: SearchParams }) {
  const t = await getTranslations("dashboard.pages");
  const q = await searchParams;
  const ctx = await loadIntegrationsContext("/dashboard/integrations");
  const { businessId, canManageApiKeys } = ctx;
  const statuses = computeIntegrationStatuses(ctx);

  const visible = INTEGRATIONS.filter((i) => !i.ownerOnly || canManageApiKeys);

  return (
    <div className="space-y-8 max-w-4xl">
      <div>
        <h1 className="text-2xl font-bold text-parchment">{t("integrationsTitle")}</h1>
        <p className="text-sm text-parchment/50 mt-1">
          {t("integrationsSubtitle")}
        </p>
      </div>

      {q.error && (
        <Card className="border-spark-orange/40 bg-spark-orange/5">
          <p className="text-sm text-spark-orange">
            Connection failed: {decodeURIComponent(q.error).replace(/\+/g, " ")}
          </p>
        </Card>
      )}

      {q.workspace === "connected" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">Connected successfully.</p>
        </Card>
      )}

      {q.meta === "connected" && (
        <Card className="border-claw-green/40 bg-claw-green/5">
          <p className="text-sm text-claw-green">
            Facebook connected — open Meta Lead Ads below to pick the Page to watch for
            leads.
          </p>
        </Card>
      )}

      {!businessId ? (
        <Card>
          <p className="text-parchment/60 text-sm text-center py-6">
            Provision your coworker first to manage integrations.
          </p>
          <a
            href="/onboard"
            className="block text-center text-sm text-signal-teal hover:underline"
          >
            Get started →
          </a>
        </Card>
      ) : (
        INTEGRATION_CATEGORIES.map((category) => {
          const items = visible.filter((i) => i.category === category);
          if (items.length === 0) return null;
          return (
            <section key={category} className="space-y-3">
              <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider">
                {category}
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {items.map((integration) => (
                  <IntegrationTile
                    key={integration.slug}
                    integration={integration}
                    status={statuses[integration.slug]}
                  />
                ))}
              </div>
              {category === "Lead sources" && (
                <p className="text-xs text-parchment/45">
                  Using another lead source? Any tool that exports a spreadsheet or calls a
                  webhook can feed your coworker — see the{" "}
                  <Link
                    href="/dashboard/aiflows/guides/instagram-leads"
                    className="text-signal-teal hover:underline"
                  >
                    Instagram prospects guide
                  </Link>{" "}
                  or the{" "}
                  <Link
                    href="/dashboard/aiflows/guides/meta-leads"
                    className="text-signal-teal hover:underline"
                  >
                    Meta ad leads guide
                  </Link>
                  .
                </p>
              )}
            </section>
          );
        })
      )}
    </div>
  );
}

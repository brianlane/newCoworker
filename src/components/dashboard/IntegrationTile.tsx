import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/Badge";
import type { IntegrationDef, IntegrationStatus } from "@/lib/integrations/registry";

type Props = {
  integration: IntegrationDef;
  status: IntegrationStatus;
};

const badgeVariant = (state: IntegrationStatus["state"]) =>
  state === "connected"
    ? ("success" as const)
    : state === "attention"
      ? ("pending" as const)
      : ("neutral" as const);

/**
 * Compact directory tile on /dashboard/integrations. The whole tile links
 * to the integration's detail page, where setup and management live.
 */
export function IntegrationTile({ integration, status }: Props) {
  const Icon = integration.icon;
  return (
    <Link
      href={`/dashboard/integrations/${integration.slug}`}
      className="group flex items-start gap-3 rounded-xl border border-parchment/10 bg-deep-ink/75 p-5 backdrop-blur-sm transition-colors hover:border-signal-teal/40 hover:bg-deep-ink/90"
    >
      <div className="shrink-0 rounded-lg bg-parchment/10 p-2 text-signal-teal">
        <Icon size={20} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="truncate text-sm font-semibold text-parchment">{integration.name}</h3>
          <span className="flex shrink-0 items-center gap-1.5">
            <Badge variant={badgeVariant(status.state)}>{status.label}</Badge>
            <ChevronRight
              size={16}
              className="text-parchment/30 transition-transform group-hover:translate-x-0.5 group-hover:text-parchment/60"
            />
          </span>
        </div>
        <p className="mt-1 text-xs leading-relaxed text-parchment/50 line-clamp-2">
          {integration.benefit}
        </p>
      </div>
    </Link>
  );
}

import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import type { LucideIcon } from "lucide-react";

export type IntegrationCardStatus = "connected" | "disconnected" | "coming_soon" | "platform";

type IntegrationCardProps = {
  title: string;
  description: string;
  icon: LucideIcon;
  status: IntegrationCardStatus;
  statusLabel?: string;
  children?: React.ReactNode;
};

const badgeVariant = (status: IntegrationCardStatus) => {
  switch (status) {
    case "connected":
      return "success" as const;
    case "disconnected":
      return "neutral" as const;
    case "coming_soon":
      return "pending" as const;
    case "platform":
      return "online" as const;
    default:
      return "neutral" as const;
  }
};

export function IntegrationCard({
  title,
  description,
  icon: Icon,
  status,
  statusLabel,
  children
}: IntegrationCardProps) {
  const label =
    statusLabel ??
    (status === "connected"
      ? "Connected"
      : status === "disconnected"
        ? "Not connected"
        : status === "coming_soon"
          ? "Coming soon"
          : "Platform");

  return (
    <Card className="flex flex-col h-full">
      <div className="flex items-start gap-3 mb-3">
        <div className="rounded-lg bg-parchment/10 p-2 text-signal-teal">
          <Icon size={22} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="font-semibold text-parchment text-sm">{title}</h3>
            <Badge variant={badgeVariant(status)}>{label}</Badge>
          </div>
          <p className="text-xs text-parchment/50 mt-1 leading-relaxed">{description}</p>
        </div>
      </div>
      {children && <div className="mt-auto pt-3 border-t border-parchment/10">{children}</div>}
    </Card>
  );
}

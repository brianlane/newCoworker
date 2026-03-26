type Status = "online" | "offline" | "high_load";

interface StatusDotProps {
  status: Status;
  showLabel?: boolean;
}

const dotClasses: Record<Status, string> = {
  online: "bg-claw-green",
  offline: "bg-parchment/30",
  high_load: "bg-spark-orange"
};

const labels: Record<Status, string> = {
  online: "Online",
  offline: "Offline",
  high_load: "High Load"
};

export function StatusDot({ status, showLabel = false }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span
        className={[
          "inline-block h-2 w-2 rounded-full",
          dotClasses[status],
          status === "online" ? "animate-pulse" : ""
        ].join(" ")}
      />
      {showLabel && (
        <span className="text-xs text-parchment/70">{labels[status]}</span>
      )}
    </span>
  );
}

type Variant = "online" | "offline" | "high_load" | "success" | "error" | "pending" | "neutral";

interface BadgeProps {
  variant?: Variant;
  children: React.ReactNode;
  className?: string;
}

const variantClasses: Record<Variant, string> = {
  online: "bg-claw-green/20 text-claw-green border-claw-green/30",
  offline: "bg-parchment/10 text-parchment/50 border-parchment/20",
  high_load: "bg-spark-orange/20 text-spark-orange border-spark-orange/30",
  success: "bg-claw-green/20 text-claw-green border-claw-green/30",
  error: "bg-spark-orange/20 text-spark-orange border-spark-orange/30",
  pending: "bg-signal-teal/20 text-signal-teal border-signal-teal/30",
  neutral: "bg-soft-stone/20 text-soft-stone border-soft-stone/30"
};

export function Badge({ variant = "neutral", className = "", children }: BadgeProps) {
  return (
    <span
      className={[
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium",
        variantClasses[variant],
        className
      ].join(" ")}
    >
      {children}
    </span>
  );
}

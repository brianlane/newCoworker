import { type HTMLAttributes } from "react";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  padding?: "sm" | "md" | "lg";
}

const paddingClasses = {
  sm: "p-3",
  md: "p-5",
  lg: "p-8"
};

export function Card({ padding = "md", className = "", children, ...props }: CardProps) {
  return (
    <div
      className={[
        "rounded-xl border border-parchment/10 bg-deep-ink/75 backdrop-blur-sm",
        paddingClasses[padding],
        className
      ].join(" ")}
      {...props}
    >
      {children}
    </div>
  );
}

import { type InputHTMLAttributes, forwardRef } from "react";

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, className = "", id, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex flex-col gap-1">
        {label && (
          <label htmlFor={inputId} className="text-sm font-medium text-parchment/80">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={[
            "rounded-lg border bg-deep-ink/50 px-3 py-2 text-sm text-parchment placeholder-parchment/30",
            "focus:outline-none focus:ring-2 focus:ring-signal-teal focus:border-transparent",
            "disabled:opacity-50 disabled:cursor-not-allowed",
            error ? "border-spark-orange" : "border-parchment/20",
            className
          ].join(" ")}
          {...props}
        />
        {error && <p className="text-xs text-spark-orange">{error}</p>}
      </div>
    );
  }
);

Input.displayName = "Input";

"use client";

import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";

export type FeedFilterOption = {
  /** URL-param value (e.g. "sms_outbound", "error"). */
  value: string;
  /** Chip text — matches the badge terms the rows themselves display. */
  label: string;
};

/** Preset look-backs offered by the time filter. */
const DAY_PRESETS = [1, 7, 30] as const;

/**
 * Filter bar for the admin see-all feed pages (/admin/alerts and
 * /admin/activity): toggle chips for the type filter (no chips selected =
 * everything), a business select, and a look-back preset. State lives in the
 * URL (`types`, `business`, `days`) so the server component refetches the
 * filtered view — same convention as the owner dashboard's ActivityFilters.
 */
export function AdminFeedFilters({
  basePath,
  options,
  selected,
  businesses,
  businessId,
  days
}: {
  /** The page the params navigate to, e.g. "/admin/activity". */
  basePath: string;
  /** Type chips, in display order. */
  options: FeedFilterOption[];
  /** Currently selected type values (validated server-side); empty = all. */
  selected: string[];
  /** Fleet businesses for the tenant select (id + display name). */
  businesses: Array<{ id: string; name: string }>;
  /** Currently selected business id; undefined = all tenants. */
  businessId: string | undefined;
  /** Current look-back in days; undefined = the feed's full window. */
  days: number | undefined;
}) {
  const t = useTranslations("admin.feedFilters");
  const router = useRouter();

  const navigate = (
    nextTypes: string[],
    nextBusiness: string | undefined,
    nextDays: number | undefined
  ) => {
    const q = new URLSearchParams();
    if (nextTypes.length > 0) q.set("types", nextTypes.join(","));
    if (nextBusiness) q.set("business", nextBusiness);
    if (nextDays) q.set("days", String(nextDays));
    const qs = q.toString();
    router.push(qs ? `${basePath}?${qs}` : basePath);
  };

  const toggleType = (value: string) => {
    const next = selected.includes(value)
      ? selected.filter((v) => v !== value)
      : [...selected, value];
    navigate(next, businessId, days);
  };

  // A days value outside the presets (hand-edited URL) still renders selected
  // so the select reflects what the list actually shows.
  const extraDays =
    days !== undefined && !DAY_PRESETS.includes(days as 1 | 7 | 30) ? days : null;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div
        className="flex flex-wrap items-center gap-1.5"
        role="group"
        aria-label={t("filterByType")}
      >
        {options.map((opt) => {
          const active = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => toggleType(opt.value)}
              aria-pressed={active}
              className={[
                "rounded-full border px-2.5 py-1 text-xs transition-colors",
                active
                  ? "border-signal-teal/70 bg-signal-teal/15 text-signal-teal"
                  : "border-parchment/15 text-parchment/60 hover:border-parchment/35 hover:text-parchment"
              ].join(" ")}
            >
              {opt.label}
            </button>
          );
        })}
        {selected.length > 0 && (
          <button
            type="button"
            onClick={() => navigate([], businessId, days)}
            className="px-1.5 py-1 text-xs text-parchment/40 hover:text-parchment transition-colors"
          >
            {t("clear")}
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1.5">
          <label htmlFor="feed-business" className="text-xs text-parchment/50">
            {t("business")}
          </label>
          <select
            id="feed-business"
            value={businessId ?? ""}
            onChange={(e) =>
              navigate(selected, e.target.value === "" ? undefined : e.target.value, days)
            }
            className="max-w-48 rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment focus:border-signal-teal/60 focus:outline-none"
          >
            <option value="">{t("allBusinesses")}</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-1.5">
          <label htmlFor="feed-days" className="text-xs text-parchment/50">
            {t("time")}
          </label>
          <select
            id="feed-days"
            value={days ?? ""}
            onChange={(e) => {
              const raw = e.target.value;
              navigate(selected, businessId, raw === "" ? undefined : Number(raw));
            }}
            className="rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-xs text-parchment focus:border-signal-teal/60 focus:outline-none"
          >
            {DAY_PRESETS.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? t("today") : t("lastDays", { days: d })}
              </option>
            ))}
            {extraDays !== null && (
              <option value={extraDays}>{t("lastDays", { days: extraDays })}</option>
            )}
            <option value="">{t("allTime")}</option>
          </select>
        </div>
      </div>
    </div>
  );
}

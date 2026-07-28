"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { formatPriceCents } from "@/lib/pricing";
import type { BillingPeriod } from "@/lib/plans/tier";
import type { PromotionRedemptionRow } from "@/lib/db/promotions";
import type { PromotionWithStats } from "@/lib/promotions/stats";
import type { PromotionDuration, PromotionTier } from "@/lib/stripe/promotions";

export type AdminPromotionRedemption = PromotionRedemptionRow & { business_name: string | null };

export type AdminPromotion = Omit<PromotionWithStats, "redemptions"> & {
  redemptions: AdminPromotionRedemption[];
};

const ALL_TIERS: PromotionTier[] = ["starter", "standard"];
const ALL_PERIODS: BillingPeriod[] = ["monthly", "annual", "biennial"];

type FormState = {
  code: string;
  name: string;
  discountKind: "percent" | "amount";
  percentOff: string;
  amountOffUsd: string;
  duration: PromotionDuration;
  durationInMonths: string;
  allowedTiers: PromotionTier[];
  allowedPeriods: BillingPeriod[];
  startsAt: string;
  endsAt: string;
  maxRedemptions: string;
  active: boolean;
};

/** ISO instant to the `datetime-local` value the browser wants (local clock). */
function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalInput(value: string): string | null {
  return value ? new Date(value).toISOString() : null;
}

function blankForm(): FormState {
  return {
    code: "",
    name: "",
    discountKind: "percent",
    percentOff: "20",
    amountOffUsd: "",
    duration: "once",
    durationInMonths: "",
    allowedTiers: [...ALL_TIERS],
    allowedPeriods: [...ALL_PERIODS],
    startsAt: toLocalInput(new Date().toISOString()),
    endsAt: "",
    maxRedemptions: "",
    active: true
  };
}

function formFor(promotion: AdminPromotion): FormState {
  return {
    code: promotion.code,
    name: promotion.name,
    discountKind: promotion.percent_off === null ? "amount" : "percent",
    percentOff: promotion.percent_off === null ? "" : String(promotion.percent_off),
    amountOffUsd:
      promotion.amount_off_cents === null ? "" : String(promotion.amount_off_cents / 100),
    duration: promotion.duration,
    durationInMonths:
      promotion.duration_in_months === null ? "" : String(promotion.duration_in_months),
    allowedTiers: [...promotion.allowed_tiers],
    allowedPeriods: [...promotion.allowed_periods],
    startsAt: toLocalInput(promotion.starts_at),
    endsAt: toLocalInput(promotion.ends_at),
    maxRedemptions: promotion.max_redemptions === null ? "" : String(promotion.max_redemptions),
    active: promotion.active
  };
}

function toggleMember<T>(list: T[], value: T): T[] {
  return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}

type ApiResponse = { ok: boolean; error?: { message: string } };

/**
 * Admin promo-code console: create, edit, switch on or off, delete, and read
 * per-code redemption stats. Every mutation goes through
 * /api/admin/promotions, which owns the Stripe side (an edited discount mints
 * a replacement coupon, since Stripe coupons are immutable).
 */
export function PromotionsManager({ initialPromotions }: { initialPromotions: AdminPromotion[] }) {
  const t = useTranslations("admin.promotionsPage");
  const [promotions, setPromotions] = useState(initialPromotions);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [form, setForm] = useState<FormState>(blankForm());
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => {
    const res = await fetch("/api/admin/promotions");
    const json = (await res.json()) as ApiResponse & { data?: { promotions: AdminPromotion[] } };
    if (json.ok && json.data) setPromotions(json.data.promotions);
  };

  const send = async (method: "POST" | "PATCH" | "DELETE", body: unknown) => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/promotions", {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const json = (await res.json()) as ApiResponse;
      if (!json.ok) throw new Error(json.error?.message ?? t("genericError"));
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : t("genericError"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const discountPayload = () =>
    form.discountKind === "percent"
      ? { percentOff: Number(form.percentOff), amountOffUsd: null }
      : { percentOff: null, amountOffUsd: Number(form.amountOffUsd) };

  const submit = async () => {
    const shared = {
      name: form.name,
      ...discountPayload(),
      duration: form.duration,
      durationInMonths: form.duration === "repeating" ? Number(form.durationInMonths) : null,
      allowedTiers: form.allowedTiers,
      allowedPeriods: form.allowedPeriods,
      startsAt: fromLocalInput(form.startsAt) ?? new Date().toISOString(),
      endsAt: fromLocalInput(form.endsAt),
      maxRedemptions: form.maxRedemptions ? Number(form.maxRedemptions) : null,
      active: form.active
    };
    const ok =
      editing === "new"
        ? await send("POST", { code: form.code, ...shared })
        : await send("PATCH", { promotionId: editing, ...shared });
    if (ok) setEditing(null);
  };

  const toggleActive = async (promotion: AdminPromotion) => {
    await send("PATCH", { promotionId: promotion.id, active: !promotion.active });
  };

  const remove = async (promotion: AdminPromotion) => {
    if (!window.confirm(t("deleteConfirm", { code: promotion.code }))) return;
    await send("DELETE", { promotionId: promotion.id });
  };

  const discountLabel = (promotion: AdminPromotion) =>
    promotion.percent_off === null
      ? t("amountOffLabel", { amount: formatPriceCents(promotion.amount_off_cents ?? 0) })
      : t("percentOffLabel", { percent: promotion.percent_off });

  const lifecycleClass = (lifecycle: AdminPromotion["lifecycle"]) =>
    lifecycle === "active"
      ? "bg-claw-green/15 text-claw-green"
      : lifecycle === "scheduled"
        ? "bg-signal-teal/15 text-signal-teal"
        : lifecycle === "off"
          ? "bg-parchment/10 text-parchment/60"
          : "bg-spark-orange/15 text-spark-orange";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("title")}</h1>
          <p className="mt-1 text-sm text-parchment/50">{t("subtitle")}</p>
        </div>
        <Button
          onClick={() => {
            setForm(blankForm());
            setEditing("new");
            setError(null);
          }}
        >
          {t("newPromotion")}
        </Button>
      </div>

      {error && (
        <p className="rounded-lg border border-spark-orange/40 bg-spark-orange/10 px-4 py-2 text-sm text-spark-orange">
          {error}
        </p>
      )}

      {editing !== null && (
        <PromotionForm
          form={form}
          setForm={setForm}
          isNew={editing === "new"}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSubmit={() => void submit()}
        />
      )}

      <div className="overflow-x-auto rounded-xl border border-parchment/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-parchment/10 text-xs uppercase tracking-wide text-parchment/40">
            <tr>
              <th className="px-4 py-3">{t("colCode")}</th>
              <th className="px-4 py-3">{t("colDiscount")}</th>
              <th className="px-4 py-3">{t("colScope")}</th>
              <th className="px-4 py-3">{t("colWindow")}</th>
              <th className="px-4 py-3">{t("colStatus")}</th>
              <th className="px-4 py-3">{t("colRedemptions")}</th>
              <th className="px-4 py-3">{t("colDiscounted")}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {promotions.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-10 text-center text-parchment/45">
                  {t("empty")}
                </td>
              </tr>
            )}
            {promotions.map((promotion) => (
              <Fragment key={promotion.id}>
                <tr className="border-b border-parchment/5">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      onClick={() => setExpanded(expanded === promotion.id ? null : promotion.id)}
                      className="font-mono font-medium text-parchment hover:text-claw-green"
                    >
                      {promotion.code}
                    </button>
                    <p className="text-xs text-parchment/40">{promotion.name}</p>
                  </td>
                  <td className="px-4 py-3 text-parchment/70">
                    {discountLabel(promotion)}
                    <p className="text-xs text-parchment/40">
                      {promotion.duration === "repeating"
                        ? t("durationRepeating", { months: promotion.duration_in_months ?? 0 })
                        : t(`duration_${promotion.duration}`)}
                    </p>
                  </td>
                  <td className="px-4 py-3 text-xs text-parchment/50">
                    {promotion.allowed_tiers.map((tier) => t(`tier_${tier}`)).join(", ")}
                    <br />
                    {promotion.allowed_periods.map((p) => t(`period_${p}`)).join(", ")}
                  </td>
                  <td className="px-4 py-3 text-xs text-parchment/50">
                    {new Date(promotion.starts_at).toLocaleDateString()}
                    {" - "}
                    {promotion.ends_at
                      ? new Date(promotion.ends_at).toLocaleDateString()
                      : t("noEndDate")}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs ${lifecycleClass(promotion.lifecycle)}`}
                    >
                      {t(`lifecycle_${promotion.lifecycle}`)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-parchment/70">
                    {promotion.stats.redemptionCount}
                    {promotion.max_redemptions !== null && (
                      <span className="text-parchment/40"> / {promotion.max_redemptions}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-parchment/70">
                    {formatPriceCents(promotion.stats.totalDiscountedCents)}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-3">
                      <button
                        type="button"
                        role="switch"
                        aria-checked={promotion.active}
                        aria-label={t("toggleLabel", { code: promotion.code })}
                        disabled={busy}
                        onClick={() => void toggleActive(promotion)}
                        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 ${
                          promotion.active ? "bg-signal-teal" : "bg-parchment/20"
                        }`}
                      >
                        <span
                          className={`inline-block h-3.5 w-3.5 transform rounded-full bg-deep-ink transition-transform ${
                            promotion.active ? "translate-x-5" : "translate-x-1"
                          }`}
                        />
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          setForm(formFor(promotion));
                          setEditing(promotion.id);
                          setError(null);
                        }}
                        className="text-xs text-signal-teal hover:underline disabled:opacity-50"
                      >
                        {t("edit")}
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(promotion)}
                        className="text-xs text-spark-orange hover:underline disabled:opacity-50"
                      >
                        {t("delete")}
                      </button>
                    </div>
                  </td>
                </tr>
                {expanded === promotion.id && (
                  <tr className="border-b border-parchment/5">
                    <td colSpan={8} className="bg-parchment/5 px-4 py-4">
                      <PromotionDetail promotion={promotion} />
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function PromotionDetail({ promotion }: { promotion: AdminPromotion }) {
  const t = useTranslations("admin.promotionsPage");
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-6 text-xs text-parchment/60">
        <span>
          {t("statRedemptions")}: <strong className="text-parchment">{promotion.stats.redemptionCount}</strong>
        </span>
        <span>
          {t("statDiscounted")}:{" "}
          <strong className="text-parchment">
            {formatPriceCents(promotion.stats.totalDiscountedCents)}
          </strong>
        </span>
        <span>
          {t("statLastRedeemed")}:{" "}
          <strong className="text-parchment">
            {promotion.stats.lastRedeemedAt
              ? new Date(promotion.stats.lastRedeemedAt).toLocaleString()
              : t("statNever")}
          </strong>
        </span>
      </div>
      {promotion.redemptions.length === 0 ? (
        <p className="text-xs text-parchment/40">{t("noRedemptions")}</p>
      ) : (
        <ul className="space-y-1 text-xs text-parchment/60">
          {promotion.redemptions.map((redemption) => (
            <li key={redemption.id}>
              <span className="text-parchment">
                {redemption.business_name ?? redemption.business_id}
              </span>{" "}
              {t(`tier_${redemption.tier}`)} {t(`period_${redemption.billing_period}`)}
              {" - "}
              {formatPriceCents(redemption.amount_discounted_cents)} {t("off")}
              {" - "}
              {new Date(redemption.created_at).toLocaleDateString()}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function PromotionForm({
  form,
  setForm,
  isNew,
  busy,
  onCancel,
  onSubmit
}: {
  form: FormState;
  setForm: (next: FormState) => void;
  isNew: boolean;
  busy: boolean;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const t = useTranslations("admin.promotionsPage");
  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm({ ...form, [key]: value });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit();
      }}
      className="space-y-4 rounded-xl border border-parchment/10 bg-parchment/5 p-4"
    >
      <h2 className="text-sm font-semibold text-parchment">
        {isNew ? t("formTitleNew") : t("formTitleEdit")}
      </h2>

      <div className="grid gap-4 sm:grid-cols-2">
        <Input
          label={t("fieldCode")}
          value={form.code}
          disabled={!isNew}
          required
          onChange={(e) => set("code", e.target.value.toUpperCase())}
          placeholder="SUMMER20"
        />
        <Input
          label={t("fieldName")}
          value={form.name}
          required
          onChange={(e) => set("name", e.target.value)}
          placeholder={t("fieldNamePlaceholder")}
        />
      </div>

      <fieldset className="space-y-2">
        <legend className="text-sm font-medium text-parchment/80">{t("fieldDiscount")}</legend>
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="radio"
              name="discountKind"
              checked={form.discountKind === "percent"}
              onChange={() => set("discountKind", "percent")}
            />
            {t("discountPercent")}
          </label>
          <Input
            aria-label={t("discountPercent")}
            type="number"
            min={1}
            max={100}
            step="1"
            className="w-28"
            value={form.percentOff}
            disabled={form.discountKind !== "percent"}
            required={form.discountKind === "percent"}
            onChange={(e) => set("percentOff", e.target.value)}
          />
          <label className="flex items-center gap-2 text-sm text-parchment/70">
            <input
              type="radio"
              name="discountKind"
              checked={form.discountKind === "amount"}
              onChange={() => set("discountKind", "amount")}
            />
            {t("discountAmount")}
          </label>
          <Input
            aria-label={t("discountAmount")}
            type="number"
            min={1}
            step="1"
            className="w-28"
            value={form.amountOffUsd}
            disabled={form.discountKind !== "amount"}
            required={form.discountKind === "amount"}
            onChange={(e) => set("amountOffUsd", e.target.value)}
          />
        </div>
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="promo-duration" className="text-sm font-medium text-parchment/80">
            {t("fieldDuration")}
          </label>
          <select
            id="promo-duration"
            value={form.duration}
            onChange={(e) => set("duration", e.target.value as PromotionDuration)}
            className="rounded-lg border border-parchment/20 bg-deep-ink/50 px-3 py-2 text-sm text-parchment"
          >
            <option value="once">{t("duration_once")}</option>
            <option value="repeating">{t("durationRepeatingOption")}</option>
            <option value="forever">{t("duration_forever")}</option>
          </select>
        </div>
        {form.duration === "repeating" && (
          <Input
            label={t("fieldMonths")}
            type="number"
            min={1}
            max={36}
            required
            value={form.durationInMonths}
            onChange={(e) => set("durationInMonths", e.target.value)}
          />
        )}
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset>
          <legend className="text-sm font-medium text-parchment/80">{t("fieldTiers")}</legend>
          <div className="mt-2 flex gap-4">
            {ALL_TIERS.map((tier) => (
              <label key={tier} className="flex items-center gap-2 text-sm text-parchment/70">
                <input
                  type="checkbox"
                  checked={form.allowedTiers.includes(tier)}
                  onChange={() => set("allowedTiers", toggleMember(form.allowedTiers, tier))}
                />
                {t(`tier_${tier}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend className="text-sm font-medium text-parchment/80">{t("fieldPeriods")}</legend>
          <div className="mt-2 flex flex-wrap gap-4">
            {ALL_PERIODS.map((period) => (
              <label key={period} className="flex items-center gap-2 text-sm text-parchment/70">
                <input
                  type="checkbox"
                  checked={form.allowedPeriods.includes(period)}
                  onChange={() => set("allowedPeriods", toggleMember(form.allowedPeriods, period))}
                />
                {t(`period_${period}`)}
              </label>
            ))}
          </div>
        </fieldset>
      </div>

      <div className="grid gap-4 sm:grid-cols-3">
        <Input
          label={t("fieldStartsAt")}
          type="datetime-local"
          value={form.startsAt}
          required
          onChange={(e) => set("startsAt", e.target.value)}
        />
        <Input
          label={t("fieldEndsAt")}
          type="datetime-local"
          value={form.endsAt}
          onChange={(e) => set("endsAt", e.target.value)}
        />
        <Input
          label={t("fieldMaxRedemptions")}
          type="number"
          min={1}
          value={form.maxRedemptions}
          placeholder={t("unlimited")}
          onChange={(e) => set("maxRedemptions", e.target.value)}
        />
      </div>

      <label className="flex items-center gap-2 text-sm text-parchment/70">
        <input
          type="checkbox"
          checked={form.active}
          onChange={(e) => set("active", e.target.checked)}
        />
        {t("fieldActive")}
      </label>

      <p className="text-xs text-parchment/40">{t("termNote")}</p>

      <div className="flex gap-3">
        <Button type="submit" loading={busy}>
          {isNew ? t("create") : t("save")}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={busy}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}

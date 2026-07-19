import type { BillingPeriod, PlanTier } from "@/lib/plans/tier";
import {
  calculateSavingsPercentage,
  getCommitmentMonths,
  getPeriodPricing
} from "@/lib/plans/tier";
import { TIER_LIMITS } from "@/lib/plans/limits";
import {
  concurrentCallsLine,
  imageGenerationLine,
  voiceMinutesLine,
  type UsageCopyLocale
} from "@/lib/plans/usage-copy";
import { CARRIER_REGISTRATION_FEE_CENTS } from "@/lib/plans/carrier-fee";
import {
  formatPriceCents,
  formatPricePerMonth,
  getFirstCycleDiscountDisplay,
  hasFirstCycleDiscount
} from "@/lib/pricing";

/**
 * Single source of truth for how the plan tiers are DISPLAYED — feature
 * bullets, price strings, renewal copy — shared by the public /pricing page
 * and the /onboard plan-selection step so the two can never drift apart.
 * All numbers derive from `tier.ts` / `limits.ts`; nothing is hard-coded here.
 *
 * Locale-aware accessors take an optional `locale` ("en" default) so English
 * output is byte-identical to the pre-i18n copy; the exported constants keep
 * the English values for existing callers.
 */

export type PlanCopyLocale = UsageCopyLocale;

export function getCarrierFeeSetupLine(locale: PlanCopyLocale = "en"): string {
  const fee = formatPriceCents(CARRIER_REGISTRATION_FEE_CENTS);
  return locale === "es"
    ? `Registro de operador único de ${fee} · Garantía de devolución de 30 días`
    : `One-time ${fee} carrier registration · 30-day money-back guarantee`;
}

export const CARRIER_FEE_SETUP_LINE = getCarrierFeeSetupLine();

export type PeriodOption = {
  id: BillingPeriod;
  label: string;
};

const PERIOD_SHORT_LABEL_BY_LOCALE: Record<PlanCopyLocale, Record<BillingPeriod, string>> = {
  en: { biennial: "24 months", annual: "12 months", monthly: "1 month" },
  es: { biennial: "24 meses", annual: "12 meses", monthly: "1 mes" }
};

const PERIOD_SHORT_LABEL: Record<BillingPeriod, string> = PERIOD_SHORT_LABEL_BY_LOCALE.en;

export function getPeriodOptions(locale: PlanCopyLocale = "en"): PeriodOption[] {
  const labels = PERIOD_SHORT_LABEL_BY_LOCALE[locale];
  return [
    { id: "biennial", label: labels.biennial },
    { id: "annual", label: labels.annual },
    { id: "monthly", label: labels.monthly }
  ];
}

export const PERIOD_OPTIONS: PeriodOption[] = getPeriodOptions();

const PERIOD_LABEL_BY_LOCALE: Record<PlanCopyLocale, Record<BillingPeriod, string>> = {
  en: { biennial: "24-month plan", annual: "12-month plan", monthly: "1-month plan" },
  es: { biennial: "plan de 24 meses", annual: "plan de 12 meses", monthly: "plan de 1 mes" }
};

export const PERIOD_LABEL: Record<BillingPeriod, string> = PERIOD_LABEL_BY_LOCALE.en;

const PERIOD_SUMMARY_BY_LOCALE: Record<
  PlanCopyLocale,
  Record<BillingPeriod, { title: string; description: string }>
> = {
  en: {
    biennial: {
      title: "Lock in the strongest rate for 24 months",
      description:
        "The full 24-month total is billed today at the lowest effective monthly rate, the highest long-term discount."
    },
    annual: {
      title: "Commit for 12 months and still save materially",
      description:
        "The full 12-month total is billed today. A balanced option if you want real savings without the 24-month commitment."
    },
    monthly: {
      title: "Stay flexible with month-to-month billing",
      description:
        "No long commitment, with a first-month intro discount before the regular monthly rate renews."
    }
  },
  es: {
    biennial: {
      title: "Asegura la mejor tarifa por 24 meses",
      description:
        "El total de 24 meses se factura hoy a la tarifa mensual efectiva más baja, el mayor descuento a largo plazo."
    },
    annual: {
      title: "Comprométete por 12 meses y aun así ahorra de verdad",
      description:
        "El total de 12 meses se factura hoy. Una opción equilibrada si quieres ahorro real sin el compromiso de 24 meses."
    },
    monthly: {
      title: "Mantén la flexibilidad con facturación mensual",
      description:
        "Sin compromiso largo, con un descuento de introducción el primer mes antes de que renueve la tarifa mensual regular."
    }
  }
};

export function getPeriodSummary(
  period: BillingPeriod,
  locale: PlanCopyLocale = "en"
): { title: string; description: string } {
  return PERIOD_SUMMARY_BY_LOCALE[locale][period];
}

export const PERIOD_SUMMARY: Record<BillingPeriod, { title: string; description: string }> =
  PERIOD_SUMMARY_BY_LOCALE.en;

function buildStarterFeatures(locale: PlanCopyLocale): string[] {
  const es = locale === "es";
  return [
    es ? "Coworker de voz con IA" : "AI voice coworker",
    es
      ? "Número telefónico y dirección de correo dedicados a tu coworker"
      : "Phone number and email address dedicated to your coworker",
    es ? "Acceso por chat a tu coworker" : "Chat access to your coworker",
    es ? "$5/mes de presupuesto de IA para tareas agénticas" : "$5/mo AI budget for agentic tasks",
    es
      ? `Generación de imágenes con IA (${imageGenerationLine("starter", undefined, locale)})`
      : `AI image generation (${imageGenerationLine("starter", undefined, locale)})`,
    es ? "El navegador puede leer páginas web públicas" : "Browser can read public web pages",
    es ? "Integraciones de terceros" : "3rd party integrations",
    es
      ? "Memoria sin pérdida y base de conocimiento expansiva"
      : "Lossless memory and expansive knowledge base",
    es ? "Correos y reserva de citas" : "Emails and appointment booking",
    voiceMinutesLine("starter", undefined, locale),
    `${TIER_LIMITS.starter.smsPerMonth} SMS`,
    concurrentCallsLine(TIER_LIMITS.starter.maxConcurrentCalls, locale)
  ];
}

function buildStandardFeatures(locale: PlanCopyLocale): string[] {
  const es = locale === "es";
  return [
    es ? "Todo lo de Starter, más:" : "Everything in Starter, plus:",
    voiceMinutesLine("standard", undefined, locale),
    `${TIER_LIMITS.standard.smsPerMonth} SMS`,
    concurrentCallsLine(TIER_LIMITS.standard.maxConcurrentCalls, locale),
    es ? "Trae tu propio número telefónico (portabilidad)" : "Bring your own phone number (port-in)",
    es ? "Zapier: conecta 8,000+ apps" : "Zapier: connect 8,000+ apps",
    es ? "Envía textos durante llamadas" : "Send texts during calls",
    es
      ? "Auto-texto a quien llama cuando no se puede contestar"
      : "Auto-text callers when a call can't be answered",
    es
      ? "Textos programados y plantillas de mensajes guardadas"
      : "Scheduled texts & saved message templates",
    es
      ? "Resúmenes de llamadas y sentimiento con IA en tu panel"
      : "AI call summaries & caller sentiment on your dashboard",
    es
      ? "Panel de analítica: tendencias de llamadas, horas pico y tasa de respuesta"
      : "Analytics dashboard: call trends, peak hours & answer rate",
    es
      ? "Alertas cuando se rechazan llamadas (picos de llamadas perdidas)"
      : "Alerts when callers are turned away (missed-call spikes)",
    es ? "Transferencias de llamada con contexto" : "Warm handoff call transfers",
    es
      ? "$10/mes de presupuesto de IA para tareas agénticas, antes del respaldo con modelo gratuito"
      : "$10/mo AI budget for agentic tasks, before free model fallback",
    es
      ? `Generación de imágenes con IA (${imageGenerationLine("standard", undefined, locale)})`
      : `AI image generation (${imageGenerationLine("standard", undefined, locale)})`,
    es ? "Actualizaciones de configuración y entrenamiento" : "Configuration and training updates",
    es ? "Soporte prioritario por correo y mantenimiento" : "Priority email support & maintenance",
    es
      ? "Habilidades completas de navegador: opera sitios web como una persona"
      : "Full browser skills: operates websites like a person"
  ];
}

/**
 * Every bullet here is SHIPPED product (enterprise feature buildout,
 * Phases 1–6) or an explicit operational commitment — this list is what
 * sales quotes, so keep it honest:
 *  - team roles + access control: business_members + authz matrix (Phase 1)
 *  - multi-business agency dashboard: active-business switcher (Phase 2)
 *  - white-label dashboard: businesses.branding (Phase 3)
 *  - designated models + voice picker: enterprise_models (Phase 4;
 *    prebuilt professional voices, not cloning)
 *  - custom compliance modules: compliance_module (Phase 5)
 *  - SLA + dedicated support: permanent priority window + support card
 *    (Phase 6)
 */
function buildEnterpriseFeatures(locale: PlanCopyLocale): string[] {
  const es = locale === "es";
  return [
    es ? "Todo lo de Starter y Standard, más:" : "Everything in Starter and Standard, plus:",
    es
      ? "Panel de agencia multi-negocio con un solo inicio de sesión"
      : "Multi-business agency dashboard with one login",
    es ? "Acceso de equipo con roles (gerentes y personal)" : "Team access with roles (managers & staff)",
    es
      ? "Panel white-label (tu nombre, logo y colores)"
      : "White-label dashboard (your name, logo, colors)",
    es
      ? "SLA + soporte dedicado, prioridad siempre activa"
      : "SLA + dedicated support, priority always on",
    es ? "Módulos de cumplimiento a medida" : "Custom compliance modules",
    es
      ? "Mensajería RCS de marca (tu propio remitente verificado por Google)"
      : "Branded RCS messaging (your own Google-verified sender)",
    es ? "Modelos de razonamiento designados" : "Designated reasoning models",
    es ? "Elección de voces profesionales" : "Choice of professional voices",
    es
      ? "Límites de uso personalizados y personalización de llamadas"
      : "Custom usage limits and call customization",
    es
      ? "Despliegue de hardware independiente y residencia de datos"
      : "Independent hardware deployment & data residency",
    es ? "Revisiones de estrategia trimestrales" : "Quarterly strategy reviews",
    es ? "Acceso prioritario a nuevas funciones" : "Priority access to new features"
  ];
}

export const STARTER_FEATURES: string[] = buildStarterFeatures("en");
export const STANDARD_FEATURES: string[] = buildStandardFeatures("en");
export const ENTERPRISE_FEATURES: string[] = buildEnterpriseFeatures("en");

export type TierCard = {
  id: PlanTier;
  name: string;
  price: string;
  originalPrice?: string;
  renewal?: string;
  total?: string;
  introOffer?: string;
  setup: string;
  features: string[];
  cta: string;
  highlight: boolean;
  badge?: string;
};

function getTierPricingDisplay(tier: Exclude<PlanTier, "enterprise">, period: BillingPeriod) {
  const pricing = getPeriodPricing(tier, period);
  const months = getCommitmentMonths(period);
  return {
    monthly: formatPricePerMonth(pricing.monthlyCents),
    renewalRate: formatPricePerMonth(pricing.renewalMonthlyCents),
    total: formatPriceCents(pricing.monthlyCents * months),
    hasIntroDiscount: hasFirstCycleDiscount(tier, period),
    firstCycleDiscount: getFirstCycleDiscountDisplay(tier, period)
  };
}

function buildPaidTierCard(
  tier: Exclude<PlanTier, "enterprise">,
  period: BillingPeriod,
  locale: PlanCopyLocale
): Omit<TierCard, "name" | "features" | "cta" | "highlight" | "badge"> {
  const price = getTierPricingDisplay(tier, period);
  const es = locale === "es";
  const shortLabel = PERIOD_SHORT_LABEL_BY_LOCALE[locale][period];
  const periodLabel = PERIOD_LABEL_BY_LOCALE[locale][period];
  return {
    id: tier,
    price: price.monthly,
    originalPrice: price.hasIntroDiscount ? price.renewalRate : undefined,
    renewal:
      period !== "monthly"
        ? es
          ? `Renueva a ${price.renewalRate} después de ${shortLabel}`
          : `Renews at ${price.renewalRate} after ${shortLabel}`
        : es
          ? `Renueva a ${price.renewalRate}`
          : `Renews at ${price.renewalRate}`,
    total:
      period !== "monthly"
        ? es
          ? `${price.total} facturado hoy por el ${periodLabel}`
          : `${price.total} billed today for the ${periodLabel}`
        : undefined,
    // Only the monthly plan carries a first-cycle intro discount today, so
    // `hasIntroDiscount` alone decides — no separate period check needed.
    introOffer: price.hasIntroDiscount
      ? es
        ? `El descuento del primer mes te ahorra ${price.firstCycleDiscount}`
        : `First month discount saves ${price.firstCycleDiscount}`
      : undefined,
    setup: getCarrierFeeSetupLine(locale)
  };
}

export function getTierCards(period: BillingPeriod, locale: PlanCopyLocale = "en"): TierCard[] {
  const es = locale === "es";
  return [
    {
      ...buildPaidTierCard("starter", period, locale),
      name: "Starter",
      features: buildStarterFeatures(locale),
      cta: es ? "Elegir Starter" : "Choose Starter",
      highlight: false,
      badge: period === "biennial" ? (es ? "Mejor valor" : "Best Value") : undefined
    },
    {
      ...buildPaidTierCard("standard", period, locale),
      name: "Standard",
      features: buildStandardFeatures(locale),
      cta: es ? "Elegir Standard" : "Choose Standard",
      highlight: true,
      badge: es ? "Más popular" : "Most Popular"
    },
    {
      id: "enterprise",
      name: "Enterprise",
      price: es ? "Personalizado" : "Custom",
      renewal: undefined,
      total: undefined,
      setup: es ? "Contáctanos para precios" : "Contact us for pricing",
      features: buildEnterpriseFeatures(locale),
      cta: es ? "Contactar ventas" : "Contact Sales",
      highlight: false,
      badge: undefined
    }
  ];
}

export type TierSavings = Record<"biennial" | "annual", number>;

export function getTierSavings(tier: Exclude<PlanTier, "enterprise">): TierSavings {
  return {
    biennial: calculateSavingsPercentage(tier, "biennial"),
    annual: calculateSavingsPercentage(tier, "annual")
  };
}

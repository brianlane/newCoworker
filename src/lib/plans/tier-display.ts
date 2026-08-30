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
import { AI_BUDGET_MONTHLY_CENTS } from "@/lib/plans/ai-budget";
import {
  formatPriceCents,
  formatPricePerMonth,
  getFirstCycleDiscountDisplay,
  hasFirstCycleDiscount
} from "@/lib/pricing";

/**
 * Single source of truth for how the plan tiers are DISPLAYED, feature
 * bullets, price strings, renewal copy, shared by the public /pricing page
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

/**
 * "$5/mo" / "$5/mes" for the included agentic-AI budget. The bullets, the
 * highlight strip, and the comparison table all read this, so the three can
 * never disagree about the number.
 */
function aiBudgetPerMonth(
  tier: Exclude<PlanTier, "enterprise">,
  locale: PlanCopyLocale
): string {
  return `${formatPriceCents(AI_BUDGET_MONTHLY_CENTS[tier])}${locale === "es" ? "/mes" : "/mo"}`;
}

function buildStarterFeatures(locale: PlanCopyLocale): string[] {
  const es = locale === "es";
  return [
    es ? "Coworker de voz con IA" : "AI voice coworker",
    es
      ? "Número telefónico y dirección de correo dedicados a tu coworker"
      : "Phone number and email address dedicated to your coworker",
    es ? "Acceso por chat a tu coworker" : "Chat access to your coworker",
    es
      ? `${aiBudgetPerMonth("starter", locale)} de presupuesto de IA para tareas agénticas`
      : `${aiBudgetPerMonth("starter", locale)} AI budget for agentic tasks`,
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
    es
      ? "Soporte completo de webhooks: anuncios de leads de Meta, comentarios y DMs de Instagram, y disparadores por REST API"
      : "Full webhook support: Meta lead ads, Instagram comments & DMs, and REST API triggers",
    es
      ? "Prospección: tu coworker encuentra negocios locales y les escribe"
      : "Prospecting: your coworker finds local businesses and emails them",
    es
      ? "Traductor en vivo: tu coworker interpreta tras transferir la llamada"
      : "Live translator: your coworker interprets after transferring a call",
    es
      ? "Respuestas automáticas en Messenger, Instagram y WhatsApp"
      : "Automatic replies on Messenger, Instagram, and WhatsApp",
    es
      ? "Campañas de correo e Instagram programadas"
      : "Scheduled email campaigns and Instagram posts",
    es
      ? "Llamadas de IA salientes: tu coworker puede llamar a leads por ti"
      : "Outbound AI calls: your coworker can call leads for you",
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
      ? `${aiBudgetPerMonth("standard", locale)} de presupuesto de IA para tareas agénticas, antes del respaldo con modelo gratuito`
      : `${aiBudgetPerMonth("standard", locale)} AI budget for agentic tasks, before free model fallback`,
    es
      ? `Generación de imágenes con IA (${imageGenerationLine("standard", undefined, locale)})`
      : `AI image generation (${imageGenerationLine("standard", undefined, locale)})`,
    es ? "Actualizaciones de configuración y entrenamiento" : "Configuration and training updates",
    es ? "Soporte prioritario por correo y mantenimiento" : "Priority email support & maintenance",
    es
      ? "Habilidades completas de navegador: opera sitios web como una persona"
      : "Full browser skills: operates websites like a person",
    es
      ? "Chat de equipo: Slack, Telegram, Microsoft Teams y Google Chat, con aprobaciones desde Slack"
      : "Team chat: Slack, Telegram, Microsoft Teams, and Google Chat, with approvals from Slack",
    es
      ? "Notificaciones push: instala el panel en tu teléfono y recibe alertas urgentes al instante"
      : "Push notifications: install the dashboard on your phone for instant urgent alerts"
  ];
}

/**
 * Every bullet here is SHIPPED product (enterprise feature buildout,
 * Phases 1–6) or an explicit operational commitment, this list is what
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

const FEATURES_BY_TIER: Record<PlanTier, (locale: PlanCopyLocale) => string[]> = {
  starter: buildStarterFeatures,
  standard: buildStandardFeatures,
  enterprise: buildEnterpriseFeatures
};

/**
 * Selects bullets out of a tier's full feature array by position.
 *
 * Positions rather than substrings because the English and Spanish arrays
 * are built from the same literal in the same order, so one set of indices
 * picks the matching bullet in both locales without a second table of
 * Spanish matchers to keep in sync. Out-of-range throws rather than
 * returning undefined, so a bullet deleted from the array fails the test
 * suite instead of rendering a blank line on the pricing page.
 *
 * Exported so that guard can be tested directly: it is the thing standing
 * between a reordered feature array and a card quietly rendering blanks.
 */
export function pickFeatures(all: string[], indices: number[]): string[] {
  return indices.map((i) => {
    const feature = all[i];
    if (feature === undefined) {
      throw new Error(`pickFeatures: index ${i} is out of range (length ${all.length})`);
    }
    return feature;
  });
}

/**
 * Which bullets the CARD shows. The full array stays the complete record,
 * read by the comparison table and by `STANDARD_FEATURES`; the card shows
 * only what differentiates the tier from the one below it.
 *
 * This is deliberately NOT a truncation with a "show more" toggle. Baymard's
 * testing found users overlook those links entirely and conclude the feature
 * does not exist, so the full list lives in the always-open comparison table
 * instead, and `tests/pricing-comparison.test.ts` proves every bullet has a
 * row there.
 */
const CARD_FEATURE_INDICES: Record<PlanTier, number[]> = {
  // The three headline inclusions first (voice coworker, dedicated number and
  // email, booking), then the two Starter-specific limits. Standard and
  // Enterprise do not repeat these because their "Everything in Starter,
  // plus:" lead-in already covers them.
  starter: [0, 1, 8, 5, 4],
  // Outbound calls, prospecting, webhooks, browser skills, Zapier, call
  // summaries: the six that most obviously are not on Starter.
  standard: [11, 7, 6, 23, 5, 15],
  // Agency dashboard, team roles, white-label, SLA, branded RCS.
  enterprise: [1, 2, 3, 4, 6]
};

/** The short, card-facing subset of a tier's bullets. */
export function getCardFeatures(tier: PlanTier, locale: PlanCopyLocale = "en"): string[] {
  return pickFeatures(FEATURES_BY_TIER[tier](locale), CARD_FEATURE_INDICES[tier]);
}

/**
 * The "Everything in Starter, plus:" line, which is the highest-leverage
 * thing on the card: it lets a tier that genuinely includes far more get
 * away with showing six bullets instead of twenty-four. It was already the
 * first element of the array, just rendered as a checkmark bullet alongside
 * real features, where it read as one more item rather than as the frame for
 * all of them.
 */
export function getTierLeadIn(tier: PlanTier, locale: PlanCopyLocale = "en"): string | undefined {
  if (tier === "starter") return undefined;
  return FEATURES_BY_TIER[tier](locale)[0];
}

export type TierHighlight = { label: string; value: string };

const HIGHLIGHT_LABELS_BY_LOCALE: Record<
  PlanCopyLocale,
  { voice: string; texts: string; concurrency: string; aiBudget: string }
> = {
  en: {
    voice: "Voice minutes",
    texts: "Texts / month",
    concurrency: "Calls at once",
    aiBudget: "AI budget"
  },
  es: {
    voice: "Minutos de voz",
    texts: "Textos / mes",
    concurrency: "Llamadas a la vez",
    aiBudget: "Presupuesto de IA"
  }
};

const HIGHLIGHT_NUMBER_FORMAT = new Intl.NumberFormat("en-US");

/**
 * The four metered numbers, in the same four slots on every card, so the
 * capacity difference between tiers is readable side by side instead of
 * buried at positions 10 through 12 of a bullet list.
 *
 * Enterprise is quoted per deployment, so all four read "Custom", matching
 * what its price and the comparison table already say.
 */
export function buildTierHighlights(
  tier: PlanTier,
  locale: PlanCopyLocale = "en"
): TierHighlight[] {
  const labels = HIGHLIGHT_LABELS_BY_LOCALE[locale];
  if (tier === "enterprise") {
    // "A medida", not the "Personalizado" the price and the table use: the
    // strip cell is a quarter of a card wide and the longer word overflowed
    // it. Same meaning, and the fuller word still carries the price itself.
    const custom = locale === "es" ? "A medida" : "Custom";
    return [
      { label: labels.voice, value: custom },
      { label: labels.texts, value: custom },
      { label: labels.concurrency, value: custom },
      { label: labels.aiBudget, value: custom }
    ];
  }
  const limits = TIER_LIMITS[tier];
  return [
    {
      label: labels.voice,
      value: HIGHLIGHT_NUMBER_FORMAT.format(
        Math.round(limits.voiceIncludedSecondsPerStripePeriod / 60)
      )
    },
    { label: labels.texts, value: HIGHLIGHT_NUMBER_FORMAT.format(limits.smsPerMonth) },
    {
      label: labels.concurrency,
      value: HIGHLIGHT_NUMBER_FORMAT.format(limits.maxConcurrentCalls)
    },
    { label: labels.aiBudget, value: aiBudgetPerMonth(tier, locale) }
  ];
}

/**
 * Why Standard costs 10x Starter, in one line: it carries 10x the minutes,
 * 33x the texts, and 10x the concurrency. Every multiplier is computed from
 * `TIER_LIMITS`, so raising a cap can never leave a stale "33x" on the page.
 */
export function buildStandardMultiplierLine(locale: PlanCopyLocale = "en"): string {
  const starter = TIER_LIMITS.starter;
  const standard = TIER_LIMITS.standard;
  const voice = Math.round(
    standard.voiceIncludedSecondsPerStripePeriod / starter.voiceIncludedSecondsPerStripePeriod
  );
  const texts = Math.round(standard.smsPerMonth / starter.smsPerMonth);
  const calls = Math.round(standard.maxConcurrentCalls / starter.maxConcurrentCalls);
  return locale === "es"
    ? `${voice}x los minutos, ${texts}x los textos, ${calls}x las llamadas a la vez`
    : `${voice}x the minutes, ${texts}x the texts, ${calls}x the calls at once`;
}

/**
 * Starter carries only two bullets the shared band does not already cover,
 * which leaves real estate under its list that no honest feature can fill.
 * Rather than pad the card back out with things every tier includes (the
 * thing that made the old design unreadable), that space names the upgrade
 * path, using the same computed multipliers as Standard's own line so the
 * two can never disagree.
 */
export function buildStarterUpgradeNote(locale: PlanCopyLocale = "en"): string {
  const voice = Math.round(
    TIER_LIMITS.standard.voiceIncludedSecondsPerStripePeriod /
      TIER_LIMITS.starter.voiceIncludedSecondsPerStripePeriod
  );
  const texts = Math.round(TIER_LIMITS.standard.smsPerMonth / TIER_LIMITS.starter.smsPerMonth);
  return locale === "es"
    ? `¿Se te queda corto Starter? Standard suma ${voice}x los minutos y ${texts}x los textos, más llamadas salientes y prospección.`
    : `Outgrowing Starter? Standard adds ${voice}x the minutes and ${texts}x the texts, plus outbound calling and prospecting.`;
}

const TAGLINE_BY_LOCALE: Record<PlanCopyLocale, Record<PlanTier, string>> = {
  en: {
    starter: "For a solo owner who needs the phone answered.",
    standard: "For a team that wants its coworker chasing leads too.",
    enterprise: "For agencies and multi-location operators."
  },
  es: {
    starter: "Para un dueño solo que necesita que contesten el teléfono.",
    standard: "Para un equipo que también quiere a su coworker buscando clientes.",
    enterprise: "Para agencias y operadores con varias ubicaciones."
  }
};

export type TierCard = {
  id: PlanTier;
  name: string;
  price: string;
  originalPrice?: string;
  renewal?: string;
  total?: string;
  introOffer?: string;
  setup: string;
  /** Complete record for this tier: the comparison table and llms.txt read this. */
  features: string[];
  /** The short differentiating subset the card actually renders. */
  cardFeatures: string[];
  /** "Everything in Starter, plus:", rendered as a frame rather than a bullet. */
  leadIn?: string;
  /** Who the tier is for, one line, so positioning is not inferred from bullets. */
  tagline: string;
  /** The four metered numbers, same slots on every card. */
  highlights: TierHighlight[];
  /** Standard only: the computed line that justifies the 10x price step. */
  multiplierLine?: string;
  /** Starter only: what upgrading buys, shown where its bullets run out. */
  upgradeNote?: string;
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
): Omit<
  TierCard,
  | "name"
  | "features"
  | "cardFeatures"
  | "leadIn"
  | "tagline"
  | "highlights"
  | "multiplierLine"
  | "upgradeNote"
  | "cta"
  | "highlight"
  | "badge"
> {
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
    // `hasIntroDiscount` alone decides, no separate period check needed.
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
      cardFeatures: getCardFeatures("starter", locale),
      leadIn: getTierLeadIn("starter", locale),
      tagline: TAGLINE_BY_LOCALE[locale].starter,
      highlights: buildTierHighlights("starter", locale),
      upgradeNote: buildStarterUpgradeNote(locale),
      cta: es ? "Elegir Starter" : "Choose Starter",
      highlight: false,
      badge: period === "biennial" ? (es ? "Mejor valor" : "Best Value") : undefined
    },
    {
      ...buildPaidTierCard("standard", period, locale),
      name: "Standard",
      features: buildStandardFeatures(locale),
      cardFeatures: getCardFeatures("standard", locale),
      leadIn: getTierLeadIn("standard", locale),
      tagline: TAGLINE_BY_LOCALE[locale].standard,
      highlights: buildTierHighlights("standard", locale),
      multiplierLine: buildStandardMultiplierLine(locale),
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
      cardFeatures: getCardFeatures("enterprise", locale),
      leadIn: getTierLeadIn("enterprise", locale),
      tagline: TAGLINE_BY_LOCALE[locale].enterprise,
      highlights: buildTierHighlights("enterprise", locale),
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

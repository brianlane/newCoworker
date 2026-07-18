/**
 * White-glove onboarding packages (fleet economics plan, Phase C5).
 *
 * Two one-time packages, resolved in Phase 0 decision #5:
 *   - setup    $750  — guided setup, number porting, and a live training call.
 *   - buildout $2,000 — full AiFlow buildout plus a 30-day priority line.
 *
 * Purchasing either package flips the business's priority call/video support
 * window on (`businesses.priority_support_until` = purchase + 30 days).
 * Without it, Starter/Standard support is email-only.
 *
 * Both are charged as `mode=payment` Stripe Checkout Sessions with inline
 * `price_data` (no per-environment Stripe product/price setup needed — the
 * amounts here ARE the source of truth). The Stripe webhook records the
 * purchase on `checkout.session.completed` with
 * `metadata.checkoutKind === "white_glove_package"`.
 */

export const WHITE_GLOVE_PACKAGE_IDS = ["setup", "buildout"] as const;

export type WhiteGlovePackageId = (typeof WHITE_GLOVE_PACKAGE_IDS)[number];

export type WhiteGlovePackage = {
  id: WhiteGlovePackageId;
  name: string;
  priceCents: number;
  priceUsd: number;
  /** One-line pitch for cards and checkout line items. */
  description: string;
  /** Bullet list for the marketing/billing cards. */
  features: string[];
};

/** Days of priority call/video support granted by either package. */
export const WHITE_GLOVE_PRIORITY_SUPPORT_DAYS = 30;

const PACKAGES: Record<WhiteGlovePackageId, WhiteGlovePackage> = {
  setup: {
    id: "setup",
    name: "White-glove setup",
    priceCents: 75_000,
    priceUsd: 750,
    description: "We set everything up with you, port your number, and train you live.",
    features: [
      "Guided workspace setup with a specialist",
      "Phone number porting handled for you",
      "Live 1:1 training call",
      "30 days of priority call & video support"
    ]
  },
  buildout: {
    id: "buildout",
    name: "White-glove buildout",
    priceCents: 200_000,
    priceUsd: 2000,
    description: "Everything in setup, plus a full custom AiFlow buildout for your business.",
    features: [
      "Everything in White-glove setup",
      "Full custom AiFlow buildout for your workflows",
      "Dedicated specialist through launch",
      "30-day priority line (call & video)"
    ]
  }
};

/**
 * Spanish DISPLAY copy for the marketing/billing cards. Checkout keeps the
 * English package objects (names/descriptions become Stripe line items and
 * webhook records), so only card rendering passes a locale.
 */
const PACKAGES_ES: Record<WhiteGlovePackageId, Pick<WhiteGlovePackage, "name" | "description" | "features">> = {
  setup: {
    name: "White-glove setup",
    description: "Configuramos todo contigo, portamos tu número y te entrenamos en vivo.",
    features: [
      "Configuración guiada del espacio con un especialista",
      "Portabilidad del número telefónico gestionada por nosotros",
      "Llamada de entrenamiento 1:1 en vivo",
      "30 días de soporte prioritario por llamada y video"
    ]
  },
  buildout: {
    name: "White-glove buildout",
    description: "Todo lo del setup, más una construcción completa de AiFlows a medida para tu negocio.",
    features: [
      "Todo lo de White-glove setup",
      "Construcción completa de AiFlows a medida para tus flujos",
      "Especialista dedicado hasta el lanzamiento",
      "Línea prioritaria de 30 días (llamada y video)"
    ]
  }
};

export function listWhiteGlovePackages(locale: "en" | "es" = "en"): WhiteGlovePackage[] {
  return WHITE_GLOVE_PACKAGE_IDS.map((id) =>
    locale === "es" ? { ...PACKAGES[id], ...PACKAGES_ES[id] } : PACKAGES[id]
  );
}

/** Null for unknown ids — API boundaries fail closed. */
export function getWhiteGlovePackage(id: string): WhiteGlovePackage | null {
  if (!WHITE_GLOVE_PACKAGE_IDS.includes(id as WhiteGlovePackageId)) return null;
  return PACKAGES[id as WhiteGlovePackageId];
}

/**
 * Priority support window end for a purchase at `purchasedAt`: 30 days out,
 * for either package.
 */
export function prioritySupportUntil(purchasedAt: Date): Date {
  return new Date(
    purchasedAt.getTime() + WHITE_GLOVE_PRIORITY_SUPPORT_DAYS * 24 * 60 * 60 * 1000
  );
}

/** True when the business's priority call/video support window is open. */
export function hasPrioritySupport(
  prioritySupportUntilIso: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (!prioritySupportUntilIso) return false;
  const until = new Date(prioritySupportUntilIso);
  if (Number.isNaN(until.getTime())) return false;
  return until.getTime() > now.getTime();
}

/**
 * Tier-aware priority support: ENTERPRISE tenants hold a PERMANENT priority
 * call/video window (part of the "SLA + dedicated support" plan bullet);
 * everyone else falls back to the white-glove purchase window.
 */
export function hasPrioritySupportForTier(
  tier: string | null | undefined,
  prioritySupportUntilIso: string | null | undefined,
  now: Date = new Date()
): boolean {
  if (tier === "enterprise") return true;
  return hasPrioritySupport(prioritySupportUntilIso, now);
}

/**
 * Scheduling link the confirmation email/banner points at. Optional — when
 * unset the copy falls back to "reply to this email to schedule".
 */
export function getWhiteGloveBookingUrl(): string | null {
  const raw = process.env.WHITE_GLOVE_BOOKING_URL;
  if (!raw || raw.trim().length === 0) return null;
  return raw.trim();
}

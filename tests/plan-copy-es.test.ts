/**
 * Spanish display variants of the plan/usage copy helpers. English is the
 * default locale everywhere — these tests pin the es output AND that the
 * en output is untouched when no locale is passed (zero-change guarantee).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as limitsModule from "@/lib/plans/limits";
import {
  concurrentCallsLine,
  imageGenerationLine,
  smsMonthlyLine,
  voiceMinutesLine
} from "@/lib/plans/usage-copy";
import { getPasswordRules, getPasswordValidationError } from "@/lib/password";
import { listWhiteGlovePackages } from "@/lib/plans/white-glove";
import {
  getCarrierFeeSetupLine,
  getPeriodOptions,
  getPeriodSummary,
  getTierCards,
  CARRIER_FEE_SETUP_LINE,
  PERIOD_OPTIONS,
  PERIOD_SUMMARY
} from "@/lib/plans/tier-display";

const { TIER_LIMITS } = limitsModule;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("usage-copy Spanish variants", () => {
  it("voiceMinutesLine renders Spanish minute counts", () => {
    expect(voiceMinutesLine("starter", undefined, "es")).toBe("25 minutos de voz");
    expect(voiceMinutesLine("standard", undefined, "es")).toBe("250 minutos de voz");
  });

  it("voiceMinutesLine edge branches in Spanish", () => {
    const spy = vi.spyOn(limitsModule, "getTierLimits");
    spy
      .mockReturnValueOnce({ ...TIER_LIMITS.enterprise, voiceIncludedSecondsPerStripePeriod: Infinity })
      .mockReturnValueOnce({ ...TIER_LIMITS.enterprise, voiceIncludedSecondsPerStripePeriod: 15_000_000 })
      .mockReturnValueOnce({ ...TIER_LIMITS.starter, voiceIncludedSecondsPerStripePeriod: 0 })
      .mockReturnValueOnce({ ...TIER_LIMITS.starter, voiceIncludedSecondsPerStripePeriod: 30 });
    expect(voiceMinutesLine("enterprise", undefined, "es")).toBe("Voz ilimitada");
    expect(voiceMinutesLine("enterprise", undefined, "es")).toBe("Voz incluida personalizada");
    expect(voiceMinutesLine("starter", undefined, "es")).toBe("Sin voz incluida");
    expect(voiceMinutesLine("starter", undefined, "es")).toBe("Menos de 1 minuto de voz");
  });

  it("smsMonthlyLine renders Spanish caps and unlimited copy", () => {
    expect(smsMonthlyLine("starter", undefined, "es")).toBe("100 SMS / mes");
    expect(smsMonthlyLine("enterprise", undefined, "es")).toBe("SMS ilimitados / mes");
  });

  it("concurrentCallsLine renders Spanish singular/plural/custom", () => {
    expect(concurrentCallsLine(1, "es")).toBe("1 llamada simultánea");
    expect(concurrentCallsLine(10, "es")).toBe("Hasta 10 llamadas simultáneas");
    expect(concurrentCallsLine(Number.POSITIVE_INFINITY, "es")).toBe(
      "Llamadas simultáneas personalizadas"
    );
  });

  it("imageGenerationLine renders Spanish", () => {
    expect(imageGenerationLine("starter", undefined, "es")).toBe("3 por conversación");
  });
});

describe("password rules Spanish variants", () => {
  it("getPasswordRules returns the locale's rule list (en default unchanged)", () => {
    expect(getPasswordRules()).toEqual([
      "At least 8 characters",
      "At least 1 uppercase letter",
      "At least 1 number",
      "Must match the confirmation field"
    ]);
    expect(getPasswordRules("es")[0]).toBe("Al menos 8 caracteres");
  });

  it("getPasswordValidationError localizes each failure", () => {
    expect(getPasswordValidationError("short", "es")).toBe(
      "La contraseña debe tener al menos 8 caracteres"
    );
    expect(getPasswordValidationError("abcdefgh1", "es")).toBe(
      "La contraseña debe incluir al menos 1 letra mayúscula"
    );
    expect(getPasswordValidationError("Abcdefghi", "es")).toBe(
      "La contraseña debe incluir al menos 1 número"
    );
    expect(getPasswordValidationError("Abcdefg1", "es")).toBeNull();
  });
});

describe("white-glove Spanish display copy", () => {
  it("listWhiteGlovePackages('es') localizes descriptions but keeps ids/prices", () => {
    const [setup, buildout] = listWhiteGlovePackages("es");
    expect(setup.id).toBe("setup");
    expect(setup.priceUsd).toBe(750);
    expect(setup.description).toContain("Configuramos todo contigo");
    expect(buildout.features[0]).toBe("Todo lo de White-glove setup");
  });

  it("default listing stays English (checkout line items unchanged)", () => {
    const [setup] = listWhiteGlovePackages();
    expect(setup.description).toBe(
      "We set everything up with you, port your number, and train you live."
    );
  });
});

describe("tier-display Spanish variants", () => {
  it("period options and summaries localize; English constants unchanged", () => {
    expect(getPeriodOptions("es").map((o) => o.label)).toEqual(["24 meses", "12 meses", "1 mes"]);
    expect(PERIOD_OPTIONS.map((o) => o.label)).toEqual(["24 months", "12 months", "1 month"]);
    expect(getPeriodSummary("biennial", "es").title).toBe(
      "Asegura la mejor tarifa por 24 meses"
    );
    expect(getPeriodSummary("annual", "es").title).toContain("12 meses");
    expect(getPeriodSummary("monthly", "es").title).toContain("mensual");
    expect(getPeriodSummary("biennial").title).toBe(PERIOD_SUMMARY.biennial.title);
  });

  it("carrier fee setup line localizes; English constant unchanged", () => {
    expect(getCarrierFeeSetupLine("es")).toContain("Garantía de devolución de 30 días");
    expect(getCarrierFeeSetupLine()).toBe(CARRIER_FEE_SETUP_LINE);
    expect(CARRIER_FEE_SETUP_LINE).toContain("30-day money-back guarantee");
  });

  it("getTierCards('biennial', 'es') localizes card copy", () => {
    const [starter, standard, enterprise] = getTierCards("biennial", "es");
    expect(starter.cta).toBe("Elegir Starter");
    expect(starter.badge).toBe("Mejor valor");
    expect(starter.renewal).toContain("Renueva a");
    expect(starter.total).toContain("facturado hoy por el plan de 24 meses");
    expect(starter.features).toContain("Coworker de voz con IA");
    expect(standard.badge).toBe("Más popular");
    expect(standard.features[0]).toBe("Todo lo de Starter, más:");
    expect(enterprise.price).toBe("Personalizado");
    expect(enterprise.cta).toBe("Contactar ventas");
    expect(enterprise.setup).toBe("Contáctanos para precios");
    expect(enterprise.features).toContain("Revisiones de estrategia trimestrales");
  });

  it("getTierCards('monthly', 'es') localizes the intro-discount and renewal lines", () => {
    const [starter] = getTierCards("monthly", "es");
    expect(starter.renewal).toMatch(/^Renueva a /);
    expect(starter.total).toBeUndefined();
    if (starter.introOffer) {
      expect(starter.introOffer).toContain("El descuento del primer mes te ahorra");
    }
  });

  it("getTierCards defaults to English output identical to pre-i18n copy", () => {
    const [starter] = getTierCards("biennial");
    expect(starter.cta).toBe("Choose Starter");
    expect(starter.badge).toBe("Best Value");
    expect(starter.features).toContain("AI voice coworker");
  });
});

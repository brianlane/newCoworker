/**
 * Spanish variants of the owner-facing transactional emails. English output
 * stays the default (no locale passed), pinned by the existing template
 * tests, so these only assert the es branches and the shared helpers.
 */
import { describe, expect, it } from "vitest";

import { buildCancelConfirmationEmail } from "@/lib/email/templates/cancel-confirmation";
import { buildRefundIssuedEmail } from "@/lib/email/templates/refund-issued";
import { buildEmailVerificationMessage } from "@/lib/email/templates/email-verification";
import { buildTeamInviteEmail } from "@/lib/email/templates/team-invite";
import { buildWhiteGloveOfferEmail } from "@/lib/email/templates/white-glove-offer";
import { buildWhiteGloveIntakeEmail } from "@/lib/email/templates/white-glove-intake";
import { buildWhiteGloveConfirmationEmail } from "@/lib/email/templates/white-glove-confirmation";
import { buildBookingOwnerAlert } from "@/lib/email/templates/booking-owner-alert";
import { emailDate, fmtEmail } from "@/lib/i18n/email-copy";
import { whatsappTemplateStateKey } from "@/lib/meta/client";

const SITE = "https://www.newcoworker.com";
const TO = "owner@example.com";

describe("fmtEmail", () => {
  it("interpolates known vars and leaves unknown placeholders literal", () => {
    expect(fmtEmail("Hi {name}, {missing}!", { name: "Ana" })).toBe("Hi Ana, {missing}!");
  });
});

describe("whatsappTemplateStateKey", () => {
  it("keeps the bare name for en_US and suffixes other languages", () => {
    expect(whatsappTemplateStateKey("nc_owner_alert", "en_US")).toBe("nc_owner_alert");
    expect(whatsappTemplateStateKey("nc_owner_alert", "es")).toBe("nc_owner_alert:es");
  });
});

describe("emailDate", () => {
  it("renders locale-tagged long dates (with and without a zone)", () => {
    const date = new Date("2026-08-15T12:00:00Z");
    expect(emailDate(date, "en", "UTC")).toBe("August 15, 2026");
    expect(emailDate(date, "es", "UTC")).toContain("agosto");
    expect(emailDate(date, "en")).toContain("2026");
  });
});

describe("Spanish email variants", () => {
  it("cancel-confirmation localizes every reason branch", () => {
    const base = {
      effectiveAt: "2026-09-01T00:00:00Z",
      graceEndsAt: "2026-10-01T00:00:00Z",
      recipientEmail: TO,
      siteUrl: SITE,
      timeZone: "UTC",
      locale: "es" as const
    };
    const periodEnd = buildCancelConfirmationEmail({ ...base, reason: "user_period_end" });
    expect(periodEnd.subject).toBe("Tu suscripción de NewCoworker está programada para terminar");
    expect(periodEnd.text).toContain("septiembre");

    const payment = buildCancelConfirmationEmail({ ...base, reason: "payment_failed" });
    expect(payment.subject).toContain("pausada");
    expect(payment.text).toContain("octubre");

    const noGrace = buildCancelConfirmationEmail({
      ...base,
      reason: "payment_failed",
      graceEndsAt: null
    });
    expect(noGrace.text).toContain("dentro de 30 días");

    const upgrade = buildCancelConfirmationEmail({ ...base, reason: "upgrade_switch" });
    expect(upgrade.subject).toContain("cambio de plan");

    const admin = buildCancelConfirmationEmail({ ...base, reason: "admin_force" });
    expect(admin.subject).toContain("cerrada");
    expect(admin.text).toContain("administrador de NewCoworker");

    const user = buildCancelConfirmationEmail({ ...base, reason: "user_refund" });
    expect(user.subject).toContain("cancelada");
    expect(user.text).toContain("a petición tuya");
  });

  it("refund-issued localizes the amount line", () => {
    const email = buildRefundIssuedEmail({
      amountCents: 12345,
      recipientEmail: TO,
      siteUrl: SITE,
      locale: "es"
    });
    expect(email.subject).toBe("Tu reembolso de NewCoworker está en camino");
    expect(email.text).toContain("Emitimos un reembolso de $123.45");
  });

  it("email-verification localizes subject, body, and CTA", () => {
    const email = buildEmailVerificationMessage({
      verificationUrl: `${SITE}/verify-email?token=t`,
      siteUrl: SITE,
      recipientEmail: TO,
      locale: "es"
    });
    expect(email.subject).toBe("Confirma tu correo de NewCoworker");
    expect(email.text).toContain("¡Bienvenido a NewCoworker!");
    expect(email.html).toContain("Confirmar correo");
  });

  it("team-invite localizes both role branches", () => {
    const manager = buildTeamInviteEmail({
      businessName: "Acme",
      role: "manager",
      invitedBy: "owner@acme.com",
      recipientEmail: TO,
      siteUrl: SITE,
      locale: "es"
    });
    expect(manager.subject).toBe("Te agregaron a Acme en NewCoworker");
    expect(manager.text).toContain("Como gerente");

    const staff = buildTeamInviteEmail({
      businessName: "Acme",
      role: "staff",
      invitedBy: "owner@acme.com",
      recipientEmail: TO,
      siteUrl: SITE,
      locale: "es"
    });
    expect(staff.text).toContain("Como personal");
  });

  it("white-glove offer/intake/confirmation localize copy and CTAs", () => {
    const offer = buildWhiteGloveOfferEmail({
      offerName: "Buildout Deluxe",
      description: "Custom flows.",
      amountCents: 200000,
      payUrl: `${SITE}/offer/tok`,
      recipientEmail: TO,
      siteUrl: SITE,
      locale: "es"
    });
    expect(offer.subject).toBe("Tu oferta de NewCoworker: Buildout Deluxe");
    expect(offer.text).toContain("$2,000.00, pago único");
    expect(offer.html).toContain("Pagar $2,000.00 de forma segura");

    const intake = buildWhiteGloveIntakeEmail({
      intakeUrl: `${SITE}/intake/tok`,
      recipientEmail: TO,
      siteUrl: SITE,
      locale: "es"
    });
    expect(intake.subject).toContain("cuestionario");
    expect(intake.text).toContain("Llénalo aquí:");

    const confirmed = buildWhiteGloveConfirmationEmail({
      packageName: "White-glove setup",
      recipientEmail: TO,
      prioritySupportUntil: new Date("2026-08-20T00:00:00Z"),
      bookingUrl: `${SITE}/book`,
      siteUrl: SITE,
      locale: "es"
    });
    expect(confirmed.subject).toBe("Tu White-glove setup está confirmado");
    expect(confirmed.text).toContain("agosto");
    expect(confirmed.html).toContain("Reservar tu sesión");

    const noBooking = buildWhiteGloveConfirmationEmail({
      packageName: "White-glove setup",
      recipientEmail: TO,
      prioritySupportUntil: new Date("2026-08-20T00:00:00Z"),
      bookingUrl: null,
      siteUrl: SITE,
      locale: "es"
    });
    expect(noBooking.text).toContain("Responde a este correo");
    expect(noBooking.html).toContain("Abrir panel");
  });
});

describe("booking owner alert in Spanish", () => {
  const base = {
    attendeeName: "Brett Douglas",
    attendeePhone: "+12187702372",
    attendeeEmail: "brett@example.com",
    startLocal: "viernes, 14 de agosto de 2026, 12:00 p.m. MST",
    summary: "Brett Douglas + New Coworker: Discovery Call",
    locale: "es" as const
  };

  it("localizes all three ownership states", () => {
    const unowned = buildBookingOwnerAlert({
      ...base,
      state: "unowned",
      surface: "booking_page"
    });
    expect(unowned.subject).toContain("necesita responsable");
    expect(unowned.heading).toBe("Una cita nueva necesita responsable");
    expect(unowned.body).toContain("agendó");
    expect(unowned.body).toContain("nadie está a cargo de asistir");
    expect(unowned.ctaLabel).toBe("Asignar este contacto");

    const covered = buildBookingOwnerAlert({
      ...base,
      state: "covered",
      assigneeName: "Dana Reyes",
      surface: "booking_page"
    });
    expect(covered.body).toContain("Dana Reyes está asignado a esta cita.");
    expect(covered.ctaLabel).toBe("Abrir contacto");

    const solo = buildBookingOwnerAlert({ ...base, state: "solo", surface: "booking_page" });
    expect(solo.heading).toBe("Cita nueva agendada");
    // The solo rule holds in Spanish too: nothing about assigning or owners.
    const whole = `${solo.subject}\n${solo.body}`.toLowerCase();
    expect(whole).not.toContain("asigna");
    expect(whole).not.toContain("responsable");
  });

  it("localizes the AI attribution and the detail block", () => {
    const ai = buildBookingOwnerAlert({
      ...base,
      state: "solo",
      surface: "sms",
      durationMinutes: 30,
      joinUrl: "https://zoom.us/j/123",
      note: "Quiere hablar de precios"
    });
    expect(ai.body).toContain("Tu Coworker de IA agendó");
    expect(ai.body).toContain("Teléfono: (218) 770-2372");
    expect(ai.body).toContain("Correo: brett@example.com");
    expect(ai.body).toContain("Duración: 30 minutos");
    expect(ai.body).toContain("Enlace de video: https://zoom.us/j/123");
    expect(ai.body).toContain("Su nota: Quiere hablar de precios");
  });
});

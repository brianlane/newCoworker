import { describe, expect, it, vi } from "vitest";
import {
  canceledMirrorPatch,
  formatPaymentFailureDetail,
  invoicePaymentFailureDetails,
  paymentFailedCancelPatch,
  stampPaymentFailedCancel
} from "@/lib/billing/payment-failed";
import { GRACE_WINDOW_MS } from "@/lib/billing/lifecycle";

const NOW = new Date("2026-09-17T01:04:48.000Z");

describe("invoicePaymentFailureDetails", () => {
  it("reads last4, brand, and decline from an expanded charge", () => {
    const details = invoicePaymentFailureDetails({
      id: "in_1UGSoIFv205jOP2fQZJohEsm",
      amount_due: 18900,
      currency: "usd",
      charge: {
        payment_method_details: { card: { brand: "amex", last4: "3042" } },
        failure_code: "card_declined",
        failure_message: "Your card was declined.",
        outcome: { reason: "do_not_honor" }
      }
    });
    expect(details).toEqual({
      invoiceId: "in_1UGSoIFv205jOP2fQZJohEsm",
      amountCents: 18900,
      currency: "usd",
      cardBrand: "amex",
      cardLast4: "3042",
      declineCode: "do_not_honor",
      failureCode: "card_declined",
      failureMessage: "Your card was declined."
    });
  });

  it("reads last_payment_error off a payments[].payment.payment_intent", () => {
    const details = invoicePaymentFailureDetails({
      id: "in_pi",
      amount_remaining: 9900,
      payments: {
        data: [
          {
            payment: {
              payment_intent: {
                last_payment_error: {
                  code: "card_declined",
                  decline_code: "insufficient_funds",
                  message: "Insufficient funds."
                }
              }
            }
          }
        ]
      }
    });
    expect(details.amountCents).toBe(9900);
    expect(details.declineCode).toBe("insufficient_funds");
    expect(details.failureCode).toBe("card_declined");
    expect(details.failureMessage).toBe("Insufficient funds.");
  });

  it("falls back to last_finalization_error when nothing else is expanded", () => {
    const details = invoicePaymentFailureDetails({
      id: "in_fin",
      last_finalization_error: { code: "card_declined", message: "Declined." }
    });
    expect(details.failureCode).toBe("card_declined");
    expect(details.failureMessage).toBe("Declined.");
    expect(details.cardLast4).toBeNull();
  });

  it("returns empty invoice id when the payload has none", () => {
    expect(invoicePaymentFailureDetails({}).invoiceId).toBe("");
  });

  it("reads last_payment_error off a top-level payments[].payment_intent", () => {
    const details = invoicePaymentFailureDetails({
      id: "in_top",
      payments: {
        data: [
          { ignored: true },
          {
            payment_intent: {
              last_payment_error: {
                code: "card_declined",
                decline_code: "stolen_card",
                message: "Stolen card."
              }
            }
          }
        ]
      }
    });
    expect(details.declineCode).toBe("stolen_card");
    expect(details.failureMessage).toBe("Stolen card.");
  });

  it("ignores a string charge and empty payment rows", () => {
    const details = invoicePaymentFailureDetails({
      id: "in_thin",
      charge: "ch_abc",
      payments: { data: ["nope", null, { payment: { payment_intent: {} } }] }
    });
    expect(details.cardLast4).toBeNull();
    expect(details.failureCode).toBeNull();
  });
});

describe("formatPaymentFailureDetail", () => {
  it("formats Scar Fairy's Amex decline without an em dash", () => {
    const line = formatPaymentFailureDetail({
      invoiceId: "in_1",
      amountCents: 18900,
      currency: "usd",
      cardBrand: "amex",
      cardLast4: "3042",
      declineCode: "do_not_honor",
      failureCode: "card_declined",
      failureMessage: "Your card was declined."
    });
    expect(line).toBe("Amex ending 3042, declined (card_declined / do_not_honor)");
    expect(line).not.toContain("\u2014");
  });

  it("formats mastercard last4 without a brand-specific code", () => {
    expect(
      formatPaymentFailureDetail({
        invoiceId: "in_2",
        amountCents: null,
        currency: null,
        cardBrand: "mastercard",
        cardLast4: "4242",
        declineCode: null,
        failureCode: null,
        failureMessage: null
      })
    ).toBe("Mastercard ending 4242");
  });

  it("formats a decline code without a card", () => {
    expect(
      formatPaymentFailureDetail({
        invoiceId: "in_5",
        amountCents: null,
        currency: null,
        cardBrand: null,
        cardLast4: null,
        declineCode: "do_not_honor",
        failureCode: "do_not_honor",
        failureMessage: null
      })
    ).toBe("declined (do_not_honor)");
  });

  it("falls back to a generic line", () => {
    expect(
      formatPaymentFailureDetail({
        invoiceId: "",
        amountCents: null,
        currency: null,
        cardBrand: null,
        cardLast4: null,
        declineCode: null,
        failureCode: null,
        failureMessage: null
      })
    ).toBe("the charge was declined");
  });

  it("uses card ending when brand is missing and capitalizes other brands", () => {
    expect(
      formatPaymentFailureDetail({
        invoiceId: "in_3",
        amountCents: null,
        currency: null,
        cardBrand: null,
        cardLast4: "1111",
        declineCode: null,
        failureCode: null,
        failureMessage: "stolen card"
      })
    ).toBe("card ending 1111, stolen card");
    expect(
      formatPaymentFailureDetail({
        invoiceId: "in_4",
        amountCents: null,
        currency: null,
        cardBrand: "visa",
        cardLast4: "9999",
        declineCode: null,
        failureCode: "card_declined",
        failureMessage: null
      })
    ).toBe("Visa ending 9999, declined (card_declined)");
  });
});

describe("paymentFailedCancelPatch / canceledMirrorPatch", () => {
  it("stamps payment_failed with a 30-day grace window", () => {
    const patch = paymentFailedCancelPatch(NOW);
    expect(patch.cancel_reason).toBe("payment_failed");
    expect(patch.status).toBe("canceled");
    expect(patch.canceled_at).toBe(NOW.toISOString());
    expect(new Date(patch.grace_ends_at).getTime()).toBe(NOW.getTime() + GRACE_WINDOW_MS);
  });

  it("omits cancel_reason when the loaded row is null so a concurrent stamp is not wiped", () => {
    // Scar Fairy: deleted fallback used to PATCH cancel_reason: existing.cancel_reason
    // while existing was still null, overwriting the payment_failed stamp.
    const patch = canceledMirrorPatch({
      now: NOW,
      existing: {
        cancel_reason: null,
        canceled_at: null,
        grace_ends_at: null,
        wiped_at: null
      }
    });
    expect(patch).not.toHaveProperty("cancel_reason");
    expect(patch.status).toBe("canceled");
    expect(patch.grace_ends_at).toBe(new Date(NOW.getTime() + GRACE_WINDOW_MS).toISOString());
  });

  it("preserves payment_failed when the re-read already has it", () => {
    const patch = canceledMirrorPatch({
      now: NOW,
      existing: {
        cancel_reason: "payment_failed",
        canceled_at: NOW.toISOString(),
        grace_ends_at: "2026-10-17T01:04:48.000Z",
        wiped_at: null
      }
    });
    expect(patch.cancel_reason).toBe("payment_failed");
    expect(patch.grace_ends_at).toBe("2026-10-17T01:04:48.000Z");
    expect(patch.canceled_at).toBe(NOW.toISOString());
  });

  it("does not invent a grace deadline after wipe", () => {
    const patch = canceledMirrorPatch({
      now: NOW,
      existing: {
        cancel_reason: "admin_force",
        canceled_at: NOW.toISOString(),
        grace_ends_at: null,
        wiped_at: NOW.toISOString()
      }
    });
    expect(patch.grace_ends_at).toBeNull();
    expect(patch.cancel_reason).toBe("admin_force");
  });

  it("stampPaymentFailedCancel writes the patch through the injected updater", async () => {
    const update = vi.fn().mockResolvedValue(undefined);
    await stampPaymentFailedCancel({ id: "sub_row_1" }, NOW, update);
    expect(update).toHaveBeenCalledWith("sub_row_1", paymentFailedCancelPatch(NOW));
  });
});

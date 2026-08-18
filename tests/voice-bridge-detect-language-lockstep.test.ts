import { describe, expect, it } from "vitest";
import { detectCustomerLanguage as shared } from "../shared/i18n/detect-customer-language";
import { detectCustomerLanguage as bridge } from "../vps/voice-bridge/src/detect-customer-language";

/**
 * The voice bridge is rsynced to each tenant VPS as a standalone package and
 * cannot import across the repo, so the language detector exists twice. Same
 * arrangement as customer-language-line.ts and voice-name.ts.
 *
 * A one-sided edit here is expensive in a specific way: the SMS side would keep
 * learning a caller's language while the voice side stopped agreeing, so the
 * same person would be interpreted for on one channel and not the other. This
 * pins the two against a corpus rather than against each other's source, so a
 * refactor that preserves behavior stays legal.
 */
const CORPUS = [
  // The Aug 18 incident call (5634b7f0), verbatim.
  "¿Tú?",
  "What is your offer?",
  "If you can make it quick.",
  "Hello. Hello.",
  "What do you OLA on about? Hello?",
  // Loanwords and courtesies, which must never carry a language on their own.
  "hola",
  "gracias",
  "Hola",
  "por favor",
  "si",
  "sí",
  "no",
  "ok",
  // Genuine Spanish.
  "Hola, necesito hablar con alguien sobre mi casa",
  "No hablo inglés, quiero vender mi casa",
  "Sí, quiero vender la casa lo antes posible",
  "¿Puedo cambiar mi cita para el viernes?",
  "Necesito información sobre el precio",
  // Genuine English.
  "I want to book an appointment for Friday please",
  "Can you tell me how much this costs?",
  "I need help with my booking",
  // Mixed.
  "Hola, I need an appointment tomorrow please",
  "Gracias, that works for me",
  "Buenos dias, can you call me back today?",
  // Degenerate input.
  "",
  "   ",
  "?",
  "123"
];

describe("the bridge's language detector matches the shared one", () => {
  it("agrees on every corpus string, on a first-contact call", () => {
    for (const text of CORPUS) {
      expect(bridge({ text })).toEqual(shared({ text }));
    }
  });

  it("agrees with an established language in play, in both directions", () => {
    for (const text of CORPUS) {
      for (const established of ["en", "es"] as const) {
        expect(bridge({ text, establishedLanguage: established })).toEqual(
          shared({ text, establishedLanguage: established })
        );
      }
    }
  });

  it("agrees for a Spanish-default tenant", () => {
    for (const text of CORPUS) {
      expect(bridge({ text, defaultLanguage: "es" })).toEqual(
        shared({ text, defaultLanguage: "es" })
      );
    }
  });

  it("agrees when the tenant supports English only", () => {
    for (const text of CORPUS) {
      expect(bridge({ text, supported: ["en"] })).toEqual(shared({ text, supported: ["en"] }));
    }
  });

  it("still calls the incident's stray token English, on both sides", () => {
    // The single fact the whole gate rests on, asserted rather than assumed.
    expect(shared({ text: "¿Tú?" })).toEqual({
      language: "en",
      persist: false,
      confidence: "none"
    });
    expect(bridge({ text: "¿Tú?" })).toEqual(shared({ text: "¿Tú?" }));
  });
});

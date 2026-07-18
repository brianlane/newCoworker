import { describe, expect, it } from "vitest";
import { detectCustomerLanguage } from "../shared/i18n/detect-customer-language.ts";

describe("detectCustomerLanguage", () => {
  it("classifies plain English as English", () => {
    const r = detectCustomerLanguage({
      text: "Hi, do you have anything available Thursday afternoon?"
    });
    expect(r.language).toBe("en");
  });

  it("does not flip English thread on si confirmation", () => {
    const r = detectCustomerLanguage({
      text: "si",
      establishedLanguage: "en"
    });
    expect(r.language).toBe("en");
    expect(r.persist).toBe(false);
  });

  it("classifies dominant Spanish in mixed message as Spanish", () => {
    const r = detectCustomerLanguage({
      text: "Hello, quiero hacer una cita para el viernes por favor, my name is Maria"
    });
    expect(r.language).toBe("es");
    expect(r.persist).toBe(true);
  });

  it("keeps broken English with Spanish sprinkles as English", () => {
    const r = detectCustomerLanguage({
      text: "hola, I need appointment for friday por favor"
    });
    expect(r.language).toBe("en");
    expect(r.persist).toBe(false);
  });

  it("keeps a lone Spanish greeting sticky to the established thread language", () => {
    const onSpanishThread = detectCustomerLanguage({
      text: "hola",
      establishedLanguage: "es"
    });
    expect(onSpanishThread.language).toBe("es");
    expect(onSpanishThread.persist).toBe(false);

    const onEnglishThread = detectCustomerLanguage({
      text: "gracias",
      establishedLanguage: "en"
    });
    expect(onEnglishThread.language).toBe("en");

    const firstContact = detectCustomerLanguage({ text: "hola" });
    expect(firstContact.language).toBe("en");
    expect(firstContact.persist).toBe(false);
  });

  it("returns English-only fast path when supported is en only", () => {
    const r = detectCustomerLanguage({
      text: "Hola quiero una cita",
      supported: ["en"]
    });
    expect(r.language).toBe("en");
    expect(r.persist).toBe(true);
  });
});

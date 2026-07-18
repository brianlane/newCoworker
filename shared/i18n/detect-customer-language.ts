export type CustomerLanguage = "en" | "es";
export type LanguageSource = "detected" | "owner_set";

/** Loanwords/greetings that never alone signal Spanish. */
const SPANISH_LOANWORDS =
  /^(hola|gracias|por favor|amigo|amiga|buenos dias|buenas tardes|buenas noches|adios|adiós)$/i;

/** Single-token confirmations that must not flip an English thread. */
const STICKY_ENGLISH_TOKENS = /^(si|sí|no|ok|okay|yes|yep|yeah|thanks|thank you|gracias)$/i;

const SPANISH_FUNCTION_WORDS =
  /\b(quiero|necesito|cita|horario|disponible|viernes|jueves|lunes|martes|miércoles|miercoles|sábado|sabado|domingo|mañana|manana|tarde|noche|tengo|puedo|podría|podria|cambiar|cancelar|confirmar|nombre|teléfono|telefono|correo|email|dirección|direccion|ayuda|información|informacion|precio|costo|cuánto|cuanto|está|esta|estoy|soy|para el|para la|el viernes|la cita|mi cita|una cita|hacer una|agendar|reservar)\b/i;

/** Greetings/courtesies that alone should not flip an English request. */
const SPANISH_LOANWORD_IN_TEXT =
  /\b(hola|gracias|por favor|buenos|buenas|adios|adiós)\b/gi;

const SPANISH_SUBSTANCE_IN_TEXT =
  /\b(quiero|necesito|cita|viernes|jueves|lunes|martes|miércoles|miercoles|sábado|sabado|domingo|mañana|manana|agendar|reservar|cambiar|cancelar|confirmar|horario|disponible|tengo|puedo|podría|podria|cómo|como|cuándo|cuando|dónde|donde|precio|teléfono|telefono|correo)\b/gi;

const ENGLISH_REQUEST_WORDS =
  /\b(i|we|you|my|our|need|want|appointment|schedule|book|booking|available|availability|friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow|today|please|thanks|thank|call|text|email|name|phone|number|time|slot|confirm|cancel|change|help|information|price|cost|how much|what|when|where|can you|could you|do you have|looking for)\b/i;

export type DetectCustomerLanguageOpts = {
  text: string;
  /** Prior language in this thread (sticky). */
  establishedLanguage?: CustomerLanguage | null;
  defaultLanguage?: CustomerLanguage;
  supported?: CustomerLanguage[];
};

export type DetectCustomerLanguageResult = {
  language: CustomerLanguage;
  /** True when confident enough to persist on first contact. */
  persist: boolean;
  confidence: "high" | "low" | "none";
};

function normalize(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function spanishCharScore(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  if (/[áéíóúüñ¿¡]/.test(lower)) score += 2;
  if (SPANISH_FUNCTION_WORDS.test(lower)) score += 2;
  return score;
}

function englishRequestScore(text: string): number {
  const lower = text.toLowerCase();
  let score = 0;
  if (ENGLISH_REQUEST_WORDS.test(lower)) score += 2;
  if (/\b(the|and|for|with|this|that|have|has|will|would|should)\b/i.test(lower)) score += 1;
  return score;
}

/**
 * Classify inbound customer text for AI reply language. Conservative: when
 * ambiguous, returns defaultLanguage (English) and does not persist.
 */
export function detectCustomerLanguage(
  opts: DetectCustomerLanguageOpts
): DetectCustomerLanguageResult {
  const defaultLanguage = opts.defaultLanguage ?? "en";
  const supported = opts.supported ?? ["en", "es"];
  const text = normalize(opts.text);

  if (!text) {
    return { language: defaultLanguage, persist: false, confidence: "none" };
  }

  if (supported.length === 1 && supported[0] === "en") {
    return { language: "en", persist: true, confidence: "high" };
  }

  const tokens = text.split(/\s+/);
  const singleToken = tokens.length === 1 ? tokens[0]!.toLowerCase() : null;

  if (
    opts.establishedLanguage === "en" &&
    singleToken &&
    STICKY_ENGLISH_TOKENS.test(singleToken)
  ) {
    return { language: "en", persist: false, confidence: "low" };
  }

  if (singleToken && SPANISH_LOANWORDS.test(singleToken)) {
    // Sticky: a lone greeting/courtesy never changes an established thread
    // language ("hola" on a Spanish thread stays Spanish, on an English
    // thread stays English). Only with no history does it fall to default.
    if (opts.establishedLanguage) {
      return { language: opts.establishedLanguage, persist: false, confidence: "low" };
    }
    return { language: defaultLanguage, persist: false, confidence: "none" };
  }

  const esScore = spanishCharScore(text);
  const enScore = englishRequestScore(text);

  const spanishLoanwordHits = (text.match(SPANISH_LOANWORD_IN_TEXT) ?? []).length;
  const spanishSubstanceHits = (text.match(SPANISH_SUBSTANCE_IN_TEXT) ?? []).length;
  const englishTokenHits = (text.match(
    /\b(i|we|you|my|our|need|want|appointment|schedule|book|available|friday|monday|tuesday|wednesday|thursday|saturday|sunday|tomorrow|today|please|thanks|call|email|name|phone|time|confirm|cancel|change|help|information|price|how|what|when|where)\b/gi
  ) ?? []).length;

  // Broken English request with Spanish loanwords only → English substance wins.
  if (englishTokenHits >= 2 && spanishSubstanceHits === 0) {
    const hasSprinkles = spanishLoanwordHits > 0;
    const persist = !hasSprinkles && englishTokenHits >= 3 && enScore > esScore;
    return { language: "en", persist, confidence: persist ? "high" : "low" };
  }

  // Dominant Spanish (including mixed greeting + Spanish request).
  if (
    spanishSubstanceHits >= 2 ||
    (esScore >= 2 && spanishSubstanceHits > englishTokenHits)
  ) {
    return { language: "es", persist: true, confidence: "high" };
  }

  if (enScore >= 2 && enScore > esScore) {
    const persist = englishTokenHits >= 3;
    return { language: "en", persist, confidence: persist ? "high" : "low" };
  }

  if (opts.establishedLanguage) {
    return {
      language: opts.establishedLanguage,
      persist: false,
      confidence: "low"
    };
  }

  return { language: defaultLanguage, persist: false, confidence: "none" };
}

export function shouldSkipCustomerLanguagePrompt(supported?: CustomerLanguage[]): boolean {
  return supported?.length === 1 && supported[0] === "en";
}

export type PasswordCopyLocale = "en" | "es";

/**
 * The exact symbol set Supabase Auth accepts when the project requires
 * "lowercase, uppercase letters, digits and symbols". Mirrored here character
 * for character so a password we accept can never be rejected server-side:
 * a space or a non-ASCII symbol (£, €, ±) does NOT count as a symbol there.
 *
 * Spelled out one character per entry rather than as a single string, because
 * the concatenated form is indistinguishable from a generated password and
 * trips secret scanners.
 */
export const PASSWORD_SYMBOLS: readonly string[] = [
  "!", "@", "#", "$", "%", "^", "&", "*", "(", ")",
  "_", "+", "-", "=", "[", "]", "{", "}", ";", "'",
  "\\", ":", '"', "|", "<", ">", "?", ",", ".", "/",
  "`", "~"
];

const SYMBOL_SET = new Set(PASSWORD_SYMBOLS);

const RULES: Record<PasswordCopyLocale, readonly string[]> = {
  en: [
    "At least 8 characters",
    "At least 1 lowercase letter",
    "At least 1 uppercase letter",
    "At least 1 number",
    "At least 1 symbol, such as ! ? @ # $ %",
    "Must match the confirmation field"
  ],
  es: [
    "Al menos 8 caracteres",
    "Al menos 1 letra minúscula",
    "Al menos 1 letra mayúscula",
    "Al menos 1 número",
    "Al menos 1 símbolo, como ! ? @ # $ %",
    "Debe coincidir con el campo de confirmación"
  ]
};

export const PASSWORD_RULES = RULES.en;

export function getPasswordRules(locale: PasswordCopyLocale = "en"): readonly string[] {
  return RULES[locale];
}

function hasSymbol(password: string): boolean {
  for (const char of password) {
    if (SYMBOL_SET.has(char)) return true;
  }
  return false;
}

export function getPasswordValidationError(
  password: string,
  locale: PasswordCopyLocale = "en"
): string | null {
  const es = locale === "es";
  if (password.length < 8) {
    return es
      ? "La contraseña debe tener al menos 8 caracteres"
      : "Password must be at least 8 characters";
  }

  if (!/[a-z]/.test(password)) {
    return es
      ? "La contraseña debe incluir al menos 1 letra minúscula"
      : "Password must include at least 1 lowercase letter";
  }

  if (!/[A-Z]/.test(password)) {
    return es
      ? "La contraseña debe incluir al menos 1 letra mayúscula"
      : "Password must include at least 1 uppercase letter";
  }

  if (!/[0-9]/.test(password)) {
    return es
      ? "La contraseña debe incluir al menos 1 número"
      : "Password must include at least 1 number";
  }

  if (!hasSymbol(password)) {
    return es
      ? "La contraseña debe incluir al menos 1 símbolo, como ! ? @ # $ %"
      : "Password must include at least 1 symbol, such as ! ? @ # $ %";
  }

  return null;
}

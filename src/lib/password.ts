export type PasswordCopyLocale = "en" | "es";

const RULES: Record<PasswordCopyLocale, readonly string[]> = {
  en: [
    "At least 8 characters",
    "At least 1 uppercase letter",
    "At least 1 number",
    "Must match the confirmation field"
  ],
  es: [
    "Al menos 8 caracteres",
    "Al menos 1 letra mayúscula",
    "Al menos 1 número",
    "Debe coincidir con el campo de confirmación"
  ]
};

export const PASSWORD_RULES = RULES.en;

export function getPasswordRules(locale: PasswordCopyLocale = "en"): readonly string[] {
  return RULES[locale];
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

  return null;
}

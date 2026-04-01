export const PASSWORD_RULES = [
  "At least 8 characters",
  "At least 1 uppercase letter",
  "At least 1 number",
  "Must match the confirmation field"
] as const;

export function getPasswordValidationError(password: string): string | null {
  if (password.length < 8) {
    return "Password must be at least 8 characters";
  }

  if (!/[A-Z]/.test(password)) {
    return "Password must include at least 1 uppercase letter";
  }

  if (!/[0-9]/.test(password)) {
    return "Password must include at least 1 number";
  }

  return null;
}

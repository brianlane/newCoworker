/**
 * The one place the "turn an unknown throw into log text" ternary lives.
 *
 * Every catch block in the Acuity modules logs `err instanceof Error ?
 * err.message : String(err)`. Repeating it a dozen times buried the actual
 * recovery logic and made each copy its own thing to get right, so it lives
 * here once.
 */
export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

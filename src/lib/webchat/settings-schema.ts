/**
 * Validation + normalization for owner-configurable widget settings
 * (chat_widget_settings.theme / allowed_origins). Pure functions — no DB.
 */

import { z } from "zod";

/** Widget theming knobs. All optional; the frame falls back to defaults. */
export const widgetThemeSchema = z
  .object({
    /** CSS hex color for the bubble/header accent, e.g. "#2563eb". */
    accentColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}$/, "accentColor must be a 6-digit hex color like #2563eb")
      .optional(),
    /** First message the widget shows before the visitor types anything. */
    greeting: z.string().trim().min(1).max(300).optional(),
    /** Header display name, e.g. "Maple Realty assistant". */
    agentDisplayName: z.string().trim().min(1).max(60).optional()
  })
  .strict();

export type WidgetTheme = z.infer<typeof widgetThemeSchema>;

/** Parse a stored theme jsonb defensively: bad/legacy shapes render as defaults. */
export function parseWidgetTheme(value: unknown): WidgetTheme | null {
  if (value === null || value === undefined) return null;
  const parsed = widgetThemeSchema.safeParse(value);
  if (!parsed.success) return null;
  return Object.keys(parsed.data).length > 0 ? parsed.data : null;
}

export const MAX_ALLOWED_ORIGINS = 20;

/**
 * Normalize one allowed-origin entry to `scheme://host[:port]`, lowercase,
 * no trailing slash/path. Accepts bare hostnames ("example.com") by
 * assuming https. Returns null for anything that doesn't parse to an
 * http(s) origin.
 */
export function normalizeOrigin(input: string): string | null {
  const raw = input.trim().toLowerCase();
  if (!raw) return null;
  // Preserve an explicit scheme so non-http(s) ones ("ftp://…") are
  // REJECTED below rather than silently mangled into an https host.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//.test(raw);
  const withScheme = hasScheme ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // NOTE: no empty-hostname guard — WHATWG URL throws on host-less
  // http(s) URLs ("https://", "https://#"), so parse success implies a
  // non-empty hostname here.
  return url.port ? `${url.protocol}//${url.hostname}:${url.port}` : `${url.protocol}//${url.hostname}`;
}

/**
 * Normalize + dedupe an owner-supplied allowed-origins list. Throws on any
 * invalid entry (the settings route surfaces it as a validation error) so
 * an owner never saves a typo that silently blocks their own website.
 */
export function normalizeAllowedOrigins(input: string[]): string[] {
  const out: string[] = [];
  for (const entry of input) {
    if (!entry.trim()) continue;
    const normalized = normalizeOrigin(entry);
    if (!normalized) {
      throw new Error(`Invalid origin: "${entry.trim()}" — use a URL like https://example.com`);
    }
    if (!out.includes(normalized)) out.push(normalized);
  }
  if (out.length > MAX_ALLOWED_ORIGINS) {
    throw new Error(`At most ${MAX_ALLOWED_ORIGINS} allowed origins`);
  }
  return out;
}

/** Host comparison that treats `www.example.com` and `example.com` as the same site. */
function stripWww(host: string): string {
  return host.startsWith("www.") ? host.slice(4) : host;
}

/**
 * Does a request Origin header match the owner's allowlist?
 *
 *   * Empty allowlist ⇒ any origin (the key alone identifies the tenant).
 *   * Non-empty ⇒ scheme + host [+ port] must match one entry, with
 *     `www.` treated as equivalent on both sides (small-business owners
 *     routinely save the wrong variant).
 *   * A missing/unparseable Origin fails a non-empty allowlist — browsers
 *     always send Origin on cross-site fetch POSTs, so its absence means a
 *     non-browser caller that shouldn't pass an origin-scoped widget.
 */
export function originAllowed(origin: string | null, allowed: string[]): boolean {
  if (allowed.length === 0) return true;
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  const reqUrl = new URL(normalized);
  const reqHost = stripWww(reqUrl.hostname);
  for (const entry of allowed) {
    const entryNorm = normalizeOrigin(entry);
    if (!entryNorm) continue;
    const entryUrl = new URL(entryNorm);
    if (
      entryUrl.protocol === reqUrl.protocol &&
      stripWww(entryUrl.hostname) === reqHost &&
      entryUrl.port === reqUrl.port
    ) {
      return true;
    }
  }
  return false;
}

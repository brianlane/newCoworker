/**
 * White-label dashboard branding (enterprise) — schema + parsing for
 * `businesses.branding` (migration 20260809000000_business_branding.sql).
 *
 * Same pattern as enterprise-limits: a nullable jsonb column, a strict zod
 * schema at every boundary (unknown keys stripped, values bounded), and
 * ENFORCEMENT AT READ TIME — branding renders only for enterprise-tier
 * businesses, so a downgraded tenant's stored branding goes dormant instead
 * of needing cleanup.
 */

import { z } from "zod";

export const BRANDING_PRODUCT_NAME_MAX = 60;
export const BRANDING_LOGO_URL_MAX = 500;

/** #rgb or #rrggbb — parsed, never interpolated into CSS as raw text. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export const brandingSchema = z
  .object({
    /** Replaces "New Coworker" in the dashboard shell. */
    productName: z.string().trim().min(2).max(BRANDING_PRODUCT_NAME_MAX),
    /** https-only; rendered through next/image-safe <img>, never fetched server-side. */
    logoUrl: z
      .string()
      .trim()
      .max(BRANDING_LOGO_URL_MAX)
      .url()
      .refine((u) => u.startsWith("https://"), { message: "Logo URL must be https" }),
    /** Accent for the sidebar active state. */
    accentColor: z.string().trim().regex(HEX_COLOR_RE, "Use a #rgb or #rrggbb color")
  })
  .partial();

export type Branding = z.infer<typeof brandingSchema>;

/** Lenient read-side parse: garbage in the column renders default branding. */
export function parseBranding(raw: unknown): Branding | null {
  if (raw == null) return null;
  const result = brandingSchema.safeParse(raw);
  if (!result.success) return null;
  return Object.keys(result.data).length > 0 ? result.data : null;
}

/**
 * The branding to RENDER for a business: stored branding when (and only
 * when) the tenant is enterprise tier — white-label is an enterprise
 * feature, enforced at read time.
 */
export function effectiveBranding(
  tier: string | null | undefined,
  raw: unknown
): Branding | null {
  if (tier !== "enterprise") return null;
  return parseBranding(raw);
}

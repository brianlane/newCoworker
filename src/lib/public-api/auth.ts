/**
 * Bearer authentication for the public REST API (/api/public/v1/*).
 *
 * Stateless per request: hash the presented `nck_…` token, look it up in
 * `api_keys`, and return the owning business. No cookies, no sessions —
 * CSRF does not apply (the proxy exempts /api/public/ accordingly).
 */

import {
  apiKeyFromAuthorizationHeader,
  hashApiKey
} from "@/lib/public-api/keys";
import {
  findActiveApiKeyByHash,
  touchApiKeyLastUsed
} from "@/lib/db/api-keys";
import { logger } from "@/lib/logger";

export type PublicApiAuth = {
  businessId: string;
  apiKeyId: string;
};

/**
 * Resolve the API key on a request. Returns null for missing/invalid/revoked
 * credentials — the route answers 401. The last-used stamp is fire-and-forget.
 */
export async function authenticatePublicApiRequest(
  request: Request
): Promise<PublicApiAuth | null> {
  const token = apiKeyFromAuthorizationHeader(request.headers.get("authorization"));
  if (!token) return null;

  const row = await findActiveApiKeyByHash(hashApiKey(token));
  if (!row) return null;

  try {
    await touchApiKeyLastUsed(row.id);
  } catch (err) {
    logger.warn("public-api auth: last_used stamp failed (continuing)", {
      apiKeyId: row.id,
      error: err instanceof Error ? err.message : String(err)
    });
  }

  return { businessId: row.business_id, apiKeyId: row.id };
}

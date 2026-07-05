/**
 * Dashboard management for public API keys (the credentials Zapier uses).
 *
 *   GET  /api/dashboard/api-keys?businessId=… → list (prefix only, no hash)
 *   POST /api/dashboard/api-keys              → mint { businessId, name }
 *
 * The POST response is the ONLY time the plaintext key exists outside the
 * owner's clipboard — we store just the SHA-256 hash. Auth: session owner
 * (admins may target any business, matching dashboard conventions).
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { mintApiKey } from "@/lib/public-api/keys";
import {
  MAX_ACTIVE_API_KEYS_PER_BUSINESS,
  countActiveApiKeys,
  insertApiKey,
  listApiKeys
} from "@/lib/db/api-keys";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  businessId: z.string().uuid(),
  name: z.string().min(1).max(80).default("API key")
});

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const businessId = z.string().uuid().parse(url.searchParams.get("businessId"));
    if (!user.isAdmin) await requireOwner(businessId);

    const keys = await listApiKeys(businessId);
    return successResponse(
      keys.map((k) => ({
        id: k.id,
        name: k.name,
        key_prefix: k.key_prefix,
        created_at: k.created_at,
        last_used_at: k.last_used_at,
        revoked_at: k.revoked_at
      }))
    );
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const json = (await request.json().catch(() => null)) as unknown;
    const { businessId, name } = createSchema.parse(json);
    if (!user.isAdmin) await requireOwner(businessId);

    const active = await countActiveApiKeys(businessId);
    if (active >= MAX_ACTIVE_API_KEYS_PER_BUSINESS) {
      return errorResponse(
        "CONFLICT",
        `Key limit reached (${MAX_ACTIVE_API_KEYS_PER_BUSINESS}); revoke an unused key first.`
      );
    }

    const minted = mintApiKey();
    const row = await insertApiKey({
      businessId,
      name,
      keyPrefix: minted.prefix,
      keyHash: minted.hash
    });

    // `plaintext` is shown once in the UI and never again — not persisted.
    return successResponse(
      {
        id: row.id,
        name: row.name,
        key_prefix: row.key_prefix,
        created_at: row.created_at,
        plaintext: minted.plaintext
      },
      201
    );
  } catch (err) {
    return handleRouteError(err);
  }
}

/**
 * Cross-channel customer list (Phase 4 of the customer memory plan).
 *
 * GET /api/dashboard/customers?businessId=<uuid>&search=<optional>
 *   → { customers: CustomerMemorySummary[] }
 *
 * Returns the per-(business, customer) memory rows keyed by E.164,
 * sorted by last_interaction_at desc. Each row carries enough info
 * for the listing page to show name + last channel + last seen +
 * interaction count without an N+1 lookup; the per-customer detail
 * route returns the full summary_md/pinned_md plus channel history.
 *
 * Auth: getAuthUser + requireOwner(businessId). Admins (per existing
 * dashboard convention) may query any businessId without the
 * ownership check.
 */

import { z } from "zod";
import { getAuthUser, requireOwner } from "@/lib/auth";
import { errorResponse, handleRouteError, successResponse } from "@/lib/api-response";
import { rateLimit } from "@/lib/rate-limit";
import {
  createCustomerMemory,
  CustomerExistsError,
  listCustomerMemories,
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT
} from "@/lib/customer-memory/db";
import type { CustomerMemoryRow } from "@/lib/customer-memory/types";

export const dynamic = "force-dynamic";

const RATE = { interval: 60 * 1000, maxRequests: 60 };
const WRITE_RATE = { interval: 60 * 1000, maxRequests: 20 };

const querySchema = z.object({
  businessId: z.string().uuid(),
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIST_LIMIT).optional()
});

const E164_RE = /^\+[1-9]\d{6,15}$/;

const createSchema = z.object({
  businessId: z.string().uuid(),
  customerE164: z
    .string()
    .trim()
    .regex(E164_RE, "Phone must be E.164, e.g. +16025551234"),
  displayName: z.string().trim().min(1).max(120).optional(),
  email: z.string().trim().email("Enter a valid email").max(254).optional(),
  pinnedMd: z.string().trim().max(4000).optional()
});

export type CustomerListItem = {
  customerE164: string;
  displayName: string | null;
  lastChannel: CustomerMemoryRow["last_channel"];
  lastInteractionAt: string | null;
  totalInteractionCount: number;
  hasPinnedNotes: boolean;
  hasSummary: boolean;
};

function summarize(row: CustomerMemoryRow): CustomerListItem {
  return {
    customerE164: row.customer_e164,
    displayName: row.display_name,
    lastChannel: row.last_channel,
    lastInteractionAt: row.last_interaction_at,
    totalInteractionCount: row.total_interaction_count,
    hasPinnedNotes: !!row.pinned_md?.trim(),
    hasSummary: !!row.summary_md?.trim()
  };
}

export async function GET(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const parsed = querySchema.parse({
      businessId: url.searchParams.get("businessId") ?? "",
      search: url.searchParams.get("search") ?? undefined,
      limit: url.searchParams.get("limit") ?? undefined
    });

    if (!user.isAdmin) await requireOwner(parsed.businessId);

    const limiter = rateLimit(`customers-list:${parsed.businessId}`, RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const rows = await listCustomerMemories(parsed.businessId, {
      search: parsed.search,
      limit: parsed.limit ?? DEFAULT_LIST_LIMIT
    });

    return successResponse({ customers: rows.map(summarize) });
  } catch (err) {
    return handleRouteError(err);
  }
}

export async function POST(request: Request) {
  try {
    const user = await getAuthUser();
    if (!user) return errorResponse("UNAUTHORIZED", "Authentication required");

    const url = new URL(request.url);
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const parsed = createSchema.parse({
      businessId: url.searchParams.get("businessId") ?? body.businessId ?? "",
      customerE164: body.customerE164,
      displayName: body.displayName === "" ? undefined : body.displayName,
      email: body.email === "" ? undefined : body.email,
      pinnedMd: body.pinnedMd === "" ? undefined : body.pinnedMd
    });

    if (!user.isAdmin) await requireOwner(parsed.businessId);

    const limiter = rateLimit(`customers-create:${parsed.businessId}`, WRITE_RATE);
    if (!limiter.success) {
      return errorResponse("CONFLICT", "Too many requests, slow down.", 429);
    }

    const row = await createCustomerMemory(parsed.businessId, {
      customerE164: parsed.customerE164,
      displayName: parsed.displayName ?? null,
      email: parsed.email ?? null,
      pinnedMd: parsed.pinnedMd ?? null
    });

    return successResponse({ customer: summarize(row) }, 201);
  } catch (err) {
    if (err instanceof CustomerExistsError) {
      return errorResponse("CONFLICT", err.message);
    }
    return handleRouteError(err);
  }
}

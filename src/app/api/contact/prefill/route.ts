import { NextResponse } from "next/server";
import { resolveContactPrefill } from "@/lib/marketing/contact-prefill";

export const runtime = "nodejs";

/**
 * GET /api/contact/prefill, signed-in contact-form defaults.
 *
 * Anonymous callers get `{}`. The /contact page stays free of getAuthUser /
 * searchParams in the RSC tree so scrapes do not force a Supabase round-trip
 * on every marketing GET.
 */
export async function GET() {
  const prefill = await resolveContactPrefill();
  return NextResponse.json(prefill, {
    headers: {
      // Prefill is per-session; never share across users at the CDN.
      "Cache-Control": "private, no-store"
    }
  });
}

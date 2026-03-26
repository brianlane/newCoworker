import { createSupabaseServerClient } from "@/lib/supabase/server";
import { NextResponse, type NextRequest } from "next/server";

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const redirectTo = url.searchParams.get("redirectTo") ?? "/dashboard";

  if (code) {
    const supabase = await createSupabaseServerClient();
    await supabase.auth.exchangeCodeForSession(code);
  }

  const target = new URL(redirectTo, request.nextUrl.origin);
  return NextResponse.redirect(target);
}

import { createClient } from "@supabase/supabase-js";

export function getSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error("Missing Supabase URL environment variable");
  }

  if (!anonKey) {
    throw new Error("Missing Supabase anon key environment variable");
  }

  return createClient(url, anonKey);
}

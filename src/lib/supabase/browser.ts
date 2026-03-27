import { createClient } from "@supabase/supabase-js";

let cachedClient: ReturnType<typeof createClient> | null = null;

export function getSupabaseBrowserClient() {
  if (cachedClient) {
    return cachedClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url) {
    throw new Error("Missing Supabase URL environment variable");
  }

  if (!anonKey) {
    throw new Error("Missing Supabase anon key environment variable");
  }

  cachedClient = createClient(url, anonKey);
  return cachedClient;
}

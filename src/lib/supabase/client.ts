import { createClient } from "@supabase/supabase-js";
import { readSupabaseEnv } from "./env";

export function getSupabaseClient(env: NodeJS.ProcessEnv = process.env) {
  const values = readSupabaseEnv(env);
  return createClient(values.url, values.anonKey, {
    auth: { persistSession: false }
  });
}

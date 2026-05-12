type SupabaseEnv = {
  url: string;
  anonKey: string;
  serviceRoleKey: string;
};

export function readSupabaseEnv(env: NodeJS.ProcessEnv = process.env): SupabaseEnv {
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim();
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !anonKey || !serviceRoleKey) {
    throw new Error("Missing Supabase environment variables");
  }

  return { url, anonKey, serviceRoleKey };
}

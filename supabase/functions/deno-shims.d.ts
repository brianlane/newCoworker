/**
 * Editor/typecheck shims for the Deno Edge runtime.
 *
 * These functions execute on Supabase's Deno runtime, but the repo's tooling
 * (tsc, the IDE TS server) is Node-based and cannot resolve remote URL imports
 * or the `Deno` global. The sibling `tsconfig.json` makes this folder its own
 * TS project and this file declares just enough of the runtime surface for the
 * code to typecheck — it has zero effect at deploy time (the Supabase CLI
 * bundles with the real Deno toolchain).
 *
 * Keep the URL declarations in sync with the import pins used by the
 * functions (std@0.208.0, supabase-js@2.45.0).
 */

declare module "https://deno.land/std@0.208.0/http/server.ts" {
  export type Handler = (
    request: Request,
    connInfo?: unknown
  ) => Response | Promise<Response>;
  export interface ServeInit {
    port?: number;
    hostname?: string;
    signal?: AbortSignal;
    onListen?: (params: { hostname: string; port: number }) => void;
  }
  export function serve(handler: Handler, options?: ServeInit): Promise<void>;
}

declare module "https://esm.sh/@supabase/supabase-js@2.45.0" {
  // Deliberately loose: this code was written against supabase-js 2.45's
  // permissive generics, while node_modules carries 2.100 whose schema-typed
  // client rejects untyped table/RPC access wholesale. Each module narrows the
  // client itself via structural parameter types (RpcSupabase, InsertSupabase,
  // ComplianceRpcClient, …), so `any` here only spans the construction site.
  export type SupabaseClient = any;
  export function createClient(
    supabaseUrl: string,
    supabaseKey: string,
    options?: Record<string, unknown>
  ): SupabaseClient;
}

declare const Deno: {
  env: {
    get(name: string): string | undefined;
  };
};

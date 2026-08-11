/**
 * Transport-neutral types for workspace (Gmail / Calendar / Microsoft Graph)
 * API calls.
 *
 * These live in their own module, free of imports, so both
 * `src/lib/workspace/proxy.ts` (the resolver) and `src/lib/nango/workspace.ts`
 * (one of its transports) can share them without an import cycle.
 *
 * Deliberately NOT derived from `@nangohq/node`'s `ProxyConfiguration`. The
 * request shape callers actually use is a small, stable subset, and pinning it
 * here is what lets a second transport exist at all: a first-party Google
 * client has no reason to speak Nango's config type. The full set of fields any
 * caller passes today is exactly the five below, verified by enumerating every
 * call site.
 */

/**
 * Identifies one connected workspace account.
 *
 * Both fields name a row in `workspace_oauth_connections`, which stays the
 * registry of connected accounts regardless of which transport serves it.
 * `providerConfigKey` selects the transport (see `resolveWorkspaceTransport`);
 * `connectionId` is opaque and transport-specific.
 */
export type WorkspaceLink = {
  connectionId: string;
  providerConfigKey: string;
};

export type WorkspaceProxyMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type WorkspaceProxyArgs = {
  /** Provider-relative path, e.g. `/gmail/v1/users/me/messages`. */
  endpoint: string;
  /** Defaults to GET when omitted, matching the previous Nango behavior. */
  method?: WorkspaceProxyMethod;
  data?: unknown;
  headers?: Record<string, string>;
  params?: Record<string, string>;
};

/**
 * The narrow response contract.
 *
 * Callers only ever read `.status` and `.data`, so this is everything they get.
 * That is the point: returning an `AxiosResponse` would force any non-Nango
 * transport to fabricate one, and would keep axios in the type signature of
 * every consumer.
 *
 * `data` is `unknown` rather than `any` so callers must cast deliberately. They
 * already do, at every site.
 */
export type WorkspaceProxyResponse = {
  status: number;
  data: unknown;
};

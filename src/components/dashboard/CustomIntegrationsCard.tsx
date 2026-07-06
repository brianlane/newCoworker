"use client";

/**
 * "Custom integrations" management card for /dashboard/integrations.
 *
 * Owners use this to connect the apps and services their coworker
 * should be able to call (CRM, scheduling tool, order system, …).
 * The form is deliberately framed for non-technical users:
 *
 *   - The 5 raw `auth_scheme` values exposed by the API are collapsed
 *     into 3 friendly "Login type" choices that match how an owner
 *     thinks: username/password, API key, or no login. The original
 *     five are still reachable behind an "Advanced settings"
 *     disclosure for power users.
 *
 *   - Username/password is captured as TWO separate fields and
 *     combined into the `user:pass` shape the server expects only at
 *     submit time — owners never have to type the `:` themselves.
 *
 *   - The web address is validated client-side with a human-readable
 *     hint before the form ever hits the server, so a stray
 *     "myemail@example.com" doesn't bounce off a 400.
 *
 * API contract is unchanged from /api/integrations/custom[/[id]]:
 *   - GET    /api/integrations/custom?businessId=...   (list)
 *   - POST   /api/integrations/custom                  (create)
 *   - PATCH  /api/integrations/custom/[id]             (update)
 *   - DELETE /api/integrations/custom/[id]             (remove)
 *
 * Why the secret is split into "stored vs replace": the GET endpoint
 * returns a `has_secret` boolean instead of the cleartext, so the edit
 * form starts with empty input fields. Submitting empty is coerced to
 * "leave existing secret alone" client-side; only an explicit
 * non-empty value rotates the credential.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

/** Wire-shape `auth_scheme` (must match server enum). */
type AuthScheme = "bearer" | "header" | "basic" | "query" | "none";

/**
 * Friendly "login style" surfaced to non-technical owners. We pick
 * one of these from the row's `auth_scheme` on edit, and translate
 * back to a `(authScheme, secret)` pair on submit.
 *
 *   password → basic   (split into username + password fields)
 *   key      → bearer  (single API-key field)
 *   none     → none
 *   advanced → bearer | header | basic | query | none (full picker)
 */
type LoginStyle = "password" | "key" | "none" | "advanced";

type CustomIntegration = {
  id: string;
  business_id: string;
  label: string;
  base_url: string;
  auth_scheme: AuthScheme;
  header_name: string | null;
  description: string | null;
  is_active: boolean;
  has_secret: boolean;
  created_at: string;
  updated_at: string;
};

type Props = {
  businessId: string;
  initialIntegrations: CustomIntegration[];
};

/** Hint text shown under the (advanced) auth dropdown. */
const SCHEME_HINTS: Record<AuthScheme, string> = {
  bearer:
    "Sent as `Authorization: Bearer <secret>` on every call.",
  header:
    "Sent as `<header-name>: <secret>`. Use this for `X-API-Key`, `apikey`, `X-Auth-Token`, etc.",
  basic:
    "Sent as `Authorization: Basic base64(<secret>)`. The secret should be `username:password`.",
  query:
    "Appended as `?<query-param>=<secret>`. Common on legacy / public-data APIs.",
  none: "No credential is injected. Useful for public APIs that need a base URL only."
};

/** Friendly label per `auth_scheme` for the read-only badge in the list. */
const SCHEME_BADGE_LABEL: Record<AuthScheme, string> = {
  bearer: "API key",
  header: "API key (custom header)",
  basic: "Username & password",
  query: "API key (in URL)",
  none: "No login"
};

const SCHEME_OPTIONS: { value: AuthScheme; label: string }[] = [
  { value: "bearer", label: "Bearer token (Authorization header)" },
  { value: "header", label: "Custom header (e.g. X-API-Key)" },
  { value: "basic", label: "Basic auth (username:password)" },
  { value: "query", label: "Query string parameter" },
  { value: "none", label: "No authentication (public APIs)" }
];

type FormState = {
  id: string | null;
  /**
   * The auth_scheme this row was loaded with on edit. `null` on
   * create. Used to detect a scheme change (e.g. switching from
   * "API key" to "Username and password") so we can require a fresh
   * credential — silently inheriting the stored ciphertext across a
   * scheme change leaves the row in an unusable state (the proxy
   * would, e.g., base64-encode a bearer token as `user:pass`).
   */
  originalAuthScheme: AuthScheme | null;
  label: string;
  baseUrl: string;
  loginStyle: LoginStyle;
  /** Sub-scheme inside "advanced". Ignored for non-advanced styles. */
  advancedScheme: AuthScheme;
  /** Header / query-param name; only meaningful when scheme is header|query. */
  headerName: string;
  /** Friendly username field (login style = password). */
  username: string;
  /** Friendly password field (login style = password). */
  password: string;
  /** Single API-key field (login style = key). */
  apiKey: string;
  /** Raw secret (login style = advanced). */
  advancedSecret: string;
  description: string;
  isActive: boolean;
};

const EMPTY_FORM: FormState = {
  id: null,
  originalAuthScheme: null,
  label: "",
  baseUrl: "",
  loginStyle: "key",
  advancedScheme: "bearer",
  headerName: "",
  username: "",
  password: "",
  apiKey: "",
  advancedSecret: "",
  description: "",
  isActive: true
};

/** True when the string is reasonably an https URL with a hostname. */
function isProbableHttpsUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:") return false;
    if (!url.hostname) return false;
    // Reject single-token "hostnames" like `localhost` written without
    // a TLD or `intranet` — they're either bogus or LAN-local. Real
    // public APIs always have a dot in the host.
    if (!url.hostname.includes(".")) return false;
    return true;
  } catch {
    return false;
  }
}

/** Translate a stored row into the friendly form state. */
function rowToForm(row: CustomIntegration): FormState {
  let loginStyle: LoginStyle;
  if (row.auth_scheme === "basic") loginStyle = "password";
  else if (row.auth_scheme === "bearer") loginStyle = "key";
  else if (row.auth_scheme === "none") loginStyle = "none";
  else loginStyle = "advanced"; // header | query
  return {
    id: row.id,
    originalAuthScheme: row.auth_scheme,
    label: row.label,
    baseUrl: row.base_url,
    loginStyle,
    advancedScheme: row.auth_scheme,
    headerName: row.header_name ?? "",
    username: "",
    password: "",
    apiKey: "",
    advancedSecret: "",
    description: row.description ?? "",
    isActive: row.is_active
  };
}

export function CustomIntegrationsCard({ businessId, initialIntegrations }: Props) {
  const [integrations, setIntegrations] =
    useState<CustomIntegration[]>(initialIntegrations);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const isEdit = form.id !== null;

  function startCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setFormOpen(true);
  }

  function startEdit(row: CustomIntegration) {
    setForm(rowToForm(row));
    setError(null);
    setFormOpen(true);
  }

  function cancel() {
    setFormOpen(false);
    setForm(EMPTY_FORM);
    setError(null);
  }

  async function refresh() {
    try {
      const res = await fetch(
        `/api/integrations/custom?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = (await res.json()) as
        | { ok: true; data: CustomIntegration[] }
        | { ok: false; error: { message: string } };
      if (json.ok) setIntegrations(json.data);
    } catch {
      // Non-fatal: the inline UI updates already reflect the mutation;
      // a hard refresh is the user's recovery path.
    }
  }

  /**
   * Translate the friendly form into the wire shape the server expects.
   * Returns `{ok:false, message}` on a validation failure so the caller
   * can surface a localized error before any network round-trip.
   */
  function buildPayload():
    | { ok: true; payload: Record<string, unknown> }
    | { ok: false; message: string } {
    const label = form.label.trim();
    if (!label) {
      return { ok: false, message: "Please give this service a name (e.g. \"Acme CRM\")." };
    }
    if (!isProbableHttpsUrl(form.baseUrl)) {
      return {
        ok: false,
        message:
          "That doesn't look like a service web address. It should start with https:// and look like https://api.example.com."
      };
    }

    let authScheme: AuthScheme;
    let secret: string | null;
    let headerName: string | null = null;

    if (form.loginStyle === "password") {
      authScheme = "basic";
      const u = form.username.trim();
      const p = form.password;
      if (isEdit && !u && !p) {
        secret = null; // leave existing alone
      } else if (!u || !p) {
        return {
          ok: false,
          message: isEdit
            ? "To change the credentials, type both the username and the password. Leave BOTH blank to keep what's stored."
            : "Please enter both a username and a password."
        };
      } else {
        secret = `${u}:${p}`;
      }
    } else if (form.loginStyle === "key") {
      authScheme = "bearer";
      const k = form.apiKey;
      if (!k) {
        if (!isEdit) {
          return { ok: false, message: "Please paste the API key for this service." };
        }
        secret = null; // leave existing alone
      } else {
        secret = k;
      }
    } else if (form.loginStyle === "none") {
      authScheme = "none";
      secret = null;
    } else {
      authScheme = form.advancedScheme;
      const needsHeader = authScheme === "header" || authScheme === "query";
      if (needsHeader) {
        const trimmed = form.headerName.trim();
        if (!trimmed) {
          return {
            ok: false,
            message:
              authScheme === "query"
                ? "Please enter the URL parameter name (e.g. api_key)."
                : "Please enter the header name (e.g. X-API-Key)."
          };
        }
        headerName = trimmed;
      }
      if (authScheme === "none") {
        secret = null;
      } else {
        const s = form.advancedSecret;
        if (!s) {
          if (!isEdit) {
            return { ok: false, message: "Please enter the credential for this service." };
          }
          secret = null;
        } else {
          secret = s;
        }
      }
    }

    // When editing, switching login type (e.g. from API key to
    // username/password) and leaving the credential field blank used
    // to silently inherit the stored secret under the new scheme —
    // which the server can't honor (Bugbot: "Auth scheme change
    // silently keeps incompatible stored secret"). The server now
    // refuses such transitions; mirror the check here so the owner
    // sees a friendly message instead of a wire-level error.
    if (
      isEdit &&
      form.originalAuthScheme !== null &&
      form.originalAuthScheme !== authScheme &&
      authScheme !== "none" &&
      secret === null
    ) {
      return {
        ok: false,
        message:
          "You're switching how this service logs in. Please enter the new credentials so they match the new login type."
      };
    }

    const payload: Record<string, unknown> = {
      businessId,
      label,
      baseUrl: form.baseUrl.trim(),
      authScheme,
      headerName,
      description: form.description.trim() || null,
      isActive: form.isActive
    };
    if (secret !== null) payload.secret = secret;
    return { ok: true, payload };
  }

  async function submit() {
    setError(null);
    const built = buildPayload();
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setBusy(true);
    try {
      const url = isEdit
        ? `/api/integrations/custom/${form.id}`
        : "/api/integrations/custom";
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.payload)
      });
      const json = (await res.json()) as
        | { ok: true; data: CustomIntegration }
        | { ok: false; error: { message: string } };
      if (!json.ok) {
        setError(json.error.message);
        return;
      }
      cancel();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Request failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setError(null);
    setRemovingId(id);
    try {
      const res = await fetch(`/api/integrations/custom/${id}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: true }
        | { ok: false; error: { message: string } }
        | null;
      if (!json || json.ok === false) {
        setError(json?.ok === false ? json.error.message : "Could not remove");
        return;
      }
      setIntegrations((prev) => prev.filter((row) => row.id !== id));
    } finally {
      setRemovingId(null);
    }
  }

  const advancedNeedsHeader = useMemo(
    () =>
      form.loginStyle === "advanced" &&
      (form.advancedScheme === "header" || form.advancedScheme === "query"),
    [form.loginStyle, form.advancedScheme]
  );

  const advancedNeedsSecret = useMemo(
    () => form.loginStyle === "advanced" && form.advancedScheme !== "none",
    [form.loginStyle, form.advancedScheme]
  );

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-parchment">
            Custom integrations
          </h3>
          <p className="text-xs text-parchment/50 mt-1">
            Connect the apps and services your coworker should use: CRMs,
            scheduling tools, order systems, anything with an API. Your
            sign-in details are stored encrypted and never sent to the AI.
          </p>
        </div>
        {!formOpen ? (
          <Button type="button" variant="secondary" size="sm" onClick={startCreate}>
            Add a service
          </Button>
        ) : null}
      </div>

      {integrations.length > 0 ? (
        <ul className="divide-y divide-parchment/10 mt-3">
          {integrations.map((row) => (
            <li
              key={row.id}
              className="py-3 flex flex-wrap items-start justify-between gap-3"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm text-parchment/90 font-medium">
                    {row.label}
                  </span>
                  {!row.is_active ? (
                    <span className="text-[10px] uppercase tracking-wider text-parchment/45 border border-parchment/15 rounded px-1 py-0.5">
                      paused
                    </span>
                  ) : null}
                  <span className="text-[10px] uppercase tracking-wider text-parchment/45 border border-parchment/15 rounded px-1 py-0.5">
                    {SCHEME_BADGE_LABEL[row.auth_scheme]}
                  </span>
                </div>
                <p className="text-xs text-parchment/50 truncate mt-0.5">
                  {row.base_url}
                  {row.header_name ? ` · ${row.header_name}` : ""}
                </p>
                {row.description ? (
                  <p className="text-xs text-parchment/60 mt-1">
                    {row.description}
                  </p>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => startEdit(row)}
                >
                  Edit
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => remove(row.id)}
                  loading={removingId === row.id}
                >
                  Remove
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : !formOpen ? (
        <p className="text-xs text-parchment/45 mt-3">
          No services connected yet. Click <span className="text-parchment/70">Add a service</span> to set one up.
        </p>
      ) : null}

      {formOpen ? (
        <form
          className="mt-4 space-y-4 border-t border-parchment/10 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">Service name</span>
              <input
                type="text"
                required
                maxLength={80}
                placeholder="Acme CRM"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
              />
              <span className="text-[11px] text-parchment/45 mt-0.5">
                {`A short name your coworker can refer to (e.g. "Acme CRM").`}
              </span>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">Service web address</span>
              <input
                type="url"
                required
                placeholder="https://api.acme.com"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
              />
              <span className="text-[11px] text-parchment/45 mt-0.5">
                {`The API web address for your service. Find this in the service's API docs (sometimes labeled "API URL" or "Base URL"). Must start with `}
                <span className="text-parchment/70">https://</span>.
              </span>
            </label>
          </div>

          <fieldset className="flex flex-col gap-2">
            <legend className="text-xs text-parchment/70 mb-1">
              How does your coworker log in to this service?
            </legend>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <LoginChoice
                checked={form.loginStyle === "key"}
                onChange={() => setForm((f) => ({ ...f, loginStyle: "key" }))}
                title="API key"
                hint="Most common. The service gives you a key or token to paste in."
              />
              <LoginChoice
                checked={form.loginStyle === "password"}
                onChange={() => setForm((f) => ({ ...f, loginStyle: "password" }))}
                title="Username and password"
                hint="The service signs you in with the same credentials you use on its website."
              />
              <LoginChoice
                checked={form.loginStyle === "none"}
                onChange={() => setForm((f) => ({ ...f, loginStyle: "none" }))}
                title="No login needed"
                hint="The service is public and doesn't require any credentials."
              />
              <LoginChoice
                checked={form.loginStyle === "advanced"}
                onChange={() =>
                  setForm((f) => ({ ...f, loginStyle: "advanced" }))
                }
                title="Advanced…"
                hint="For services that use a custom header or URL parameter."
              />
            </div>
          </fieldset>

          {form.loginStyle === "key" ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">
                API key
                {isEdit ? (
                  <span className="text-parchment/45 ml-1">
                    (leave blank to keep your existing key)
                  </span>
                ) : null}
              </span>
              <input
                type="password"
                autoComplete="off"
                maxLength={4096}
                placeholder="paste your API key here"
                value={form.apiKey}
                onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal font-mono"
              />
              <span className="text-[11px] text-parchment/45 mt-0.5">
                {`Some services call this an "API token", "access key", or "secret key". Look in your account's developer or API settings.`}
              </span>
            </label>
          ) : null}

          {form.loginStyle === "password" ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-parchment/70">Username</span>
                <input
                  type="text"
                  autoComplete="off"
                  maxLength={500}
                  placeholder={isEdit ? "leave blank to keep existing" : "your username"}
                  value={form.username}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, username: e.target.value }))
                  }
                  className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
                />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs text-parchment/70">Password</span>
                <input
                  type="password"
                  autoComplete="off"
                  maxLength={4096}
                  placeholder={isEdit ? "leave blank to keep existing" : "your password"}
                  value={form.password}
                  onChange={(e) =>
                    setForm((f) => ({ ...f, password: e.target.value }))
                  }
                  className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
                />
              </label>
              {isEdit ? (
                <p className="sm:col-span-2 text-[11px] text-parchment/45 -mt-1">
                  {`To rotate your credentials, fill in BOTH fields. Leave both blank to keep what's already stored.`}
                </p>
              ) : null}
            </div>
          ) : null}

          {form.loginStyle === "advanced" ? (
            <div className="rounded-md border border-parchment/15 bg-deep-ink/30 p-3 space-y-3">
              <label className="flex flex-col gap-1">
                <span className="text-xs text-parchment/70">Authentication style</span>
                <select
                  value={form.advancedScheme}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      advancedScheme: e.target.value as AuthScheme
                    }))
                  }
                  className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment focus:outline-none focus:ring-2 focus:ring-signal-teal"
                >
                  {SCHEME_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
                <span className="text-[11px] text-parchment/45 mt-0.5">
                  {SCHEME_HINTS[form.advancedScheme]}
                </span>
              </label>

              {advancedNeedsHeader ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-parchment/70">
                    {form.advancedScheme === "query"
                      ? "URL parameter name"
                      : "Header name"}
                  </span>
                  <input
                    type="text"
                    required
                    maxLength={128}
                    placeholder={
                      form.advancedScheme === "query" ? "api_key" : "X-API-Key"
                    }
                    value={form.headerName}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, headerName: e.target.value }))
                    }
                    className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
                  />
                </label>
              ) : null}

              {advancedNeedsSecret ? (
                <label className="flex flex-col gap-1">
                  <span className="text-xs text-parchment/70">
                    Credential
                    {isEdit ? (
                      <span className="text-parchment/45 ml-1">
                        (leave blank to keep existing)
                      </span>
                    ) : null}
                  </span>
                  <input
                    type="password"
                    autoComplete="off"
                    maxLength={4096}
                    placeholder={
                      form.advancedScheme === "basic"
                        ? "username:password"
                        : "paste credential"
                    }
                    value={form.advancedSecret}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, advancedSecret: e.target.value }))
                    }
                    className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal font-mono"
                  />
                </label>
              ) : null}
            </div>
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-parchment/70">
              What should your coworker use this for?{" "}
              <span className="text-parchment/45">(optional)</span>
            </span>
            <textarea
              maxLength={500}
              rows={2}
              placeholder="Look up customer contacts and update deals on Acme CRM."
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
            />
            <span className="text-[11px] text-parchment/45 mt-0.5">
              A one-liner helps your coworker pick the right service when
              handling a customer.
            </span>
          </label>

          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) =>
                setForm((f) => ({ ...f, isActive: e.target.checked }))
              }
            />
            Active; your coworker can call this service
          </label>

          {error ? (
            <p className="text-xs text-spark-orange" role="alert">
              {error}
            </p>
          ) : null}

          <div className="flex gap-2 justify-end">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancel}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" size="sm" loading={busy}>
              {isEdit ? "Save changes" : "Add service"}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

/**
 * Single radio-tile inside the "How does your coworker log in?" group.
 * The radio input is visually-hidden; the surrounding label provides
 * the click target plus accessible name for screen readers.
 */
function LoginChoice({
  checked,
  onChange,
  title,
  hint
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={`flex items-start gap-3 cursor-pointer rounded-md border px-3 py-2.5 transition-colors ${
        checked
          ? "border-signal-teal/70 bg-signal-teal/10"
          : "border-parchment/15 bg-deep-ink/30 hover:bg-deep-ink/50"
      }`}
    >
      <input
        type="radio"
        name="custom-integration-login-style"
        checked={checked}
        onChange={onChange}
        className="mt-0.5 accent-signal-teal"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm text-parchment/90">{title}</span>
        <span className="text-[11px] text-parchment/50">{hint}</span>
      </span>
    </label>
  );
}

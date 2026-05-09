"use client";

/**
 * "Custom integrations" management card for /dashboard/integrations.
 *
 * Lets the owner register `(label, base_url, auth_scheme, secret)`
 * triples that the Rowboat agent can call via the `http_api_call` tool
 * without ever seeing the credential. Talks to:
 *   - GET    /api/integrations/custom?businessId=...   (list)
 *   - POST   /api/integrations/custom                  (create)
 *   - PATCH  /api/integrations/custom/[id]             (update)
 *   - DELETE /api/integrations/custom/[id]             (remove)
 *
 * Every fetch is owner-authenticated via the same Supabase session
 * cookie the rest of the dashboard uses; the API also checks
 * requireOwner(businessId).
 *
 * Why the secret is split into "stored vs replace": the GET endpoint
 * returns a `has_secret` boolean instead of the cleartext, so the edit
 * form starts with an empty input. Submitting an empty string is
 * coerced to "leave existing secret alone" client-side; only an
 * explicit non-empty value rotates the credential.
 */

import { useState } from "react";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";

type AuthScheme = "bearer" | "header" | "basic" | "query" | "none";

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

const SCHEME_OPTIONS: { value: AuthScheme; label: string }[] = [
  { value: "bearer", label: "Bearer token (Authorization header)" },
  { value: "header", label: "Custom header (e.g. X-API-Key)" },
  { value: "basic", label: "Basic auth (username:password)" },
  { value: "query", label: "Query string parameter" },
  { value: "none", label: "No authentication (public APIs)" }
];

type FormState = {
  id: string | null;
  label: string;
  baseUrl: string;
  authScheme: AuthScheme;
  headerName: string;
  secret: string;
  description: string;
  isActive: boolean;
};

const EMPTY_FORM: FormState = {
  id: null,
  label: "",
  baseUrl: "",
  authScheme: "bearer",
  headerName: "",
  secret: "",
  description: "",
  isActive: true
};

export function CustomIntegrationsCard({ businessId, initialIntegrations }: Props) {
  const [integrations, setIntegrations] =
    useState<CustomIntegration[]>(initialIntegrations);
  const [formOpen, setFormOpen] = useState(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);

  function startCreate() {
    setForm(EMPTY_FORM);
    setError(null);
    setFormOpen(true);
  }

  function startEdit(row: CustomIntegration) {
    setForm({
      id: row.id,
      label: row.label,
      baseUrl: row.base_url,
      authScheme: row.auth_scheme,
      headerName: row.header_name ?? "",
      secret: "",
      description: row.description ?? "",
      isActive: row.is_active
    });
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

  async function submit() {
    setError(null);
    setBusy(true);
    try {
      const isEdit = form.id !== null;
      const url = isEdit
        ? `/api/integrations/custom/${form.id}`
        : "/api/integrations/custom";
      const payload: Record<string, unknown> = {
        businessId,
        label: form.label,
        baseUrl: form.baseUrl,
        authScheme: form.authScheme,
        headerName:
          form.authScheme === "header" || form.authScheme === "query"
            ? form.headerName
            : null,
        description: form.description || null,
        isActive: form.isActive
      };
      // Only send a secret when the user typed one. On edit this means
      // "leave the existing stored secret alone"; on create the route's
      // validator will surface a missing-secret error if the scheme
      // requires one.
      if (form.secret.length > 0) payload.secret = form.secret;
      const res = await fetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
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

  const needsHeaderName =
    form.authScheme === "header" || form.authScheme === "query";

  return (
    <Card>
      <div className="flex items-center justify-between mb-2">
        <div>
          <h3 className="text-sm font-semibold text-parchment">
            Custom integrations
          </h3>
          <p className="text-xs text-parchment/50 mt-1">
            Register API endpoints your coworker can call. Credentials are
            encrypted at rest and never sent to the model.
          </p>
        </div>
        {!formOpen ? (
          <Button type="button" variant="secondary" size="sm" onClick={startCreate}>
            Add integration
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
                      disabled
                    </span>
                  ) : null}
                  <span className="text-[10px] uppercase tracking-wider text-parchment/45 border border-parchment/15 rounded px-1 py-0.5">
                    {row.auth_scheme}
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
          No custom integrations yet. Click <span className="text-parchment/70">Add integration</span> to register one.
        </p>
      ) : null}

      {formOpen ? (
        <form
          className="mt-4 space-y-3 border-t border-parchment/10 pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">Label</span>
              <input
                type="text"
                required
                maxLength={80}
                placeholder="Acme CRM"
                value={form.label}
                onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))}
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">Base URL (https only)</span>
              <input
                type="url"
                required
                placeholder="https://api.acme.com/v2"
                value={form.baseUrl}
                onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
              />
            </label>
          </div>

          <label className="flex flex-col gap-1">
            <span className="text-xs text-parchment/70">Authentication</span>
            <select
              value={form.authScheme}
              onChange={(e) =>
                setForm((f) => ({ ...f, authScheme: e.target.value as AuthScheme }))
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
              {SCHEME_HINTS[form.authScheme]}
            </span>
          </label>

          {needsHeaderName ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">
                {form.authScheme === "query" ? "Query param name" : "Header name"}
              </span>
              <input
                type="text"
                required
                maxLength={128}
                placeholder={
                  form.authScheme === "query" ? "api_key" : "X-API-Key"
                }
                value={form.headerName}
                onChange={(e) =>
                  setForm((f) => ({ ...f, headerName: e.target.value }))
                }
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
              />
            </label>
          ) : null}

          {form.authScheme !== "none" ? (
            <label className="flex flex-col gap-1">
              <span className="text-xs text-parchment/70">
                Secret
                {form.id !== null ? (
                  <span className="text-parchment/45 ml-1">
                    (leave blank to keep the existing stored secret)
                  </span>
                ) : null}
              </span>
              <input
                type="password"
                autoComplete="off"
                maxLength={4096}
                placeholder={
                  form.authScheme === "basic" ? "username:password" : "paste credential"
                }
                value={form.secret}
                onChange={(e) => setForm((f) => ({ ...f, secret: e.target.value }))}
                className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal font-mono"
              />
            </label>
          ) : null}

          <label className="flex flex-col gap-1">
            <span className="text-xs text-parchment/70">
              Description (helps the agent pick the right one)
            </span>
            <textarea
              maxLength={500}
              rows={2}
              placeholder="Lookup contacts and update deals on Acme CRM."
              value={form.description}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
              className="rounded-md bg-deep-ink/50 border border-parchment/20 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
            />
          </label>

          <label className="flex items-center gap-2 text-xs text-parchment/70">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) =>
                setForm((f) => ({ ...f, isActive: e.target.checked }))
              }
            />
            Active (the agent can call this integration)
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
              {form.id !== null ? "Save changes" : "Add integration"}
            </Button>
          </div>
        </form>
      ) : null}
    </Card>
  );
}

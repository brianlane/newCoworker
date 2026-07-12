"use client";

/**
 * The signing form on the public /sign/[token] page: typed legal name +
 * explicit e-sign consent checkbox. On success the page reloads into its
 * signed-certificate state (the server re-resolves the request).
 */

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SignDocumentForm({
  token,
  contentSha256
}: {
  token: string;
  /** Fingerprint of the content rendered above — binds view to signature. */
  contentSha256: string;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [consent, setConsent] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sign() {
    if (!name.trim()) {
      setError("Type your full legal name to sign.");
      return;
    }
    if (!consent) {
      setError("Please confirm you agree to sign electronically.");
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch(`/api/public/sign/${encodeURIComponent(token)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ signatureName: name.trim(), consent, contentSha256 })
      });
      const json = (await res.json().catch(() => null)) as
        | { ok: boolean; detail?: string }
        | null;
      if (json?.ok) {
        router.refresh();
        return;
      }
      setError(
        json?.detail === "already_signed"
          ? "This document has already been signed."
          : json?.detail === "content_changed"
            ? "This document was updated after you opened it. Refresh the page to review the current version before signing."
            : json?.detail === "rate_limited"
              ? "Too many attempts — wait a minute and try again."
              : "Signing failed. Refresh the page and try again."
      );
    } catch {
      setError("Signing failed. Check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="rounded-lg border border-parchment/15 bg-deep-ink/60 p-4">
      <h2 className="text-sm font-semibold text-parchment/70">Sign this document</h2>
      <div className="mt-3 space-y-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="sign-name">
            Full legal name
          </label>
          <input
            id="sign-name"
            className="w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:border-signal-teal focus:outline-none"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Jane Q. Customer"
            autoComplete="name"
          />
          {name.trim() ? (
            <p className="mt-2 select-none font-serif text-2xl italic text-parchment/90">
              {name.trim()}
            </p>
          ) : null}
        </div>
        <label className="flex items-start gap-2 text-sm text-parchment/70">
          <input
            type="checkbox"
            checked={consent}
            onChange={(e) => setConsent(e.target.checked)}
            className="mt-0.5"
          />
          <span>
            I agree that typing my name above constitutes my legal electronic signature on this
            document, and I consent to do business electronically.
          </span>
        </label>
        <button
          type="button"
          onClick={sign}
          disabled={submitting}
          className="rounded-md bg-signal-teal px-4 py-2 text-sm font-semibold text-deep-ink transition-opacity hover:opacity-90 disabled:opacity-50"
        >
          {submitting ? "Signing…" : "Sign document"}
        </button>
        {error ? (
          <p className="text-xs text-spark-orange" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </section>
  );
}

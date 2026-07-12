/**
 * Public document-signing page (BizBlasts client-document signing port).
 *
 * The recipient of a signature request lands here from the tokenized link,
 * reads the document (with a download link for the original file), and
 * signs by typing their legal name with an explicit e-sign consent
 * checkbox. A signed request renders the signature certificate instead of
 * the form. Every non-servable state 404s, matching the docs download
 * route (no reason leaks to strangers probing tokens).
 */

import { notFound } from "next/navigation";
import {
  fingerprintDocumentContent,
  markSignatureRequestOpened,
  resolveSignatureRequestByToken
} from "@/lib/documents/signing";
import { SignDocumentForm } from "@/components/sign/SignDocumentForm";

export const dynamic = "force-dynamic";

export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!token || token.length > 200) notFound();

  let resolved;
  try {
    resolved = await resolveSignatureRequestByToken(token);
  } catch {
    notFound();
  }
  if (!resolved.ok) notFound();
  const { request, document } = resolved;

  // First open flips sent → viewed (BizBlasts' pending_signature analogue).
  await markSignatureRequestOpened(request);

  const signed = request.status === "signed";

  return (
    <main className="min-h-screen bg-deep-ink px-4 py-10 text-parchment">
      <div className="mx-auto max-w-2xl space-y-6">
        <header>
          <p className="text-xs uppercase tracking-wide text-parchment/40">Signature requested</p>
          <h1 className="mt-1 text-2xl font-bold">{document.title}</h1>
          {request.signer_name ? (
            <p className="mt-1 text-sm text-parchment/60">Prepared for {request.signer_name}</p>
          ) : null}
          {request.message ? (
            <p className="mt-3 rounded-md border border-parchment/15 bg-parchment/5 px-3 py-2 text-sm text-parchment/80">
              {request.message}
            </p>
          ) : null}
        </header>

        <section className="rounded-lg border border-parchment/15 bg-deep-ink/60 p-4">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-parchment/70">Document</h2>
            <a
              href={`/api/public/sign/${encodeURIComponent(token)}/file`}
              className="text-xs text-signal-teal hover:underline"
              target="_blank"
              rel="noopener noreferrer"
            >
              Download original
            </a>
          </div>
          <pre className="mt-3 max-h-[28rem] overflow-y-auto whitespace-pre-wrap font-sans text-sm leading-relaxed text-parchment/90">
            {document.content_md}
          </pre>
        </section>

        {signed ? (
          <section className="rounded-lg border border-signal-teal/40 bg-signal-teal/10 p-4">
            <h2 className="text-sm font-semibold text-signal-teal">Signed</h2>
            <dl className="mt-2 space-y-1 text-sm text-parchment/80">
              <div>
                <dt className="inline text-parchment/50">Signed by: </dt>
                <dd className="inline">{request.signature_name}</dd>
              </div>
              <div>
                <dt className="inline text-parchment/50">Signed at: </dt>
                <dd className="inline">{request.signed_at}</dd>
              </div>
              <div>
                <dt className="inline text-parchment/50">Content fingerprint (SHA-256): </dt>
                <dd className="inline break-all font-mono text-xs">{request.content_sha256}</dd>
              </div>
            </dl>
            <p className="mt-3 text-xs text-parchment/50">
              This record certifies the document above was electronically signed. The fingerprint
              identifies the exact content that was on screen at signing.
            </p>
          </section>
        ) : (
          // The sha pins what was SHOWN: signing submits it back and the
          // server refuses if the document changed after this render.
          <SignDocumentForm
            token={token}
            contentSha256={fingerprintDocumentContent(document.content_md)}
          />
        )}
      </div>
    </main>
  );
}

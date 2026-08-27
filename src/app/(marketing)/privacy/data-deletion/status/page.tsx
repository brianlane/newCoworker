import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";
import { contactEmail as resolveContactEmail } from "@/lib/marketing/contact-email";
import { getMetaDeletionRequestByCode } from "@/lib/meta/deletion-requests";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Data Deletion Request Status",
  description:
    "Check the status of a data deletion request made through Facebook or Instagram, using the confirmation code you were given.",
  // Not a page anyone should reach from search: it is only meaningful with a
  // specific code, and the codes belong to individual people.
  robots: { index: false, follow: false }
};

/**
 * The human-readable status page Meta's Data Deletion Request callback points
 * people at. Meta requires the confirmation code to lead somewhere that
 * explains, in plain language, what happened to the request, including an
 * honest reason when nothing was deleted.
 *
 * Deliberately shows NO personal data, not even the app-scoped id: the code
 * arrives in a URL that can end up in browser history or a shared link, so
 * the page confirms what was done without exposing who it was done for.
 */
export default async function DataDeletionStatusPage({
  searchParams
}: {
  searchParams: Promise<{ code?: string }>;
}) {
  const contactEmail = resolveContactEmail();
  const { code } = await searchParams;
  const trimmed = (code ?? "").trim();
  const request = trimmed ? await getMetaDeletionRequestByCode(trimmed).catch(() => null) : null;

  return (
    <LegalPage
      eyebrow="Privacy"
      title="Data Deletion Request Status"
      summary="The status of a data deletion request made by removing New Coworker from your Facebook account."
      // A per-request page, not a policy: the meaningful date is the one on
      // the request itself, shown below, so this shows when the request came in.
      effectiveDate={
        request
          ? new Date(request.requested_at).toLocaleDateString("en-US", {
              year: "numeric",
              month: "long",
              day: "numeric"
            })
          : "-"
      }
    >
      {!trimmed ? (
        <LegalSection title="No confirmation code">
          <p>
            This page needs the confirmation code you were given when you made the request.
            Open the link exactly as Facebook showed it, or email{" "}
            <a className="text-signal-teal hover:underline" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>{" "}
            with your code and we will look it up.
          </p>
        </LegalSection>
      ) : !request ? (
        <LegalSection title="We could not find that code">
          <p>
            Confirmation code <strong>{trimmed}</strong> does not match any request we have
            recorded. Check for a typo, or email{" "}
            <a className="text-signal-teal hover:underline" href={`mailto:${contactEmail}`}>
              {contactEmail}
            </a>{" "}
            and we will find it for you.
          </p>
        </LegalSection>
      ) : (
        <>
          <LegalSection title="Your request">
            <p>
              Confirmation code <strong>{request.confirmation_code}</strong>, received{" "}
              {new Date(request.requested_at).toLocaleDateString("en-US", {
                year: "numeric",
                month: "long",
                day: "numeric"
              })}
              .
            </p>
          </LegalSection>

          <LegalSection title="What happened">
            {request.status === "completed" ? (
              <p>
                <strong>Completed.</strong> We deleted everything Facebook gave us about you:
                the access tokens for your account, your name as Facebook reported it, and the
                Facebook Page and Instagram account identifiers we stored. The connection
                records themselves were removed, not just emptied. This took effect immediately
                and is not recoverable.
              </p>
            ) : request.status === "no_data" ? (
              <p>
                <strong>Nothing to delete.</strong> We hold no data from Facebook about you. This
                normally means the connection was already removed, or was never completed. No
                action was needed and none was taken.
              </p>
            ) : (
              <p>
                <strong>We hit a problem.</strong> Your request reached us and is recorded, but
                it did not finish cleanly. Email{" "}
                <a className="text-signal-teal hover:underline" href={`mailto:${contactEmail}`}>
                  {contactEmail}
                </a>{" "}
                quoting this code and we will complete it by hand and confirm to you.
              </p>
            )}
          </LegalSection>

          <LegalSection title="What this does not cover">
            <p>
              This request covers data <strong>Facebook gave us about you</strong>. It does not
              delete records a business independently holds about its own customers in its New
              Coworker account, such as a contact record created when you texted, emailed, or
              called that business. Those belong to that business, and it decides on their
              deletion. To have those removed, email{" "}
              <a className="text-signal-teal hover:underline" href={`mailto:${contactEmail}`}>
                {contactEmail}
              </a>{" "}
              and we will pass your request to them, or see our{" "}
              <a className="text-signal-teal hover:underline" href="/privacy/data-deletion">
                Data Deletion Instructions
              </a>
              .
            </p>
          </LegalSection>
        </>
      )}
    </LegalPage>
  );
}

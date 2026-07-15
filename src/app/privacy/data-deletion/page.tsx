import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

const EFFECTIVE_DATE = "July 14, 2026";

export const metadata: Metadata = {
  title: "Data Deletion Instructions",
  description:
    "How to request deletion of your personal data from New Coworker, including data received through Facebook and Instagram lead forms.",
  alternates: {
    canonical: "/privacy/data-deletion"
  }
};

export default function DataDeletionPage() {
  const contactEmail = process.env.CONTACT_EMAIL ?? "team@newcoworker.com";

  return (
    <LegalPage
      eyebrow="Privacy"
      title="Data Deletion Instructions"
      summary="You can request deletion of your personal data from New Coworker at any time — whether you are a business using our platform or an end user (customer, lead, or contact) of a business that uses it."
      effectiveDate={EFFECTIVE_DATE}
      contactEmail={contactEmail}
    >
      <LegalSection title="1. Who this covers">
        <p>
          These instructions apply to anyone whose personal information is processed by New
          Coworker, including information submitted through Facebook or Instagram lead ads
          forms, text messages, phone calls, emails, and web chat handled by a business&apos;s
          AI coworker.
        </p>
      </LegalSection>

      <LegalSection title="2. How to request deletion">
        <p>
          Email{" "}
          <a className="text-signal-teal hover:underline" href={`mailto:${contactEmail}`}>
            {contactEmail}
          </a>{" "}
          with the subject line <strong>&quot;Data deletion request&quot;</strong> and include
          the phone number and/or email address you want removed. If your information was
          shared with a specific business (for example, through their Facebook lead form),
          name that business if you can — it helps us locate every record.
        </p>
        <p>
          We verify each request and then delete the person&apos;s records across every
          content store we operate — contact profiles, conversation and call history, text
          and email logs — including tenant-hosted data stores where applicable. The audit
          trail retains only a cryptographic fingerprint of the deleted identifier, never
          the identifier itself.
        </p>
      </LegalSection>

      <LegalSection title="3. Timing and confirmation">
        <p>
          We action verified requests within 30 days (usually much sooner) and confirm by
          reply once the deletion is complete. Requests made under PIPEDA, Quebec Law 25,
          CCPA, GDPR, or similar laws are handled through the same process.
        </p>
      </LegalSection>

      <LegalSection title="4. Facebook and Instagram lead data">
        <p>
          If you submitted your information through a Facebook or Instagram lead form
          connected to New Coworker, the request above removes it from our systems. Meta
          retains its own copy of lead form submissions under Meta&apos;s policies — you can
          also manage that data from your Facebook account settings.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

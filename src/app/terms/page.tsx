import type { Metadata } from "next";
import { LegalPage, LegalSection } from "@/components/legal/LegalPage";

const EFFECTIVE_DATE = "April 2, 2026";

export const metadata: Metadata = {
  title: "Terms of Service",
  description: "The legal terms governing use of the New Coworker website, software, and related services.",
  alternates: {
    canonical: "/terms"
  }
};

export default function TermsPage() {
  const contactEmail = process.env.CONTACT_EMAIL ?? "newcoworkerteam@gmail.com";

  return (
    <LegalPage
      eyebrow="Terms of Service"
      title="Terms of Service"
      summary="These Terms of Service govern access to and use of the New Coworker website, software, AI communications tools, dashboard, and related services. By using the service, you agree to these terms."
      effectiveDate={EFFECTIVE_DATE}
      contactEmail={contactEmail}
    >
      <LegalSection title="1. Agreement and Eligibility">
        <p>
          These Terms form a binding agreement between you and New Coworker. If you use the service on behalf
          of a company or other entity, you represent that you have authority to bind that entity, and
          references to “you” include that entity.
        </p>
        <p>
          You may use the service only if you can form a binding contract and your use complies with applicable laws.
        </p>
      </LegalSection>

      <LegalSection title="2. The Service">
        <p>
          New Coworker provides tools that help businesses configure and operate AI-enabled workflows, including
          voice, text messaging, email, onboarding automation, memory management, dashboards, and related
          infrastructure or support services. Features vary by subscription tier and may change over time.
        </p>
      </LegalSection>

      <LegalSection title="3. Accounts and Security">
        <p>
          You are responsible for the accuracy of account information, the security of account credentials, and
          all activity that occurs under your account. You must promptly notify us of any unauthorized use or
          security incident affecting your account or workspace.
        </p>
      </LegalSection>

      <LegalSection title="4. Customer Responsibilities">
        <p>You are responsible for:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>All content, prompts, knowledge-base material, workflows, and communications you or your users submit to the service.</li>
          <li>Obtaining any rights, notices, and consents required to contact end users or process their information.</li>
          <li>Compliance with laws applicable to your business, including consumer protection, privacy, telemarketing, TCPA, anti-spam, call-recording, marketing, sector-specific, and licensing rules.</li>
          <li>Reviewing AI-generated output and configuring the service appropriately for your use case.</li>
          <li>Maintaining a human escalation path where your business or applicable law requires one.</li>
        </ul>
      </LegalSection>

      <LegalSection title="5. Prohibited Uses">
        <p>You may not use the service to:</p>
        <ul className="list-disc space-y-2 pl-5">
          <li>Violate law, infringe rights, or engage in fraud, deception, harassment, or harmful conduct.</li>
          <li>Send unlawful spam, place unlawful robocalls, or contact recipients without required consent.</li>
          <li>Process or transmit highly sensitive data where the service is not designed or approved for that purpose.</li>
          <li>Reverse engineer, interfere with, disrupt, or bypass security or usage limits of the service.</li>
          <li>Use the service to build or benchmark a competing product, except to the extent prohibited by law.</li>
        </ul>
      </LegalSection>

      <LegalSection title="6. AI Output and Operational Risk">
        <p>
          AI-generated content may be incomplete, inaccurate, biased, or inappropriate for a given context.
          You remain responsible for reviewing, approving, and using outputs in a lawful and commercially
          reasonable manner. New Coworker does not guarantee that generated output will be correct, suitable,
          or compliant for your particular business.
        </p>
      </LegalSection>

      <LegalSection title="7. Messaging, Calling, and Consent">
        <p>
          If you use calling or messaging features, you are solely responsible for ensuring you have all legally
          required consents, disclosures, and opt-out mechanisms. You must honor recipient preferences and
          maintain practices consistent with applicable telecom and marketing laws.
        </p>
        <p>
          Standard carrier rules, message and data rates, throughput limits, and third-party platform policies may apply.
        </p>
      </LegalSection>

      <LegalSection title="8. Fees, Billing, and Renewals">
        <p>
          Paid subscriptions are billed in advance according to the plan and billing period you select. By
          purchasing a subscription, you authorize us and our payment processor to charge the applicable fees,
          taxes, and any renewal charges using your selected payment method.
        </p>
        <p>
          Unless otherwise stated in writing, subscriptions automatically renew at the end of the applicable
          billing period until canceled. Pricing, included usage, and plan features may vary by tier and may be
          updated prospectively.
        </p>
      </LegalSection>

      <LegalSection title="9. Refunds">
        <p>
          The website currently advertises a 30-day money-back guarantee for certain plans. Any refund rights
          are limited to the specific offer presented at purchase and may be denied for abuse, fraud, repeated
          refund requests, or material violation of these Terms. Except as required by law or expressly stated
          in writing, fees are otherwise non-refundable.
        </p>
      </LegalSection>

      <LegalSection title="10. Suspension and Termination">
        <p>
          We may suspend or terminate access to the service, in whole or in part, if we reasonably believe you
          have violated these Terms, created legal or security risk, failed to pay amounts due, or used the
          service in a way that could harm us, the platform, or others.
        </p>
        <p>
          You may stop using the service at any time. Termination does not relieve you of payment obligations
          already incurred.
        </p>
      </LegalSection>

      <LegalSection title="11. Intellectual Property">
        <p>
          New Coworker and its licensors retain all rights, title, and interest in the service, including the
          software, design, branding, documentation, and underlying technology. Subject to these Terms, we grant
          you a limited, non-exclusive, non-transferable, revocable right to use the service during your subscription term.
        </p>
        <p>
          You retain rights in content you submit, but you grant us and our service providers a worldwide,
          limited license to host, use, process, reproduce, transmit, and display that content as necessary to
          operate, support, secure, and improve the service.
        </p>
      </LegalSection>

      <LegalSection title="12. Confidentiality">
        <p>
          Each party may receive non-public information from the other. The receiving party will use reasonable
          care to protect confidential information and use it only as needed to perform under these Terms, except
          where disclosure is required by law.
        </p>
      </LegalSection>

      <LegalSection title="13. Disclaimers">
        <p>
          THE SERVICE IS PROVIDED “AS IS” AND “AS AVAILABLE.” TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEW
          COWORKER DISCLAIMS ALL WARRANTIES, WHETHER EXPRESS, IMPLIED, STATUTORY, OR OTHERWISE, INCLUDING IMPLIED
          WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE, AND NON-INFRINGEMENT, AND ANY
          WARRANTIES ARISING FROM COURSE OF DEALING OR USAGE OF TRADE.
        </p>
      </LegalSection>

      <LegalSection title="14. Limitation of Liability">
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEW COWORKER WILL NOT BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
          SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES, OR FOR ANY LOSS OF PROFITS, REVENUE, DATA,
          GOODWILL, OR BUSINESS INTERRUPTION, ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS.
        </p>
        <p>
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEW COWORKER’S TOTAL LIABILITY FOR ALL CLAIMS ARISING OUT OF OR
          RELATING TO THE SERVICE OR THESE TERMS WILL NOT EXCEED THE AMOUNT YOU PAID TO NEW COWORKER FOR THE
          SERVICE DURING THE TWELVE MONTHS BEFORE THE EVENT GIVING RISE TO THE CLAIM.
        </p>
      </LegalSection>

      <LegalSection title="15. Indemnification">
        <p>
          You will defend, indemnify, and hold harmless New Coworker and its affiliates, officers, directors,
          employees, and agents from and against third-party claims, damages, liabilities, losses, and expenses,
          including reasonable attorneys’ fees, arising from your content, your use of the service, or your
          violation of these Terms or applicable law.
        </p>
      </LegalSection>

      <LegalSection title="16. Governing Law and Disputes">
        <p>
          These Terms are governed by the laws of the State of Arizona, without regard to conflict-of-law rules,
          unless applicable law requires otherwise. The state or federal courts located in Arizona will have
          exclusive jurisdiction over disputes arising out of or relating to these Terms or the service, and each
          party consents to those courts and venues.
        </p>
      </LegalSection>

      <LegalSection title="17. Changes to the Service or Terms">
        <p>
          We may modify the service or these Terms from time to time. If we make material changes, we may provide
          notice by posting an updated version on the site, updating the effective date, or using other
          reasonable means. Continued use of the service after the changes take effect constitutes acceptance.
        </p>
      </LegalSection>

      <LegalSection title="18. General">
        <p>
          These Terms, together with any additional written terms we provide for specific services, are the
          entire agreement between you and New Coworker regarding the service. If any provision is held
          unenforceable, the remaining provisions will remain in effect. Failure to enforce a provision is not a waiver.
        </p>
      </LegalSection>

      <LegalSection title="19. Contact">
        <p>
          Questions about these Terms may be sent to{" "}
          <a className="text-signal-teal hover:text-parchment" href={`mailto:${contactEmail}`}>{contactEmail}</a>.
        </p>
      </LegalSection>
    </LegalPage>
  );
}

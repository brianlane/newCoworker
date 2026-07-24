import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * Step-by-step test plan for Google OAuth verification reviewers (Trust and
 * Safety). Linked from the verification reply and the demo video description;
 * test credentials are provided in the reply itself, never on this page.
 * Noindexed: it is reviewer documentation, not marketing. English-only by
 * policy, like the Zoom review test plan.
 */

export const metadata: Metadata = {
  title: "Google OAuth Review: Test Plan",
  robots: { index: false, follow: false }
};

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <li className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-6">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">Step {n}</p>
      <h3 className="mt-2 font-semibold text-parchment">{title}</h3>
      <div className="mt-2 space-y-2 text-sm leading-relaxed text-parchment/60">{children}</div>
    </li>
  );
}

export default function GoogleReviewTestPlanPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <section className="mx-auto max-w-3xl px-6 pb-24 pt-16">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
          New Coworker · Google OAuth verification review
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-parchment">
          Reviewer test plan
        </h1>
        <p className="mt-4 text-parchment/60">
          New Coworker is an AI coworker for small businesses: it answers the phone, replies to
          SMS, email, and web chat, and books appointments. The business owner connects their own
          Google account so the coworker can book appointments on their calendar
          (<code className="text-xs text-claw-green">calendar.events</code>) and read, reply to,
          and mark handled inbound customer email in their Gmail
          (<code className="text-xs text-claw-green">gmail.modify</code>). All access is
          server-side; owners can disconnect at any time. The steps below walk through the grant,
          each scope in use, and removal.{" "}
          <b>Test credentials are provided in the verification reply.</b>
        </p>

        <h2 className="mt-10 text-lg font-semibold text-parchment">Prerequisites</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-parchment/60">
          <li>The reviewer test account credentials from the verification reply.</li>
          <li>
            Any Google account to connect (a personal Gmail account works). The account you
            connect is the &quot;owner mailbox and calendar&quot; in the steps below.
          </li>
          <li>
            A second email account (any provider) to play the customer in Step 4.
          </li>
        </ul>

        <ol className="mt-10 space-y-4">
          <Step n={1} title="Sign in to the test account">
            <p>
              Go to{" "}
              <Link href="/login" className="text-claw-green hover:underline">
                newcoworker.com/login
              </Link>{" "}
              and sign in with the reviewer credentials from the verification reply (no MFA or
              phone verification is configured on the account). You land on the business
              dashboard of the pre-provisioned review sandbox.
            </p>
          </Step>

          <Step n={2} title="Authorize Google (OAuth grant)">
            <p>
              Open <b>Dashboard → Integrations</b> and click <b>Connect Google</b> in the
              workspace connections card. The Google consent screen for <b>New Coworker</b>{" "}
              appears; the URL carries our single OAuth client id
              (<code className="text-xs text-claw-green">354099628168-…</code>) and the scope list
              shows exactly the declared scopes: calendar events plus Gmail read/send/modify,
              alongside basic profile. Complete the grant.
            </p>
            <p>
              Expected: you are returned to Dashboard → Integrations and the connection card shows
              the Google account&apos;s email address as <b>Connected</b>.
            </p>
          </Step>

          <Step n={3} title="calendar.events: book an appointment">
            <p>
              Open <b>Dashboard → Chat</b> (the owner&apos;s chat with their AI coworker) and
              send: <i>&quot;Book an appointment for John Smith tomorrow at 2pm, 30 minutes,
              phone +1 555 010 0000.&quot;</i>
            </p>
            <p>
              Expected: the coworker checks availability on the connected calendar, books the
              slot, and replies with a confirmation. In Google Calendar the new event appears on
              the connected account at that time. Rescheduling and canceling by chat move and
              remove the same event, which is why read-only or free/busy scopes are not
              sufficient.
            </p>
          </Step>

          <Step n={4} title="gmail.modify: read, reply from the owner's address, mark handled">
            <p>
              From your second (&quot;customer&quot;) account, send an email to the connected
              Gmail address; use the subject and body given in the verification reply so the
              sandbox&apos;s email-triggered flow matches it. Within about a minute the flow picks
              it up.
            </p>
            <p>
              Expected: the inbound email appears on <b>Dashboard → Emails</b> as the trigger of a
              flow run; the AI&apos;s reply is sent <b>from the connected Gmail address</b> (visible
              in the Gmail account&apos;s Sent folder); and the original message is <b>marked
              read</b> in the connected inbox, so the owner can see at a glance that their
              coworker handled it. Reading alone cannot send the reply and sending alone cannot
              read or mark the message, which is why the combined{" "}
              <code className="text-xs text-claw-green">gmail.modify</code> scope is requested.
            </p>
          </Step>

          <Step n={5} title="Remove the connection">
            <p>
              Back on <b>Dashboard → Integrations</b>, click <b>Disconnect</b> on the Google
              connection and confirm. Expected: the card returns to its disconnected state and the
              stored tokens are deleted. The grant can also be revoked from the Google
              account&apos;s security settings (Third-party access); the next dashboard visit
              shows the connection as needing reconnection.
            </p>
          </Step>
        </ol>

        <h2 className="mt-10 text-lg font-semibold text-parchment">Notes for reviewers</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-parchment/60">
          <li>
            OAuth is brokered by Nango (redirect URI on api.nango.dev); tokens are stored
            encrypted and used exclusively server-side. All endpoints are HTTPS-only (TLS 1.2+).
          </li>
          <li>
            Limited Use: Google user data is used only to provide the user-facing features above.
            It is not used for advertising, not sold, and not used to train generalized AI or ML
            models. Email content is processed by the Gemini API solely to draft the owner&apos;s
            replies.
          </li>
          <li>
            Owners can disconnect from the dashboard at any time; disconnect deletes the stored
            tokens.
          </li>
          <li>
            Questions during review:{" "}
            <Link href="/contact" className="text-claw-green hover:underline">
              newcoworker.com/contact
            </Link>{" "}
            or the developer contact email on the verification thread.
          </li>
        </ul>
      </section>

      <MarketingFooter />
    </div>
  );
}

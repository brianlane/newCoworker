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
          SMS, email, and web chat, books appointments, and runs a public self-serve booking
          page. The business owner connects their own Google account. Calendar access is split by
          least privilege: availability reads ride{" "}
          <code className="text-xs text-claw-green">calendar.events.freebusy</code>, new bookings
          land on an app-created &quot;NewCoworker&quot; calendar under{" "}
          <code className="text-xs text-claw-green">calendar.app.created</code>, and{" "}
          <code className="text-xs text-claw-green">calendar.events</code> manages appointments
          that live on the owner&apos;s own calendars. Inbound customer email is read, replied to
          from the owner&apos;s address, and marked handled under{" "}
          <code className="text-xs text-claw-green">gmail.modify</code>. All access is
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
            A second email account (any provider) to play the customer in Step 5.
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
              Open <b>Dashboard → Integrations → Workspace</b>, click <b>Connect workspace</b>,
              and choose <b>Google</b> in the connect window. The Google consent screen for{" "}
              <b>New Coworker</b> appears; the authorization URL carries our single OAuth client
              id (<code className="text-xs text-claw-green">354099628168-…</code>) and the
              permission list shows exactly the declared scopes: secondary (app-created)
              calendars, calendar availability, view/edit events, Gmail read/compose/send, and
              basic profile. Complete the grant.
            </p>
            <p>
              Expected: you are returned to Dashboard → Integrations and the connection card shows
              the Google account&apos;s email address as <b>Connected</b>.
            </p>
          </Step>

          <Step n={3} title="Calendar scopes: book, then manage the owner's own calendar">
            <p>
              Open <b>Dashboard → Chat</b> (the owner&apos;s chat with their AI coworker) and
              send: <i>&quot;Book an appointment for John Smith tomorrow at 2pm, 30 minutes,
              phone +1 555 010 0000.&quot;</i>
            </p>
            <p>
              Expected: the coworker checks availability (free/busy read,{" "}
              <code className="text-xs text-claw-green">calendar.events.freebusy</code>), books
              the slot, and replies with a confirmation. In Google Calendar the event appears on
              the app-created <b>NewCoworker</b> calendar
              (<code className="text-xs text-claw-green">calendar.app.created</code>). To see{" "}
              <code className="text-xs text-claw-green">calendar.events</code> specifically,
              create an event yourself on your primary calendar, then ask the coworker by chat to
              move or cancel it: managing events on the owner&apos;s own calendars is what the
              narrower scopes cannot do.
            </p>
          </Step>

          <Step n={4} title="calendar.events.freebusy: the public booking page">
            <p>
              Open <b>Dashboard → Bookings</b> (the page provisions itself on first visit) and
              copy the public booking link. Open it in a private window as a visitor: the page
              offers open slots computed from the connected calendar&apos;s free/busy data and
              business hours; no event details are ever shown. Book a slot.
            </p>
            <p>
              Expected: the booking confirmation appears, and the appointment lands on the
              NewCoworker calendar in Google Calendar, exactly like an AI-made booking.
            </p>
          </Step>

          <Step n={5} title="gmail.modify: read, reply, mark handled, and organize">
            <p>
              Open <b>Dashboard → AiFlows</b> and enable the pre-seeded email demo flow, choosing
              the mailbox you connected in Step 2 as its watched mailbox (one dropdown in the
              trigger; flows are bound to a specific connection, and yours did not exist until
              Step 2). Then, from your second (&quot;customer&quot;) account, send an email to the
              connected Gmail address using the subject given in the flow&apos;s trigger
              condition (also stated in the verification reply). Within about a minute the flow
              picks it up.
            </p>
            <p>
              Expected: the inbound email appears on <b>Dashboard → Emails</b> as the trigger of a
              flow run; the AI&apos;s reply is sent <b>from the connected Gmail address</b> (visible
              in the Gmail account&apos;s Sent folder); and the original message is <b>marked
              read</b> in the connected inbox. When the flow includes an{" "}
              <code className="text-xs text-claw-green">email_organize</code> step, the same
              modify API also applies the owner&apos;s labels or archives the message (removes
              INBOX). Reading alone cannot send the reply and sending alone cannot read, label,
              or mark the message, which is why the combined{" "}
              <code className="text-xs text-claw-green">gmail.modify</code> scope is requested.
            </p>
          </Step>

          <Step n={6} title="Remove the connection">
            <p>
              Back on <b>Dashboard → Integrations → Workspace</b>, click <b>Disconnect</b> on the
              Google connection and confirm. Expected: the connection disappears from the page
              and the stored tokens are deleted. The grant can also be revoked from the Google
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

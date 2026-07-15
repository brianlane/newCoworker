import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * Step-by-step test plan for Zoom Marketplace reviewers ("New Coworker
 * OAuth"). Linked from the submission's release notes; test credentials are
 * provided in the release notes themselves, never on this page. Noindexed:
 * it's reviewer documentation, not marketing.
 */

export const metadata: Metadata = {
  title: "Zoom App Review — Test Plan",
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

export default function ZoomReviewTestPlanPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <section className="mx-auto max-w-3xl px-6 pb-24 pt-16">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
          New Coworker OAuth · Zoom Marketplace review
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-parchment">
          Reviewer test plan
        </h1>
        <p className="mt-4 text-parchment/60">
          New Coworker is an AI coworker for small businesses: it answers the phone, replies to
          SMS, email, and web chat, and books appointments. This integration lets it schedule Zoom
          meetings for the appointments it books and send customers the join link. The steps below
          walk through authorization, every requested scope, and removal.{" "}
          <b>Test credentials are provided in the submission&apos;s release notes.</b>
        </p>

        <h2 className="mt-10 text-lg font-semibold text-parchment">Prerequisites</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-parchment/60">
          <li>The reviewer test account credentials from the release notes.</li>
          <li>Any Zoom account to connect (a free account works).</li>
          <li>
            The test business is pre-configured with a connected calendar, so bookings are real and
            end-to-end.
          </li>
        </ul>

        <ol className="mt-10 space-y-4">
          <Step n={1} title="Sign in to the test account">
            <p>
              Go to{" "}
              <Link href="/login" className="text-claw-green hover:underline">
                newcoworker.com/login
              </Link>{" "}
              and sign in with the reviewer credentials from the release notes. You land on the
              business dashboard.
            </p>
          </Step>

          <Step n={2} title="Authorize the Zoom integration (OAuth)">
            <p>
              Open <b>Dashboard → Integrations</b> and find the <b>Zoom</b> card. Click{" "}
              <b>Connect</b>. You are redirected to Zoom&apos;s consent page under the app&apos;s{" "}
              <b>production Client ID</b>; the consent screen lists the meeting and user scopes.
              Click <b>Allow</b>.
            </p>
            <p>
              Expected: you are returned to Dashboard → Integrations and the Zoom card shows{" "}
              <b>Connected</b> with your Zoom account&apos;s name and email (this exercises{" "}
              <code className="text-xs text-claw-green">user:read:user</code>).
            </p>
          </Step>

          <Step n={3} title="Create a meeting (book an appointment)">
            <p>
              Open <b>Dashboard → Chat</b> (the owner&apos;s chat with their AI coworker) and send:{" "}
              <i>&quot;Book a video appointment for John Smith tomorrow at 2pm, 30 minutes, phone
              +1 555 010 0000.&quot;</i>
            </p>
            <p>
              Expected: the coworker books the slot on the connected calendar and replies with a
              confirmation containing a <b>Zoom join link</b>. In your Zoom account (web portal →
              Meetings), a scheduled meeting titled after the appointment appears at that time.
              This exercises{" "}
              <code className="text-xs text-claw-green">meeting:write:meeting</code> and{" "}
              <code className="text-xs text-claw-green">meeting:write:invite_links</code>; the
              confirmation read-back covers{" "}
              <code className="text-xs text-claw-green">meeting:read:meeting</code> /{" "}
              <code className="text-xs text-claw-green">meeting:read:list_meetings</code>.
            </p>
          </Step>

          <Step n={4} title="Reschedule the appointment (meeting moves)">
            <p>
              In the same chat, send: <i>&quot;Move John Smith&apos;s appointment to 4pm the same
              day.&quot;</i>
            </p>
            <p>
              Expected: the calendar event moves and the <b>same</b> Zoom meeting shifts to the new
              time in your Zoom portal (no duplicate meeting is created). This exercises{" "}
              <code className="text-xs text-claw-green">meeting:update:meeting</code>.
            </p>
          </Step>

          <Step n={5} title="Cancel the appointment (meeting deleted)">
            <p>
              Send: <i>&quot;Cancel John Smith&apos;s appointment.&quot;</i>
            </p>
            <p>
              Expected: the calendar event is removed and the Zoom meeting disappears from your
              Zoom portal. This exercises{" "}
              <code className="text-xs text-claw-green">meeting:delete:meeting</code>.
            </p>
          </Step>

          <Step n={6} title="Remove the integration">
            <p>
              Back on <b>Dashboard → Integrations</b>, click <b>Disconnect</b> on the Zoom card and
              confirm. Expected: the card returns to its disconnected state; our server revokes the
              token with Zoom and deletes the stored credentials. Alternatively, remove the app
              from <b>marketplace.zoom.us → Manage → Added Apps</b>; the next dashboard visit shows
              the connection as needing reconnection.
            </p>
          </Step>
        </ol>

        <h2 className="mt-10 text-lg font-semibold text-parchment">Notes for reviewers</h2>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-sm text-parchment/60">
          <li>
            All endpoints are HTTPS-only (TLS 1.2+). OAuth state parameters are HMAC-signed and
            expire after 10 minutes.
          </li>
          <li>
            Zoom tokens are AES-256-GCM encrypted at rest and deleted on disconnect; refresh-token
            rotation is fully honored.
          </li>
          <li>
            End-user documentation (add / use / remove):{" "}
            <Link href="/integrations/zoom" className="text-claw-green hover:underline">
              newcoworker.com/integrations/zoom
            </Link>
            .
          </li>
          <li>
            Questions during review:{" "}
            <Link href="/contact" className="text-claw-green hover:underline">
              newcoworker.com/contact
            </Link>{" "}
            or the developer contact email on the submission.
          </li>
        </ul>
      </section>

      <MarketingFooter />
    </div>
  );
}

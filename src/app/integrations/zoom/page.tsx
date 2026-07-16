import type { Metadata } from "next";
import Link from "next/link";
import {
  CalendarCheck,
  Link2,
  PlugZap,
  RefreshCcw,
  ShieldCheck,
  Trash2,
  Video
} from "lucide-react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { PageHero, SectionHeading } from "@/components/marketing/sections";

/**
 * Public documentation for the "New Coworker OAuth" Zoom Marketplace app:
 * how to add, use, and remove the integration. This page is the app's
 * Documentation URL in the Zoom Marketplace listing, so it must keep
 * covering add / use / remove end to end (a Zoom review requirement).
 */

export const metadata: Metadata = {
  title: "Zoom Integration — Setup, Usage & Removal",
  description:
    "How to connect Zoom to New Coworker, how your AI coworker creates Zoom meetings for booked appointments, and how to disconnect the integration.",
  alternates: { canonical: "/integrations/zoom" },
  openGraph: {
    title: "Zoom Integration | New Coworker",
    description:
      "Connect Zoom so your AI coworker schedules video appointments with Zoom join links — and keeps them updated when plans change.",
    url: "/integrations/zoom"
  }
};

const scopes = [
  { scope: "meeting:write:meeting", use: "Create the Zoom meeting for an appointment your coworker books" },
  { scope: "meeting:update:meeting", use: "Move the meeting when the appointment is rescheduled" },
  { scope: "meeting:delete:meeting", use: "Delete the meeting when the appointment is canceled" },
  { scope: "meeting:read:meeting / meeting:read:list_meetings", use: "Confirm meeting details after changes" },
  { scope: "meeting:write:invite_links", use: "Create the join link your coworker sends to the customer" },
  { scope: "user:read:user", use: "Identify the connected Zoom account (name and email shown on your dashboard card)" }
];

function StepCard({
  step,
  title,
  children
}: {
  step: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
      <p className="text-xs font-semibold uppercase tracking-[0.22em] text-claw-green">{step}</p>
      <h3 className="mt-3 font-semibold text-parchment">{title}</h3>
      <div className="mt-2 text-sm leading-relaxed text-parchment/50">{children}</div>
    </div>
  );
}

export default function ZoomIntegrationDocsPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <PageHero
        eyebrow="Integrations · Zoom"
        title={
          <>
            Zoom meetings, booked by your <span className="text-claw-green">AI coworker</span>
          </>
        }
        subtitle="Connect Zoom once and every video appointment your coworker books comes with a Zoom meeting and a join link the customer receives automatically — kept in sync through reschedules and cancellations."
      />

      {/* What it does */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading eyebrow="Overview" title="What the integration does" />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <Video className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">Meetings created with bookings</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              When a customer books a video appointment by phone, SMS, email, or web chat, your
              coworker creates a scheduled Zoom meeting on your account for that exact time slot.
            </p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <Link2 className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">Join links sent automatically</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              The meeting&apos;s join link rides along in the booking confirmation your customer
              receives and in the calendar event&apos;s description, so nobody hunts for the link.
            </p>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <RefreshCcw className="h-5 w-5 text-claw-green" />
            <h3 className="mt-3 font-semibold text-parchment">Kept in sync, end to end</h3>
            <p className="mt-2 text-sm leading-relaxed text-parchment/50">
              If the appointment is rescheduled, the Zoom meeting moves with it. If it&apos;s
              canceled, the meeting is deleted. No orphaned meetings on your account.
            </p>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-claw-green/20 bg-claw-green/[0.05] p-4 text-sm text-parchment/60">
          <CalendarCheck className="mr-2 inline h-4 w-4 text-claw-green" />
          Prerequisites: a New Coworker subscription with a connected calendar (Google, Microsoft
          365, or CalDAV) and a Zoom account. Zoom meeting creation applies to appointments your
          coworker books directly on those calendars.
        </div>
      </section>

      {/* How to add */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Setup"
          title="How to add the integration"
          subtitle="Connecting takes under a minute from your dashboard."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <StepCard step="1 · Open" title="Go to Dashboard → Integrations">
            Sign in at newcoworker.com, open{" "}
            <Link href="/dashboard/integrations/zoom" className="text-claw-green hover:underline">
              Dashboard → Integrations → Zoom
            </Link>
            .
          </StepCard>
          <StepCard step="2 · Authorize" title="Click Connect and approve on Zoom">
            You&apos;re sent to Zoom&apos;s consent screen listing exactly what New Coworker may
            do (create, update, and delete meetings on your account). Click <b>Allow</b>. Zoom
            returns you to your dashboard automatically.
          </StepCard>
          <StepCard step="3 · Done" title="Verify the connected account">
            The Zoom card now shows the connected account&apos;s name and email. From this moment,
            video appointments your coworker books include a Zoom meeting and join link.
          </StepCard>
        </div>
      </section>

      {/* How to use */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Usage"
          title="How to use it"
          subtitle="There's nothing to operate day-to-day — your coworker does the work. Here's what happens behind the scenes."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">Booking</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/50">
              <li>
                A customer asks for an appointment (by phone, text, email, or web chat). Your
                coworker finds an open slot on your connected calendar and books it.
              </li>
              <li>
                With Zoom connected, the booking gets a scheduled Zoom meeting at that time, titled
                after the appointment.
              </li>
              <li>
                The customer&apos;s confirmation message includes the Zoom join link, and the link
                is written into the calendar event so your team sees it too.
              </li>
            </ul>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <h3 className="font-semibold text-parchment">Changes and cancellations</h3>
            <ul className="mt-4 space-y-3 text-sm leading-relaxed text-parchment/50">
              <li>
                When a customer reschedules, your coworker moves the calendar event <i>and</i> the
                Zoom meeting to the new time — same link, no new invite chains.
              </li>
              <li>When a customer cancels, the meeting is deleted along with the event.</li>
              <li>
                Zoom is never a point of failure: if Zoom is briefly unreachable, the appointment
                still books — it just books without a video link.
              </li>
            </ul>
          </div>
        </div>
      </section>

      {/* How to remove */}
      <section className="mx-auto max-w-6xl px-6 pb-20">
        <SectionHeading
          eyebrow="Removal"
          title="How to remove the integration"
          subtitle="Two ways — both fully disconnect New Coworker from your Zoom account."
        />
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <Trash2 className="h-5 w-5 text-signal-teal" />
            <h3 className="mt-3 font-semibold text-parchment">From your New Coworker dashboard</h3>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-parchment/50">
              <li>
                Open{" "}
                <Link
                  href="/dashboard/integrations/zoom"
                  className="text-claw-green hover:underline"
                >
                  Dashboard → Integrations → Zoom
                </Link>
                .
              </li>
              <li>Click <b>Disconnect</b> and confirm.</li>
              <li>
                We revoke our access token with Zoom and permanently delete the stored credentials.
                Future bookings simply book without Zoom meetings.
              </li>
            </ol>
          </div>
          <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-7">
            <PlugZap className="h-5 w-5 text-signal-teal" />
            <h3 className="mt-3 font-semibold text-parchment">From the Zoom App Marketplace</h3>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm leading-relaxed text-parchment/50">
              <li>
                Sign in to{" "}
                <a
                  href="https://marketplace.zoom.us/user/installed"
                  className="text-claw-green hover:underline"
                  rel="noopener noreferrer"
                  target="_blank"
                >
                  marketplace.zoom.us
                </a>{" "}
                and open <b>Manage → Added Apps</b>.
              </li>
              <li>Find <b>New Coworker OAuth</b> and click <b>Remove</b>.</li>
              <li>
                Zoom revokes New Coworker&apos;s access immediately. Your dashboard card will show
                the connection as needing reconnection.
              </li>
            </ol>
          </div>
        </div>
      </section>

      {/* Scopes and data handling */}
      <section className="mx-auto max-w-6xl px-6 pb-24">
        <SectionHeading
          eyebrow="Permissions & privacy"
          title="Exactly what New Coworker can access"
          subtitle="The integration requests the minimum Zoom scopes needed to schedule meetings on your behalf — nothing else."
        />
        <div className="overflow-x-auto rounded-2xl border border-parchment/10 bg-parchment/[0.02]">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-parchment/10 text-xs uppercase tracking-wider text-parchment/40">
                <th className="px-6 py-4">Zoom scope</th>
                <th className="px-6 py-4">What it&apos;s used for</th>
              </tr>
            </thead>
            <tbody>
              {scopes.map((s) => (
                <tr key={s.scope} className="border-b border-parchment/5 last:border-0">
                  <td className="px-6 py-3 font-mono text-xs text-claw-green">{s.scope}</td>
                  <td className="px-6 py-3 text-parchment/60">{s.use}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="mt-6 rounded-xl border border-signal-teal/20 bg-signal-teal/[0.05] p-5 text-sm leading-relaxed text-parchment/60">
          <ShieldCheck className="mr-2 inline h-4 w-4 text-signal-teal" />
          Your Zoom tokens are encrypted at rest (AES-256-GCM) in a row-level-security-protected
          database, are never exposed to the browser, and are deleted when you disconnect. We never
          read meeting content — only the scheduling data for appointments your coworker manages.
          See our{" "}
          <Link href="/privacy" className="text-claw-green hover:underline">
            Privacy Policy
          </Link>{" "}
          for details. Questions? Reach us any time via{" "}
          <Link href="/contact" className="text-claw-green hover:underline">
            newcoworker.com/contact
          </Link>
          .
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

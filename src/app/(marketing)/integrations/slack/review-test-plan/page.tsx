import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * Step-by-step test plan for Slack Marketplace reviewers ("New Coworker").
 * Linked from the submission notes; test credentials are provided in the
 * submission itself, never on this page. Noindexed: it's reviewer
 * documentation, not marketing (the Zoom review-test-plan precedent).
 */

export const metadata: Metadata = {
  title: "Slack App Review: Test Plan",
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

export default function SlackReviewTestPlanPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <section className="mx-auto max-w-3xl px-6 pb-24 pt-16">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
          New Coworker · Slack Marketplace review
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-parchment">
          Reviewer test plan
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-parchment/60">
          New Coworker is an AI coworker for businesses. The Slack app posts business
          alerts to a channel the owner picks, answers DMs and @mentions with the business&apos;s
          AI assistant, and lets the verified owner approve automation steps from Slack.
          Sign-in credentials for a review tenant are provided in the submission notes.
        </p>

        <ol className="mt-10 space-y-4">
          <Step n={1} title="Connect the workspace">
            <p>
              Sign in to the review tenant&apos;s dashboard with the provided credentials, open
              Integrations → Slack, and click Connect Slack. Approve the OAuth request for
              your test workspace. You land back on the Slack card showing Connected.
            </p>
          </Step>
          <Step n={2} title="Pick the alert channel">
            <p>
              On the same card, choose a channel from the picker and save. The app posts a
              hello message there; for a private channel, invite @New Coworker first, as the
              card&apos;s helper text says.
            </p>
          </Step>
          <Step n={3} title="Chat by DM and by mention">
            <p>
              Open a DM with New Coworker and ask a business question (&quot;what are your
              hours?&quot;). Mention @New Coworker in a channel it is in and ask the same; the
              reply arrives in a thread. Replies stream when the workspace supports Slack&apos;s
              streaming APIs and arrive as a normal message otherwise.
            </p>
          </Step>
          <Step n={4} title="Receive an alert">
            <p>
              Trigger the review tenant&apos;s demo automation (instructions in the submission
              notes) or text the tenant&apos;s business number from a second phone. An alert card
              posts to the picked channel, deep-linking to the dashboard.
            </p>
          </Step>
          <Step n={5} title="Decide an approval">
            <p>
              The demo automation parks at an approval step and posts a card with Approve /
              Skip / Cancel buttons. Press one as the owner account: the card rewrites with
              the outcome. Press one as a non-owner member: only an ephemeral &quot;owner only&quot;
              note appears and the card stays live.
            </p>
          </Step>
          <Step n={6} title="Uninstall">
            <p>
              Remove the app from the workspace (or click Disconnect on the dashboard card).
              The dashboard card flips to Needs reconnect, the stored token is wiped, and no
              further posts arrive.
            </p>
          </Step>
        </ol>

        <p className="mt-10 text-sm text-parchment/50">
          Full user documentation:{" "}
          <Link href="/integrations/slack" className="text-signal-teal underline hover:text-parchment">
            newcoworker.com/integrations/slack
          </Link>
          . Scope-by-scope usage is listed there; data handling is covered in the{" "}
          <Link href="/privacy" className="text-signal-teal underline hover:text-parchment">
            privacy policy
          </Link>
          .
        </p>
      </section>

      <MarketingFooter />
    </div>
  );
}

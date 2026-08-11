import type { Metadata } from "next";
import Link from "next/link";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";

/**
 * Step-by-step test plan for OpenAI's plugin reviewers. Linked from the
 * submission notes; test credentials are provided in the submission itself,
 * never on this page. Noindexed: reviewer documentation, not marketing (the
 * Slack and Zoom review-test-plan precedent).
 *
 * Deliberately English-only for the same reason those are: this is a document
 * for one reviewer, not a customer-facing page, and a translated copy would be
 * one more thing to keep in step for no reader.
 */

export const metadata: Metadata = {
  title: "ChatGPT App Review: Test Plan",
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

export default function ChatGptReviewTestPlanPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />

      <section className="mx-auto max-w-3xl px-6 pb-24 pt-16">
        <p className="mb-4 text-xs font-semibold uppercase tracking-[0.22em] text-signal-teal">
          New Coworker · OpenAI plugin review
        </p>
        <h1 className="text-4xl font-bold leading-tight tracking-tight text-parchment">
          Reviewer test plan
        </h1>
        <p className="mt-4 text-sm leading-relaxed text-parchment/60">
          New Coworker is an AI coworker for small businesses: it answers the phone, replies to
          texts and email, and runs follow-up automations. This app puts that same assistant
          inside ChatGPT, acting as the signed-in owner and limited to their team role. Sign-in
          credentials for a demo account with seeded data are in the submission notes.
        </p>

        <ol className="mt-10 space-y-5">
          <Step n={1} title="Connect the app">
            <p>
              Add the MCP server URL from the submission, choose OAuth, and click Connect. You
              will be sent to our consent page, sign in with the demo credentials, and approve
              once. No MFA, no email confirmation, and no private network access is required.
            </p>
            <p>
              The connection authenticates as that account. There is no separate API key, and we
              never ask the reviewer for one.
            </p>
          </Step>

          <Step n={2} title="Read something (read-only tools)">
            <p>
              Ask: <em>&ldquo;List my businesses on New Coworker&rdquo;</em>. The demo account
              owns one business and should be named back with its plan and role.
            </p>
            <p>
              Then: <em>&ldquo;Search for Maria&rdquo;</em> and{" "}
              <em>&ldquo;Show me my text conversation with her&rdquo;</em>. Search returns both
              the customer and the conversation; fetch reads the full record. Every result
              carries a link back into the dashboard.
            </p>
          </Step>

          <Step n={3} title="Confirm the write path asks first">
            <p>
              Ask: <em>&ldquo;Text Maria that we can fit her in Thursday at 2pm&rdquo;</em>.
            </p>
            <p>
              Expected: ChatGPT confirms before sending. The tool is annotated{" "}
              <code className="font-mono text-xs text-parchment/80">openWorldHint: true</code>,
              and the server instructions tell the model to confirm anything that reaches a
              customer. The demo tenant sends to a number we control, so no real person is
              messaged.
            </p>
          </Step>

          <Step n={4} title="Confirm permissions are enforced server-side">
            <p>
              The submission includes a second, staff-role login for the same business. Connect
              with it and ask: <em>&ldquo;List my automations&rdquo;</em>.
            </p>
            <p>
              Expected: a refusal explaining the role cannot do that. Permissions are checked on
              our server per business per call, against the same matrix the web dashboard uses.
              They are not enforced by prompt or by hiding tools.
            </p>
          </Step>

          <Step n={5} title="Remove the app">
            <p>
              Remove the connector in ChatGPT&apos;s settings. Access is revoked immediately.
              Nothing in the New Coworker account is deleted by removing the app, and the owner
              can also revoke from their own dashboard.
            </p>
          </Step>
        </ol>

        <div className="mt-12 rounded-2xl border border-parchment/10 bg-parchment/[0.02] p-6">
          <h2 className="font-semibold text-parchment">Notes for review</h2>
          <ul className="mt-3 space-y-2 text-sm leading-relaxed text-parchment/60">
            <li>
              <strong className="text-parchment/80">Data we request.</strong> Only what a task
              needs: a phone number to look someone up, a message body to send. We do not ask for
              payment details, health records, government IDs, or credentials, and results carry
              no diagnostic or trace fields.
            </li>
            <li>
              <strong className="text-parchment/80">Consequential tools are annotated.</strong>{" "}
              Sending a message, booking, and starting an automation are marked open-world;
              anything that replaces or deletes stored data is marked destructive. Reading is
              marked read-only.
            </li>
            <li>
              <strong className="text-parchment/80">Public documentation</strong> lives at{" "}
              <Link
                href="/integrations/chatgpt"
                className="text-signal-teal underline underline-offset-4"
              >
                /integrations/chatgpt
              </Link>
              , covering add, use, what it can reach, and remove.
            </li>
          </ul>
        </div>
      </section>

      <MarketingFooter />
    </div>
  );
}

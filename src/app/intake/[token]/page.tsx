/**
 * Public white-glove intake questionnaire — the durable, emailable link
 * (/intake/<token>) an admin sends to a prospective white-glove client.
 * The token is an unguessable capability; the page renders the questionnaire
 * for OPEN intakes and a friendly read-only state for completed/revoked ones.
 *
 * Deliberately public (no auth): prospects have no account yet. The page
 * never exposes anything beyond the questionnaire itself.
 */
import { notFound } from "next/navigation";
import { getWhiteGloveIntakeByToken } from "@/lib/white-glove/intake";
import { WhiteGloveIntakeForm } from "@/components/intake/WhiteGloveIntakeForm";

export const dynamic = "force-dynamic";

export default async function IntakePage({
  params
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  // Fail closed on malformed tokens without hitting the DB.
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(token)) {
    notFound();
  }
  const intake = await getWhiteGloveIntakeByToken(token);
  if (!intake) notFound();

  return (
    <main className="min-h-screen bg-deep-ink px-4 py-10">
      <div className="mx-auto w-full max-w-2xl space-y-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-parchment/40">
            NewCoworker · White-glove setup
          </p>
          <h1 className="mt-1 text-2xl font-bold text-parchment">
            {intake.business_name
              ? `Tell us how ${intake.business_name}'s assistant should work`
              : "Tell us how your assistant should work"}
          </h1>
          <p className="mt-2 text-sm leading-relaxed text-parchment/60">
            About 5 minutes, mostly multiple choice. Your answers become the build plan our
            team installs from — how your AI assistant greets new leads, follows up, books
            appointments, and hands conversations to your team.
          </p>
        </div>

        {intake.status === "sent" && (
          <WhiteGloveIntakeForm token={token} industry={intake.industry} />
        )}

        {intake.status === "completed" && (
          <p className="rounded-md border border-claw-green/40 bg-claw-green/10 px-4 py-3 text-sm text-claw-green">
            Thanks — we&apos;ve got everything we need! Our team will review your answers and
            reach out with next steps.
            {intake.recipient_email
              ? " If anything changes, just reply to the email you received."
              : " If anything changes, just let your NewCoworker contact know."}
          </p>
        )}

        {intake.status === "revoked" && (
          <p className="rounded-md border border-spark-orange/40 bg-spark-orange/10 px-4 py-3 text-sm text-spark-orange">
            This questionnaire link is no longer active.
            {intake.recipient_email
              ? " Reply to the email you received and we'll send you a fresh one."
              : " Reach out to your NewCoworker contact and we'll send you a fresh one."}
          </p>
        )}
      </div>
    </main>
  );
}

/**
 * Printable "White-Glove Build & Installation" document — the completed
 * intake questionnaire rendered through renderWhiteGloveDocSections.
 *
 * Lives OUTSIDE the admin (protected) route group on purpose: the sidebar
 * chrome would print, and this page is meant to be printed / saved as PDF /
 * sent to the customer as-is. Auth is the same admin gate the protected
 * layout applies (getAuthUser().isAdmin), just without the shell.
 */
import { notFound, redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { getWhiteGloveIntake } from "@/lib/white-glove/intake";
import {
  intakeAnswersSchema,
  renderWhiteGloveDoc,
  renderWhiteGloveDocSections
} from "@/lib/white-glove/template";
import { WhiteGloveDocActions } from "@/components/admin/WhiteGloveDocActions";

export const dynamic = "force-dynamic";

export default async function IntakeDocPage({
  params
}: {
  params: Promise<{ intakeId: string }>;
}) {
  const user = await getAuthUser();
  if (!user?.isAdmin) redirect("/admin/login?next=/admin/clients");

  const { intakeId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(intakeId)) {
    notFound();
  }
  const intake = await getWhiteGloveIntake(intakeId);
  if (!intake || intake.status !== "completed" || !intake.answers) notFound();

  // Stored answers were validated at submit time, but re-parse defensively so
  // a hand-edited row can never render a half-broken document.
  const parsed = intakeAnswersSchema.safeParse(intake.answers);
  if (!parsed.success) notFound();
  const answers = parsed.data;

  const doc = renderWhiteGloveDocSections(answers);
  const markdown = renderWhiteGloveDoc(answers);
  const completedOn = intake.completed_at
    ? new Date(intake.completed_at).toLocaleDateString("en-US", {
        year: "numeric",
        month: "long",
        day: "numeric"
      })
    : null;

  return (
    <main className="min-h-screen bg-white text-neutral-900">
      <div className="mx-auto w-full max-w-3xl px-8 py-10 print:px-0 print:py-0">
        <WhiteGloveDocActions
          markdown={markdown}
          filename={`white-glove-build-${answers.business_name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/(^-|-$)/g, "")}.md`}
        />

        <header className="mb-8 border-b border-neutral-300 pb-6">
          <p className="text-xs uppercase tracking-wider text-neutral-500">
            NewCoworker · White-glove service
          </p>
          <h1 className="mt-1 text-2xl font-bold">{doc.title}</h1>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">{doc.intro}</p>
          <p className="mt-2 text-xs text-neutral-500">
            Prepared from the questionnaire completed by {intake.recipient_email}
            {completedOn ? ` on ${completedOn}` : ""}.
          </p>
        </header>

        <div className="space-y-7">
          {doc.sections.map((section) => (
            <section key={section.heading} className="break-inside-avoid">
              <h2 className="mb-2 text-base font-semibold">{section.heading}</h2>
              <div className="space-y-1 text-sm leading-relaxed text-neutral-800">
                {section.lines.map((line, i) =>
                  line === "" ? (
                    <div key={i} className="h-3" />
                  ) : (
                    <p key={i}>{line}</p>
                  )
                )}
              </div>
            </section>
          ))}
        </div>

        <footer className="mt-10 border-t border-neutral-300 pt-4 text-xs text-neutral-500">
          NewCoworker white-glove build document — keep with the customer&apos;s account
          records.
        </footer>
      </div>
    </main>
  );
}

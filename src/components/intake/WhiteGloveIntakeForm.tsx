"use client";

/**
 * The public white-glove intake questionnaire form (/intake/<token>).
 *
 * Renders INTAKE_QUESTIONS grouped by section — multiple choice first
 * wherever possible, free text only where unavoidable. Choosing an industry
 * pre-fills the suggested greeting + qualification questions (visible as
 * placeholders the prospect can override). Submission POSTs to
 * /intake/<token>/submit; completed intakes render read-only server-side.
 */
import { useMemo, useState } from "react";
import {
  INTAKE_QUESTIONS,
  INDUSTRY_PRESETS,
  type IntakeQuestion
} from "@/lib/white-glove/template";

type AnswerValue = string | string[];

function initialAnswers(): Record<string, AnswerValue> {
  const init: Record<string, AnswerValue> = {};
  for (const q of INTAKE_QUESTIONS) {
    init[q.id] = q.type === "multi" ? [] : "";
  }
  return init;
}

export function WhiteGloveIntakeForm({ token }: { token: string }) {
  const [answers, setAnswers] = useState<Record<string, AnswerValue>>(initialAnswers);
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sections = useMemo(() => {
    const grouped: Array<{ name: string; questions: IntakeQuestion[] }> = [];
    for (const q of INTAKE_QUESTIONS) {
      const last = grouped[grouped.length - 1];
      if (last && last.name === q.section) last.questions.push(q);
      else grouped.push({ name: q.section, questions: [q] });
    }
    return grouped;
  }, []);

  const industry = typeof answers.industry === "string" ? answers.industry : "";
  const preset = industry ? INDUSTRY_PRESETS[industry] : undefined;

  function setValue(id: string, value: AnswerValue) {
    setAnswers((prev) => ({ ...prev, [id]: value }));
  }

  function toggleMulti(id: string, value: string) {
    setAnswers((prev) => {
      const current = Array.isArray(prev[id]) ? (prev[id] as string[]) : [];
      const next = current.includes(value)
        ? current.filter((v) => v !== value)
        : [...current, value];
      return { ...prev, [id]: next };
    });
  }

  function placeholderFor(q: IntakeQuestion): string | undefined {
    // The industry presets double as live placeholders so the prospect sees
    // the exact wording we'd use if they leave the field blank.
    if (q.id === "greeting" && preset) return preset.greeting;
    if (q.id === "qualification_questions" && preset) {
      return preset.qualificationQuestions.join("\n");
    }
    return q.placeholder;
  }

  function missingRequired(): string | null {
    for (const q of INTAKE_QUESTIONS) {
      if (!q.required) continue;
      const v = answers[q.id];
      if (q.type === "multi") {
        if (!Array.isArray(v) || v.length === 0) return q.label;
      } else if (typeof v !== "string" || v.trim().length === 0) {
        return q.label;
      }
    }
    return null;
  }

  async function submit() {
    const missing = missingRequired();
    if (missing) {
      setError(`Please answer: ${missing}`);
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/intake/${token}/submit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(answers)
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ?? "Something went wrong. Please try again.");
        return;
      }
      setDone(true);
    } catch {
      setError("Network error — please check your connection and try again.");
    } finally {
      setSubmitting(false);
    }
  }

  if (done) {
    return (
      <p className="rounded-md border border-claw-green/40 bg-claw-green/10 px-4 py-3 text-sm text-claw-green">
        Thanks — we&apos;ve got everything we need! Our team will review your answers and
        reach out with next steps.
      </p>
    );
  }

  const inputClass =
    "w-full rounded-md border border-parchment/20 bg-deep-ink/80 px-3 py-2 text-sm text-parchment placeholder:text-parchment/25 focus:border-signal-teal focus:outline-none";

  return (
    <div className="space-y-8">
      {sections.map((section) => (
        <fieldset key={section.name} className="space-y-4">
          <legend className="text-xs font-semibold uppercase tracking-wider text-signal-teal">
            {section.name}
          </legend>
          {section.questions.map((q) => (
            <div key={q.id} className="space-y-1.5">
              <label className="block text-sm font-medium text-parchment">
                {q.label}
                {q.required && <span className="ml-1 text-clay-red">*</span>}
              </label>
              {q.help && <p className="text-xs text-parchment/45">{q.help}</p>}

              {q.type === "choice" && (
                <div className="flex flex-wrap gap-2">
                  {q.options?.map((opt) => {
                    const selected = answers[q.id] === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setValue(q.id, opt.value)}
                        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                          selected
                            ? "border-signal-teal bg-signal-teal/15 text-signal-teal"
                            : "border-parchment/20 text-parchment/70 hover:border-parchment/40"
                        }`}
                      >
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === "multi" && (
                <div className="flex flex-wrap gap-2">
                  {q.options?.map((opt) => {
                    const selected =
                      Array.isArray(answers[q.id]) &&
                      (answers[q.id] as string[]).includes(opt.value);
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => toggleMulti(q.id, opt.value)}
                        className={`rounded-full border px-3 py-1.5 text-sm transition-colors ${
                          selected
                            ? "border-signal-teal bg-signal-teal/15 text-signal-teal"
                            : "border-parchment/20 text-parchment/70 hover:border-parchment/40"
                        }`}
                      >
                        {selected ? "✓ " : ""}
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              )}

              {q.type === "text" && (
                <input
                  className={inputClass}
                  value={answers[q.id] as string}
                  onChange={(e) => setValue(q.id, e.target.value)}
                  placeholder={placeholderFor(q)}
                  maxLength={q.maxLength}
                />
              )}

              {q.type === "textarea" && (
                <textarea
                  className={`${inputClass} min-h-[84px]`}
                  value={answers[q.id] as string}
                  onChange={(e) => setValue(q.id, e.target.value)}
                  placeholder={placeholderFor(q)}
                  maxLength={q.maxLength}
                />
              )}
            </div>
          ))}
        </fieldset>
      ))}

      {error && <p className="text-sm text-clay-red">{error}</p>}

      <button
        type="button"
        onClick={submit}
        disabled={submitting}
        className="w-full rounded-lg bg-claw-green px-4 py-3 text-center font-semibold text-deep-ink hover:bg-opacity-90 disabled:opacity-60"
      >
        {submitting ? "Sending…" : "Send my answers"}
      </button>
      <p className="text-center text-[11px] text-parchment/40">
        You can leave the optional fields blank — we&apos;ll use sensible defaults and
        confirm everything with you before going live.
      </p>
    </div>
  );
}

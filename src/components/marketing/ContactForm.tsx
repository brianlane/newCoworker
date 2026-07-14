"use client";

import { useState } from "react";

type Status = "idle" | "sending" | "sent" | "error";

const INPUT_CLASSES =
  "w-full rounded-lg border border-parchment/15 bg-parchment/[0.04] px-4 py-3 text-sm text-parchment placeholder:text-parchment/30 outline-none transition-colors focus:border-claw-green/60 focus:ring-2 focus:ring-claw-green/30";

const LABEL_CLASSES = "mb-2 block text-sm font-medium text-parchment/70";

type Props = {
  defaultSubject?: string;
  /** Prefill for signed-in owners arriving from dashboard CTAs. */
  defaultName?: string;
  defaultEmail?: string;
  defaultBusinessName?: string;
  defaultMessage?: string;
};

/**
 * Client-side contact form that posts to /api/contact. Includes a hidden
 * honeypot field that the API answers 200 for but discards.
 */
export function ContactForm({
  defaultSubject,
  defaultName,
  defaultEmail,
  defaultBusinessName,
  defaultMessage
}: Props) {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setStatus("sending");
    setError(null);

    try {
      const res = await fetch("/api/contact", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: data.get("name"),
          email: data.get("email"),
          businessName: data.get("businessName"),
          subject: data.get("subject"),
          message: data.get("message"),
          extraField: data.get("extra_field")
        })
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        setError(body?.error ?? "We couldn't send your message. Please try again.");
        setStatus("error");
        return;
      }
      form.reset();
      setStatus("sent");
    } catch {
      setError("We couldn't send your message. Please try again.");
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-xl border border-claw-green/30 bg-claw-green/10 p-8 text-center">
        <h3 className="text-lg font-semibold text-parchment">Message sent</h3>
        <p className="mt-2 text-sm leading-relaxed text-parchment/60">
          Thanks for reaching out. A human reads every message, and most inquiries receive a
          response within 24 hours.
        </p>
        <button
          type="button"
          onClick={() => setStatus("idle")}
          className="mt-6 text-sm font-semibold text-signal-teal hover:underline"
        >
          Send another message
        </button>
      </div>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-8"
    >
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label htmlFor="contact-name" className={LABEL_CLASSES}>
            Name
          </label>
          <input
            id="contact-name"
            name="name"
            type="text"
            required
            maxLength={120}
            autoComplete="name"
            defaultValue={defaultName}
            className={INPUT_CLASSES}
          />
        </div>
        <div>
          <label htmlFor="contact-email" className={LABEL_CLASSES}>
            Email
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            defaultValue={defaultEmail}
            className={INPUT_CLASSES}
          />
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="contact-business" className={LABEL_CLASSES}>
          Business Name (Optional)
        </label>
        <input
          id="contact-business"
          name="businessName"
          type="text"
          maxLength={160}
          autoComplete="organization"
          defaultValue={defaultBusinessName}
          className={INPUT_CLASSES}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="contact-subject" className={LABEL_CLASSES}>
          Subject
        </label>
        <input
          id="contact-subject"
          name="subject"
          type="text"
          required
          maxLength={200}
          defaultValue={defaultSubject}
          className={INPUT_CLASSES}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="contact-message" className={LABEL_CLASSES}>
          Message
        </label>
        <textarea
          id="contact-message"
          name="message"
          required
          rows={4}
          maxLength={5000}
          defaultValue={defaultMessage}
          placeholder="Tell us how we can help: support, enterprise plans, white-glove onboarding, partnerships, or anything else."
          className={`${INPUT_CLASSES} resize-none`}
        />
      </div>

      {/* Honeypot: hidden from real users, bots fill it and get discarded.
          Deliberately NOT named like a real field (website/url/phone), so
          browser autofill heuristics never populate it for real visitors. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="contact-extra-field">Leave this field empty</label>
        <input
          id="contact-extra-field"
          name="extra_field"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>

      {error ? <p className="mt-4 text-sm text-spark-orange">{error}</p> : null}

      <button
        type="submit"
        disabled={status === "sending"}
        className="mt-6 w-full rounded-lg bg-claw-green px-4 py-3 text-sm font-semibold text-deep-ink transition-colors hover:bg-claw-green/90 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {status === "sending" ? "Sending..." : "Send Message"}
      </button>
    </form>
  );
}

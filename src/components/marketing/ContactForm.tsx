"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { track } from "@vercel/analytics";
import { CONTACT_TOPIC_DEFS_BY_PARAM } from "@/lib/marketing/contact-topics";

type Status = "idle" | "sending" | "sent" | "error";

const INPUT_CLASSES =
  "w-full rounded-lg border border-parchment/15 bg-parchment/[0.04] px-4 py-3 text-sm text-parchment placeholder:text-parchment/30 outline-none transition-colors focus:border-claw-green/60 focus:ring-2 focus:ring-claw-green/30";

const LABEL_CLASSES = "mb-2 block text-sm font-medium text-parchment/70";

type Prefill = {
  name?: string;
  email?: string;
  businessName?: string;
};

/**
 * Client-side contact form that posts to /api/contact. Includes a hidden
 * honeypot field that the API answers 200 for but discards.
 *
 * Topic query + signed-in prefill load on the client so the /contact RSC
 * stays free of auth and searchParams (anonymous scrapes should not hit
 * Supabase). Topic defaults apply immediately; auth prefill only fills
 * empty fields so in-progress typing is never wiped.
 */
export function ContactForm() {
  // Suspense fallback is a non-interactive placeholder (not a second form)
  // so typed input cannot be lost when useSearchParams resolves.
  return (
    <Suspense
      fallback={
        <div
          className="min-h-[20rem] rounded-xl border border-parchment/10 bg-parchment/[0.02] p-8"
          aria-hidden="true"
        />
      }
    >
      <ContactFormAutofill />
    </Suspense>
  );
}

function ContactFormAutofill() {
  const searchParams = useSearchParams();
  const topic = searchParams.get("topic");
  const [authPrefill, setAuthPrefill] = useState<Prefill>({});

  useEffect(() => {
    let cancelled = false;
    fetch("/api/contact/prefill", { credentials: "same-origin" })
      .then(async (res) => {
        if (!res.ok) return {};
        return (await res.json()) as Prefill;
      })
      .then((data) => {
        if (!cancelled) setAuthPrefill(data ?? {});
      })
      .catch(() => {
        /* anonymous / network blip: leave topic-only defaults */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Remount when topic changes so subject/message defaults reset to the new
  // CTA templates instead of keeping the previous topic's copy.
  return <ContactFormFields key={topic ?? ""} topic={topic} authPrefill={authPrefill} />;
}

function ContactFormFields({
  topic,
  authPrefill
}: {
  topic: string | null;
  authPrefill: Prefill;
}) {
  const t = useTranslations("marketing.contactPage");
  const tf = useTranslations("marketing.contactPage.form");
  const topicDef = topic ? CONTACT_TOPIC_DEFS_BY_PARAM[topic] : undefined;

  const topicSubject = topicDef ? t(topicDef.subjectKey) : "";
  const topicMessageBase = topicDef ? t(topicDef.msgKey) : "";
  const topicMessageWithBiz =
    topicDef && authPrefill.businessName
      ? t(topicDef.msgForKey, { businessName: authPrefill.businessName })
      : topicMessageBase;

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [businessName, setBusinessName] = useState("");
  const [subject, setSubject] = useState(topicSubject);
  const [message, setMessage] = useState(topicMessageBase);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  // Apply auth / richer topic defaults only into empty fields so a visitor
  // who already typed is not overwritten when the prefill request returns.
  useEffect(() => {
    if (authPrefill.name) {
      setName((prev) => prev || authPrefill.name || "");
    }
    if (authPrefill.email) {
      setEmail((prev) => prev || authPrefill.email || "");
    }
    if (authPrefill.businessName) {
      setBusinessName((prev) => prev || authPrefill.businessName || "");
    }
    if (topicDef) {
      setSubject((prev) => (prev === "" || prev === topicSubject ? topicSubject : prev));
      setMessage((prev) =>
        prev === "" || prev === topicMessageBase || prev === topicMessageWithBiz
          ? topicMessageWithBiz
          : prev
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- merge only when auth/topic inputs change
  }, [
    authPrefill.name,
    authPrefill.email,
    authPrefill.businessName,
    topic,
    topicSubject,
    topicMessageBase,
    topicMessageWithBiz
  ]);

  function resetToDefaults() {
    setName(authPrefill.name ?? "");
    setEmail(authPrefill.email ?? "");
    setBusinessName(authPrefill.businessName ?? "");
    setSubject(topicSubject);
    setMessage(topicMessageWithBiz);
    setError(null);
    setStatus("idle");
  }

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
        setError(body?.error ?? tf("sendFailed"));
        setStatus("error");
        return;
      }
      setStatus("sent");
      track("contact_submitted", { topic: topic ?? "general" });
    } catch {
      setError(tf("sendFailed"));
      setStatus("error");
    }
  }

  if (status === "sent") {
    return (
      <div className="rounded-xl border border-claw-green/30 bg-claw-green/10 p-8 text-center">
        <h3 className="text-lg font-semibold text-parchment">{tf("sentTitle")}</h3>
        <p className="mt-2 text-sm leading-relaxed text-parchment/60">{tf("sentBody")}</p>
        <button
          type="button"
          onClick={resetToDefaults}
          className="mt-6 text-sm font-semibold text-signal-teal hover:underline"
        >
          {tf("sendAnother")}
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
            {tf("name")}
          </label>
          <input
            id="contact-name"
            name="name"
            type="text"
            required
            maxLength={120}
            autoComplete="name"
            value={name}
            onChange={(ev) => setName(ev.target.value)}
            className={INPUT_CLASSES}
          />
        </div>
        <div>
          <label htmlFor="contact-email" className={LABEL_CLASSES}>
            {tf("email")}
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            required
            maxLength={254}
            autoComplete="email"
            value={email}
            onChange={(ev) => setEmail(ev.target.value)}
            className={INPUT_CLASSES}
          />
        </div>
      </div>

      <div className="mt-4">
        <label htmlFor="contact-business" className={LABEL_CLASSES}>
          {tf("businessName")}
        </label>
        <input
          id="contact-business"
          name="businessName"
          type="text"
          maxLength={160}
          autoComplete="organization"
          value={businessName}
          onChange={(ev) => setBusinessName(ev.target.value)}
          className={INPUT_CLASSES}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="contact-subject" className={LABEL_CLASSES}>
          {tf("subject")}
        </label>
        <input
          id="contact-subject"
          name="subject"
          type="text"
          required
          maxLength={200}
          value={subject}
          onChange={(ev) => setSubject(ev.target.value)}
          className={INPUT_CLASSES}
        />
      </div>

      <div className="mt-4">
        <label htmlFor="contact-message" className={LABEL_CLASSES}>
          {tf("message")}
        </label>
        <textarea
          id="contact-message"
          name="message"
          required
          rows={4}
          maxLength={5000}
          value={message}
          onChange={(ev) => setMessage(ev.target.value)}
          placeholder={tf("messagePlaceholder")}
          className={`${INPUT_CLASSES} resize-none`}
        />
      </div>

      {/* Honeypot: hidden from real users, bots fill it and get discarded.
          Deliberately NOT named like a real field (website/url/phone), so
          browser autofill heuristics never populate it for real visitors. */}
      <div aria-hidden="true" className="absolute -left-[9999px] h-0 w-0 overflow-hidden">
        <label htmlFor="contact-extra-field">{tf("honeypot")}</label>
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
        {status === "sending" ? tf("sending") : tf("send")}
      </button>
    </form>
  );
}

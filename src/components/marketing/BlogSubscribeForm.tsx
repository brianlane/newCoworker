"use client";

import { useState } from "react";

/** Email opt-in box on blog pages — POSTs to /api/blog/subscribe. */
export function BlogSubscribeForm({
  locale,
  labels
}: {
  locale: "en" | "es";
  labels: { placeholder: string; button: string; success: string; error: string };
}) {
  const [email, setEmail] = useState("");
  const [state, setState] = useState<"idle" | "sending" | "done" | "error">("idle");

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (state === "sending") return;
    setState("sending");
    try {
      const response = await fetch("/api/blog/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, locale })
      });
      setState(response.ok ? "done" : "error");
    } catch {
      setState("error");
    }
  };

  if (state === "done") {
    return <p className="mt-4 text-sm text-claw-green">{labels.success}</p>;
  }

  return (
    <form onSubmit={submit} className="mt-4 flex flex-col gap-3 sm:flex-row">
      <input
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder={labels.placeholder}
        className="flex-1 rounded-lg border border-parchment/15 bg-transparent px-4 py-2 text-sm text-parchment placeholder:text-parchment/35 focus:border-claw-green focus:outline-none"
      />
      <button
        type="submit"
        disabled={state === "sending"}
        className="rounded-lg bg-claw-green px-5 py-2 text-sm font-medium text-deep-ink transition-opacity hover:opacity-90 disabled:opacity-50"
      >
        {labels.button}
      </button>
      {state === "error" && <p className="text-sm text-red-400 sm:self-center">{labels.error}</p>}
    </form>
  );
}

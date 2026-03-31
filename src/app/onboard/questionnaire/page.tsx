"use client";

import { Suspense, useEffect, useEffectEvent, useRef, useState, type KeyboardEvent } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { RichSelect } from "@/components/ui/RichSelect";
import { Button } from "@/components/ui/Button";
import {
  ONBOARD_STORAGE_KEY,
  type OnboardingAssistantChatState
} from "@/lib/onboarding/storage";
const DRAFT_STORAGE_KEY = "newcoworker_onboard_draft";
import {
  createEmptyAssistantProfile,
  type OnboardingChatMessage
} from "@/lib/onboarding/chat";
import { BUSINESS_TYPE_OPTIONS, DEFAULT_BUSINESS_TYPE } from "@/lib/onboarding/businessTypes";
import { getMonthlyRateDisplay } from "@/lib/pricing";


function ChatMarkdown({ text }: { text: string }) {
  const blocks = text.split(/\n{2,}/);

  return (
    <div className="space-y-2">
      {blocks.map((block, blockIdx) => {
        const lines = block.split("\n");
        const isList = lines.every((l) => /^[-•*]\s/.test(l.trim()) || !l.trim());

        if (isList) {
          return (
            <ul key={blockIdx} className="list-disc pl-4 space-y-0.5">
              {lines.map((line, i) => {
                const content = line.trim().replace(/^[-•*]\s+/, "");
                return content ? <li key={i}><InlineMarkdown text={content} /></li> : null;
              })}
            </ul>
          );
        }

        return (
          <p key={blockIdx}>
            {lines.map((line, i) => (
              <span key={i}>
                {i > 0 && <br />}
                <InlineMarkdown text={line} />
              </span>
            ))}
          </p>
        );
      })}
    </div>
  );
}

function InlineMarkdown({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      parts.push(<strong key={match.index} className="font-semibold">{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={match.index}>{match[3]}</em>);
    } else if (match[4]) {
      parts.push(
        <code key={match.index} className="rounded bg-parchment/10 px-1 py-0.5 text-[0.9em]">{match[4]}</code>
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return <>{parts}</>;
}

type Step = 1 | 2 | 3;

interface FormData {
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  serviceArea: string;
  typicalInquiry: string;
  teamSize: string;
  crmUsed: string;
  assistantChat: OnboardingAssistantChatState | null;
}

const EMPTY_FORM: FormData = {
  businessName: "",
  businessType: DEFAULT_BUSINESS_TYPE,
  ownerName: "",
  phone: "",
  serviceArea: "",
  typicalInquiry: "",
  teamSize: "1",
  crmUsed: "",
  assistantChat: null
};

function createEmptyChatState(): OnboardingAssistantChatState {
  return {
    messages: [],
    readyToFinalize: false,
    completionPercent: 0,
    missingTopics: [],
    profile: createEmptyAssistantProfile(),
    drafts: {
      identityMd: "",
      soulMd: "",
      memoryMd: ""
    }
  };
}

export default function QuestionnairePage() {
  return (
    <Suspense>
      <QuestionnaireForm />
    </Suspense>
  );
}

function QuestionnaireForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const tier = (searchParams.get("tier") ?? "starter") as "starter" | "standard";
  const period = (searchParams.get("period") ?? "biennial") as "monthly" | "annual" | "biennial";

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");
      if (draft?.step && [1, 2, 3].includes(draft.step)) setStep(draft.step as Step);
      if (draft?.form) setForm((prev) => ({ ...prev, ...draft.form }));
    } catch { /* ignore corrupt data */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ step, form }));
    } catch { /* quota exceeded — non-critical */ }
  }, [step, form, hydrated]);

  function update(field: keyof FormData, value: string | OnboardingAssistantChatState | null) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateAssistantChat(nextState: OnboardingAssistantChatState) {
    const inquirySummary = nextState.profile.inquiryFlows.length > 0
      ? nextState.profile.inquiryFlows
          .map((flow) => `Cause: ${flow.trigger}\nEffect: ${flow.responseGoal}`)
          .join("\n\n")
      : form.typicalInquiry;

    setForm((prev) => ({
      ...prev,
      typicalInquiry: inquirySummary,
      assistantChat: nextState
    }));
  }

  async function runAssistant(messages: OnboardingChatMessage[], keepUserMessages = true) {
    setChatLoading(true);
    setChatError(null);

    try {
      const response = await fetch("/api/onboard/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessName: form.businessName,
          businessType: form.businessType,
          ownerName: form.ownerName,
          phone: form.phone,
          serviceArea: form.serviceArea,
          teamSize: form.teamSize,
          crmUsed: form.crmUsed,
          messages,
          profile: form.assistantChat?.profile ?? createEmptyAssistantProfile()
        })
      });

      const json = await response.json();
      if (!response.ok || !json.ok) {
        throw new Error(json.error?.message ?? "Failed to collect onboarding details");
      }

      const assistantMessage: OnboardingChatMessage = {
        role: "assistant",
        content: json.data.assistantMessage
      };

      updateAssistantChat({
        messages: keepUserMessages ? [...messages, assistantMessage] : [assistantMessage],
        readyToFinalize: json.data.readyToFinalize,
        completionPercent: json.data.completionPercent,
        missingTopics: json.data.missingTopics,
        profile: json.data.profile,
        drafts: json.data.drafts
      });
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not continue the onboarding chat");
    } finally {
      setChatLoading(false);
    }
  }

  const startAssistantInterview = useEffectEvent(async () => {
    if (chatLoading || form.assistantChat?.messages.length) return;

    await runAssistant(
      [{ role: "user", content: "Start the onboarding interview. Ask your first focused question." }],
      false
    );
  });

  async function retryAssistantInterview() {
    if (chatLoading) return;

    await runAssistant(
      [{ role: "user", content: "Start the onboarding interview. Ask your first focused question." }],
      false
    );
  }

  async function sendChatMessage() {
    const trimmed = chatInput.trim();
    if (!trimmed || chatLoading) return;

    const nextMessages: OnboardingChatMessage[] = [
      ...(form.assistantChat?.messages ?? []),
      { role: "user", content: trimmed }
    ];

    setChatInput("");
    await runAssistant(nextMessages);
  }

  function handleChatKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendChatMessage();
    }
  }

  useEffect(() => {
    if (step === 2 && !(form.assistantChat?.messages.length ?? 0)) {
      void startAssistantInterview();
    }
  }, [step, form.assistantChat?.messages.length]);

  useEffect(() => {
    const viewport = chatViewportRef.current;
    if (!viewport) return;
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "smooth" });
  }, [form.assistantChat?.messages.length, chatLoading]);

  function handleSubmit() {
    setError(null);
    try {
      localStorage.setItem(
        ONBOARD_STORAGE_KEY,
        JSON.stringify({
          tier,
          billingPeriod: period,
          ...form,
          assistantChat: form.assistantChat ?? createEmptyChatState()
        })
      );
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      router.push(`/signup?tier=${encodeURIComponent(tier)}&period=${encodeURIComponent(period)}&redirectTo=/onboard/checkout`);
    } catch {
      setError("Could not save your details. Please try again.");
    }
  }

  const canContinueFromChat = chatLoading
    ? false
    : (form.assistantChat?.readyToFinalize ?? false) || (form.assistantChat?.completionPercent ?? 0) >= 60;

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-2xl space-y-6">
        <div>
          <div className="flex gap-2 mb-4">
            {([1, 2, 3] as Step[]).map((s) => (
              <div
                key={s}
                className={[
                  "h-1 flex-1 rounded-full transition-colors",
                  s <= step ? "bg-claw-green" : "bg-parchment/10"
                ].join(" ")}
              />
            ))}
          </div>
          <h1 className="text-2xl font-bold text-parchment">
            {step === 1
              ? "Tell us about your business"
              : step === 2
                ? "Assistant interview"
                : "Review & create account"}
          </h1>
          <p className="text-sm text-parchment/50 mt-1">Step {step} of 3</p>
        </div>

        <Card>
          {step === 1 && (
            <div className="space-y-4">
              <Input
                label="Business Name"
                value={form.businessName}
                onChange={(e) => update("businessName", e.target.value)}
                placeholder="Sunrise Realty"
                required
              />
              <RichSelect
                label="Business Type"
                value={form.businessType}
                onChange={(nextValue) => update("businessType", nextValue)}
                options={BUSINESS_TYPE_OPTIONS}
                placeholder="Select your industry"
              />
              <Input
                label="Your Name"
                value={form.ownerName}
                onChange={(e) => update("ownerName", e.target.value)}
                placeholder="Jane Doe"
                required
              />
              <Input
                label="Phone Number"
                type="tel"
                value={form.phone}
                onChange={(e) => update("phone", e.target.value)}
                placeholder="+1 (555) 000-0000"
              />
            </div>
          )}

          {step === 2 && (
            <div className="space-y-4">
              <div className="rounded-2xl border border-parchment/10 bg-parchment/4 p-4 space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-signal-teal/15 text-signal-teal">
                      AI
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-parchment">Onboarding Assistant</p>
                    </div>
                  </div>
                  <div className="rounded-full border border-parchment/10 bg-deep-ink/50 px-3 py-1 text-xs text-parchment/65">
                    {form.assistantChat?.completionPercent ?? 0}% ready
                  </div>
                </div>

                <div
                  ref={chatViewportRef}
                  className="max-h-[30rem] min-h-[18rem] space-y-3 overflow-y-auto rounded-xl border border-parchment/8 bg-deep-ink/25 p-3"
                >
                  {!form.assistantChat?.messages.length && !chatLoading && !chatError && (
                    <div className="flex h-full min-h-[12rem] items-center justify-center text-center text-sm text-parchment/45">
                      Starting your onboarding interview...
                    </div>
                  )}
                  {form.assistantChat?.messages.map((message, index) => (
                    <div
                      key={`${message.role}-${index}`}
                      className={[
                        "rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-[0_10px_30px_rgba(0,0,0,0.14)]",
                        message.role === "assistant"
                          ? "mr-12 border border-signal-teal/12 bg-signal-teal/10 text-parchment"
                          : "ml-12 border border-claw-green/12 bg-claw-green/10 text-parchment/90"
                      ].join(" ")}
                    >
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-parchment/45">
                        {message.role === "assistant" ? "Assistant" : "You"}
                      </p>
                      {message.role === "assistant"
                        ? <ChatMarkdown text={message.content} />
                        : <p>{message.content}</p>
                      }
                    </div>
                  ))}
                  {chatLoading && (
                    <div className="mr-12 rounded-2xl border border-signal-teal/12 bg-signal-teal/10 px-4 py-3 text-sm text-parchment/70">
                      Thinking...
                    </div>
                  )}
                </div>

                <div className="flex gap-2">
                  <textarea
                    value={chatInput}
                    onChange={(event) => setChatInput(event.target.value)}
                    onKeyDown={handleChatKeyDown}
                    rows={3}
                    placeholder="Type your answer. Press Enter to send, Shift+Enter for a new line."
                    className="min-h-[88px] flex-1 rounded-lg border border-parchment/20 bg-deep-ink/50 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
                  />
                  <Button className="self-end" onClick={sendChatMessage} loading={chatLoading} disabled={!chatInput.trim()}>
                    Send
                  </Button>
                </div>
                {chatError && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-spark-orange/20 bg-spark-orange/10 px-3 py-2 text-xs text-spark-orange">
                    <span>{chatError}</span>
                    <button
                      type="button"
                      onClick={() => void retryAssistantInterview()}
                      className="font-semibold text-parchment"
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-3 text-sm">
              <div className="bg-parchment/5 rounded-lg p-4 space-y-2">
                <h3 className="font-semibold text-parchment">Order Summary</h3>
                <div className="flex justify-between text-parchment/70">
                  <span>Plan</span>
                  <span className="capitalize">{tier}</span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Billing period</span>
                  <span className="capitalize">
                    {period === "biennial" ? "24 months" : period === "annual" ? "12 months" : "1 month"}
                  </span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Business</span>
                  <span>{form.businessName || "—"}</span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Assistant brief</span>
                  <span>{form.assistantChat?.completionPercent ?? 0}% captured</span>
                </div>
                <div className="flex justify-between text-parchment/70">
                  <span>Monthly rate</span>
                  <span>{getMonthlyRateDisplay(tier, period)}</span>
                </div>
              </div>
              {error && <p className="text-spark-orange text-xs">{error}</p>}
            </div>
          )}
        </Card>

        <div className="flex gap-3">
          {step > 1 && (
            <Button variant="ghost" onClick={() => setStep((s) => (s - 1) as Step)}>
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button
              className="flex-1"
              onClick={() => setStep((s) => (s + 1) as Step)}
              disabled={(step === 1 && !form.businessName) || (step === 2 && !canContinueFromChat)}
            >
              Continue →
            </Button>
          ) : (
            <Button className="flex-1" onClick={handleSubmit}>
              Create Account →
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

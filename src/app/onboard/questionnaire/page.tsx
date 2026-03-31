"use client";

import { Suspense, useEffect, useEffectEvent, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { RichSelect } from "@/components/ui/RichSelect";
import { Button } from "@/components/ui/Button";
import { OrderSummaryCard } from "@/components/OrderSummaryCard";
import {
  ONBOARD_STORAGE_KEY,
  type OnboardingData,
  type OnboardingAssistantChatDraftState,
  type OnboardingAssistantChatState
} from "@/lib/onboarding/storage";
import {
  MAX_ONBOARDING_CHAT_MESSAGES,
  createEmptyAssistantProfile,
  type OnboardingChatMessage
} from "@/lib/onboarding/chat";
import { BUSINESS_TYPE_OPTIONS, DEFAULT_BUSINESS_TYPE } from "@/lib/onboarding/businessTypes";
import { getPasswordValidationError, PASSWORD_RULES } from "@/lib/password";
import { getSupabaseBrowserClient } from "@/lib/supabase/browser";

const DRAFT_STORAGE_KEY = "newcoworker_onboard_draft";

function createMessageTimestamp(): string {
  return new Date().toISOString();
}

function formatMessageTimestamp(timestamp?: string): string {
  if (!timestamp) return "";

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return "";

  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit"
  }).format(parsed);
}


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
type PendingUserMessage = { content: string; timestamp: string };

interface FormData {
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  serviceArea: string;
  typicalInquiry: string;
  teamSize: string;
  crmUsed: string;
  assistantChat: OnboardingAssistantChatDraftState | null;
}

const EMPTY_FORM: FormData = {
  businessName: "",
  businessType: DEFAULT_BUSINESS_TYPE,
  ownerName: "",
  phone: "",
  serviceArea: "",
  typicalInquiry: "",
  teamSize: "",
  crmUsed: "",
  assistantChat: null
};

function toDraftChatState(chat: OnboardingAssistantChatState | undefined): OnboardingAssistantChatDraftState | null {
  if (!chat) return null;

  return {
    messages: [],
    readyToFinalize: chat.readyToFinalize,
    completionPercent: chat.completionPercent,
    missingTopics: [],
    profile: chat.profile,
    drafts: chat.drafts
  };
}

function toFormData(data: Partial<OnboardingData>): Partial<FormData> {
  return {
    businessName: typeof data.businessName === "string" ? data.businessName : EMPTY_FORM.businessName,
    businessType: typeof data.businessType === "string" ? data.businessType : EMPTY_FORM.businessType,
    ownerName: typeof data.ownerName === "string" ? data.ownerName : EMPTY_FORM.ownerName,
    phone: typeof data.phone === "string" ? data.phone : EMPTY_FORM.phone,
    serviceArea: typeof data.serviceArea === "string" ? data.serviceArea : EMPTY_FORM.serviceArea,
    typicalInquiry: typeof data.typicalInquiry === "string" ? data.typicalInquiry : EMPTY_FORM.typicalInquiry,
    teamSize: typeof data.teamSize === "string" ? data.teamSize : EMPTY_FORM.teamSize,
    crmUsed: typeof data.crmUsed === "string" ? data.crmUsed : EMPTY_FORM.crmUsed,
    assistantChat: toDraftChatState(data.assistantChat)
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
  const searchParams = useSearchParams();
  const tier = (searchParams.get("tier") ?? "starter") as "starter" | "standard";
  const period = (searchParams.get("period") ?? "biennial") as "monthly" | "annual" | "biennial";

  const [step, setStep] = useState<Step>(1);
  const [form, setForm] = useState<FormData>(EMPTY_FORM);
  const [hydrated, setHydrated] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signupEmail, setSignupEmail] = useState("");
  const [signupPassword, setSignupPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [signupLoading, setSignupLoading] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const [retryableUserMessage, setRetryableUserMessage] = useState<PendingUserMessage | null>(null);
  const chatViewportRef = useRef<HTMLDivElement>(null);
  const assistantDone = form.assistantChat?.readyToFinalize ?? false;
  const storedChatMessageCount = form.assistantChat?.messages.length ?? 0;
  const chatMessageCount = storedChatMessageCount + (pendingUserMessage ? 1 : 0);
  const chatLimitReached = storedChatMessageCount >= MAX_ONBOARDING_CHAT_MESSAGES - 1;
  const chatClosed = assistantDone || chatLimitReached;

  useEffect(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");
      if (draft?.step && [1, 2, 3].includes(draft.step)) {
        setStep(draft.step as Step);
      } else {
        const storedOnboarding = JSON.parse(localStorage.getItem(ONBOARD_STORAGE_KEY) ?? "null") as OnboardingData | null;
        if (storedOnboarding) setStep(3);
      }

      if (draft?.form) {
        setForm((prev) => ({ ...prev, ...draft.form }));
      } else {
        const storedOnboarding = JSON.parse(localStorage.getItem(ONBOARD_STORAGE_KEY) ?? "null") as OnboardingData | null;
        if (storedOnboarding) {
          setForm((prev) => ({ ...prev, ...toFormData(storedOnboarding) }));
        }
      }
    } catch { /* ignore corrupt data */ }
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ step, form }));
    } catch { /* quota exceeded — non-critical */ }
  }, [step, form, hydrated]);

  function update(field: keyof FormData, value: string | OnboardingAssistantChatDraftState | null) {
    setForm((prev) => ({ ...prev, [field]: value }));
  }

  function updateAssistantChat(nextState: OnboardingAssistantChatDraftState) {
    const inquirySummary = nextState.profile.inquiryFlows.length > 0
      ? nextState.profile.inquiryFlows
          .map((flow) => `Cause: ${flow.trigger}\nEffect: ${flow.responseGoal}`)
          .join("\n\n")
      : form.typicalInquiry;

    setForm((prev) => ({
      ...prev,
      typicalInquiry: inquirySummary,
      serviceArea: nextState.profile.serviceArea || prev.serviceArea,
      teamSize: nextState.profile.teamSize || prev.teamSize,
      crmUsed: nextState.profile.crmUsed.length > 0 ? nextState.profile.crmUsed.join(", ") : prev.crmUsed,
      assistantChat: nextState
    }));
  }

  async function runAssistant(messages: OnboardingChatMessage[], keepUserMessages = true): Promise<boolean> {
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
        content: json.data.assistantMessage,
        timestamp: createMessageTimestamp()
      };

      updateAssistantChat({
        messages: keepUserMessages ? [...messages, assistantMessage] : [assistantMessage],
        readyToFinalize: json.data.readyToFinalize,
        completionPercent: json.data.completionPercent,
        missingTopics: json.data.missingTopics,
        profile: json.data.profile,
        drafts: json.data.drafts
      });
      return true;
    } catch (err) {
      setChatError(err instanceof Error ? err.message : "Could not continue the onboarding chat");
      return false;
    } finally {
      setChatLoading(false);
    }
  }

  const startAssistantInterview = useEffectEvent(async () => {
    if (chatLoading || form.assistantChat?.messages.length) return;

    await runAssistant(
      [{ role: "user", content: "Start the onboarding interview. Ask your first focused question.", timestamp: createMessageTimestamp() }],
      false
    );
  });

  async function retryAssistantInterview() {
    if (chatLoading || chatClosed) return;

    const retryMessages = retryableUserMessage
      ? [...(form.assistantChat?.messages ?? []), { role: "user" as const, ...retryableUserMessage }]
      : form.assistantChat?.messages ?? [];

    if (retryMessages.length > 0) {
      setPendingUserMessage(retryableUserMessage);
      const ok = await runAssistant(retryMessages, true);
      if (ok) {
        setPendingUserMessage(null);
        setRetryableUserMessage(null);
      } else {
        setPendingUserMessage(null);
      }
      return;
    }

    await runAssistant(
      [{ role: "user", content: "Start the onboarding interview. Ask your first focused question.", timestamp: createMessageTimestamp() }],
      false
    );
  }

  async function sendChatMessage() {
    const trimmed = chatInput.trim();
    if (!trimmed || chatLoading || chatClosed) return;

    const timestamp = createMessageTimestamp();
    setPendingUserMessage({ content: trimmed, timestamp });
    setRetryableUserMessage(null);
    setChatInput("");

    const nextMessages: OnboardingChatMessage[] = [
      ...(form.assistantChat?.messages ?? []),
      { role: "user", content: trimmed, timestamp }
    ];

    const ok = await runAssistant(nextMessages);
    if (ok) {
      setPendingUserMessage(null);
      setRetryableUserMessage(null);
    } else {
      setChatInput(trimmed);
      setRetryableUserMessage({ content: trimmed, timestamp });
      setPendingUserMessage(null);
    }
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
  }, [form.assistantChat?.messages.length, chatLoading, pendingUserMessage]);

  function buildStoredOnboardingData(businessId?: string): OnboardingData {
    const storedAssistantChat: OnboardingAssistantChatState = {
      readyToFinalize: form.assistantChat?.readyToFinalize ?? false,
      completionPercent: form.assistantChat?.completionPercent ?? 0,
      profile: form.assistantChat?.profile ?? createEmptyAssistantProfile(),
      drafts: form.assistantChat?.drafts ?? {
        identityMd: "",
        soulMd: "",
        memoryMd: ""
      }
    };

    return {
      businessId,
      tier,
      billingPeriod: period,
      ...form,
      assistantChat: storedAssistantChat
    };
  }

  async function saveAssistantConfig(businessId: string, signupUserId?: string) {
    if (form.assistantChat?.drafts) {
      const configRes = await fetch("/api/business/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          ownerEmail: signupEmail || undefined,
          signupUserId,
          soulMd: form.assistantChat.drafts.soulMd,
          identityMd: form.assistantChat.drafts.identityMd,
          memoryMd: form.assistantChat.drafts.memoryMd
        })
      });

      if (!configRes.ok) throw new Error("Failed to save assistant profile");
    }
  }

  async function createBusinessAndConfig(businessId: string, shouldCreateBusiness: boolean, signupUserId?: string) {
    if (shouldCreateBusiness) {
      const createRes = await fetch("/api/business/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          businessId,
          ownerEmail: signupEmail || undefined,
          signupUserId,
          name: form.businessName,
          tier,
          businessType: form.businessType,
          ownerName: form.ownerName,
          phone: form.phone,
          serviceArea: form.serviceArea,
          typicalInquiry: form.typicalInquiry,
          teamSize: form.teamSize,
          crmUsed: form.crmUsed
        })
      });
      if (!createRes.ok) throw new Error("Failed to create business");
    }

    await saveAssistantConfig(businessId, signupUserId);
  }

  async function createCheckout(businessId: string, signupUserId?: string) {
    const checkoutRes = await fetch("/api/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tier,
        businessId,
        billingPeriod: period,
        ownerEmail: signupEmail || undefined,
        signupUserId
      })
    });
    const checkoutJson = await checkoutRes.json();
    if (!checkoutRes.ok) throw new Error(checkoutJson.error?.message ?? "Checkout failed");
    const { checkoutUrl } = checkoutJson.data ?? {};
    if (!checkoutUrl) throw new Error("Invalid checkout response");
    return checkoutUrl;
  }

  async function handleCreateAccount(event: FormEvent) {
    event.preventDefault();
    if (signupLoading) return;

    setError(null);
    const passwordError = getPasswordValidationError(signupPassword);
    if (passwordError) {
      setError(passwordError);
      return;
    }
    if (signupPassword !== confirmPassword) {
      setError("Passwords do not match");
      return;
    }

    try {
      const existingOnboardingRaw = localStorage.getItem(ONBOARD_STORAGE_KEY);
      const existingOnboarding = existingOnboardingRaw ? JSON.parse(existingOnboardingRaw) as OnboardingData : null;
      setSignupLoading(true);

      const supabase = getSupabaseBrowserClient();
      const onboardingData = buildStoredOnboardingData(existingOnboarding?.businessId);
      localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(onboardingData));

      const encodedRedirect = encodeURIComponent("/onboard/checkout");
      const { data: signUpData, error: signUpError } = await supabase.auth.signUp({
        email: signupEmail,
        password: signupPassword,
        options: {
          data: {
            business_name: form.businessName,
            onboarding_data: onboardingData
          },
          emailRedirectTo: `${window.location.origin}/api/auth/callback?redirectTo=${encodedRedirect}`
        }
      });

      if (signUpError) {
        setError(signUpError.message);
        return;
      }

      const identities = signUpData.user?.identities ?? [];
      if (identities.length === 0) {
        setError("An account with this email already exists. Please sign in instead.");
        return;
      }
      const signupUserId = signUpData.user?.id;
      if (!signUpData.session && !signupUserId) {
        setError("Could not complete signup. Please try again.");
        return;
      }

      const businessId = existingOnboarding?.businessId ?? crypto.randomUUID();
      const checkoutSignupUserId = signUpData.session ? undefined : signupUserId;
      await createBusinessAndConfig(businessId, !existingOnboarding?.businessId, checkoutSignupUserId);
      const checkoutUrl = await createCheckout(businessId, checkoutSignupUserId);
      localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(buildStoredOnboardingData(businessId)));
      localStorage.removeItem(DRAFT_STORAGE_KEY);
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not create your account");
    } finally {
      setSignupLoading(false);
    }
  }

  const canContinueFromChat = chatLoading
    ? false
    : chatClosed || (form.assistantChat?.readyToFinalize ?? false) || (form.assistantChat?.completionPercent ?? 0) >= 60;

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4 py-12">
      <div className={`w-full space-y-6 ${step === 2 ? "max-w-3xl" : "max-w-2xl"}`}>
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
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-full bg-signal-teal/15 text-signal-teal">
                      AI
                    </div>
                    <div>
                      <p className="text-sm font-semibold text-parchment">Onboarding Assistant</p>
                      <p className="text-xs text-parchment/50">Answer naturally. The assistant will guide the interview.</p>
                    </div>
                  </div>
                </div>

                <div
                  ref={chatViewportRef}
                  className="max-h-[36rem] min-h-[24rem] space-y-3 overflow-y-auto rounded-2xl border border-parchment/8 bg-deep-ink/25 p-4"
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
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-parchment/45">
                          {message.role === "assistant" ? "Assistant" : "You"}
                        </p>
                        <span className="text-[11px] text-parchment/35">
                          {formatMessageTimestamp(message.timestamp)}
                        </span>
                      </div>
                      {message.role === "assistant"
                        ? <ChatMarkdown text={message.content} />
                        : <p>{message.content}</p>
                      }
                    </div>
                  ))}
                  {pendingUserMessage && (
                    <div className="ml-12 rounded-2xl border border-claw-green/12 bg-claw-green/10 px-4 py-3 text-sm leading-relaxed text-parchment/90 shadow-[0_10px_30px_rgba(0,0,0,0.14)]">
                      <div className="mb-1 flex items-center justify-between gap-3">
                        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-parchment/45">
                          You
                        </p>
                        <span className="text-[11px] text-parchment/35">
                          {formatMessageTimestamp(pendingUserMessage.timestamp)}
                        </span>
                      </div>
                      <p>{pendingUserMessage.content}</p>
                    </div>
                  )}
                  {chatLoading && (
                    <div className="mr-12 rounded-2xl border border-signal-teal/12 bg-signal-teal/10 px-4 py-3 text-sm text-parchment/70">
                      Thinking...
                    </div>
                  )}
                </div>

                {chatClosed ? (
                  <div className="rounded-xl border border-claw-green/20 bg-claw-green/10 px-4 py-3 text-sm text-parchment/85">
                    {assistantDone
                      ? "The interview is complete. Continue when you're ready."
                      : "This interview has reached its message limit. Continue to the next step to save tokens."}
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <textarea
                      value={chatInput}
                      onChange={(event) => {
                        setChatInput(event.target.value);
                        setRetryableUserMessage(null);
                      }}
                      onKeyDown={handleChatKeyDown}
                      rows={3}
                      placeholder="Type your answer. Press Enter to send, Shift+Enter for a new line."
                      className="min-h-[88px] flex-1 rounded-lg border border-parchment/20 bg-deep-ink/50 px-3 py-2 text-sm text-parchment placeholder-parchment/30 focus:outline-none focus:ring-2 focus:ring-signal-teal"
                    />
                    <Button className="self-end" onClick={sendChatMessage} loading={chatLoading} disabled={!chatInput.trim()}>
                      Send
                    </Button>
                  </div>
                )}
                {chatError && (
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-spark-orange/20 bg-spark-orange/10 px-3 py-2 text-xs text-spark-orange">
                    <span>{chatError}</span>
                    <button
                      type="button"
                      onClick={() => void retryAssistantInterview()}
                      className="font-semibold text-parchment"
                      disabled={chatClosed}
                    >
                      Retry
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-4 text-sm">
              <form onSubmit={handleCreateAccount} className="space-y-4">
                  <OrderSummaryCard
                    tier={tier}
                    period={period}
                    businessName={form.businessName}
                    assistantBriefPercent={form.assistantChat?.completionPercent ?? 0}
                  />

                  <div className="grid gap-4 md:grid-cols-2">
                    <Input
                      label="Email"
                      type="email"
                      value={signupEmail}
                      onChange={(e) => setSignupEmail(e.target.value)}
                      placeholder="you@business.com"
                      autoComplete="email"
                      required
                    />
                    <div />
                    <Input
                      label="Password"
                      type="password"
                      value={signupPassword}
                      onChange={(e) => setSignupPassword(e.target.value)}
                      placeholder="8+ chars, 1 uppercase, 1 number"
                      autoComplete="new-password"
                      required
                    />
                    <Input
                      label="Confirm Password"
                      type="password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      placeholder="Re-enter your password"
                      autoComplete="new-password"
                      required
                    />
                  </div>

                  <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
                    <p className="font-medium text-parchment/75">Password rules</p>
                    <ul className="mt-1 list-disc pl-4 space-y-1">
                      {PASSWORD_RULES.map((rule) => (
                        <li key={rule}>{rule}</li>
                      ))}
                    </ul>
                  </div>

                  {error && <p className="text-spark-orange text-xs">{error}</p>}

                  <Button type="submit" className="w-full" loading={signupLoading}>
                    Create Account & Continue to Payment →
                  </Button>
              </form>
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
          ) : null}
        </div>
      </div>
    </div>
  );
}

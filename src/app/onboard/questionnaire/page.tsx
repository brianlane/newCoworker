"use client";

import { Suspense, useEffect, useEffectEvent, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useSearchParams } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { Input } from "@/components/ui/Input";
import { RichSelect } from "@/components/ui/RichSelect";
import { Button } from "@/components/ui/Button";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
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
import {
  CRM_OPTIONS,
  CRM_OTHER_VALUE,
  TEAM_SIZE_OPTIONS,
  deriveCrmSelection,
  isCrmSelectionComplete,
  serializeCrmSelection
} from "@/lib/onboarding/intakeOptions";
const DRAFT_STORAGE_KEY = "newcoworker_onboard_draft";

function isValidEmailAddress(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

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


type Step = 1 | 2 | 3;
type PendingUserMessage = { content: string; timestamp: string };
const QUESTIONNAIRE_PROGRESS_STEPS = [1, 2, 3, 4] as const;

interface FormData {
  businessName: string;
  businessType: string;
  ownerName: string;
  phone: string;
  websiteUrl: string;
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
  websiteUrl: "",
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
    websiteUrl: typeof data.websiteUrl === "string" ? data.websiteUrl : EMPTY_FORM.websiteUrl,
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
  const [signupLoading, setSignupLoading] = useState(false);
  const [emailChecking, setEmailChecking] = useState(false);
  const [draftSaving, setDraftSaving] = useState(false);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
  const [pendingUserMessage, setPendingUserMessage] = useState<PendingUserMessage | null>(null);
  const [retryableUserMessage, setRetryableUserMessage] = useState<PendingUserMessage | null>(null);
  // Cached website summary from `/api/onboard/website-preview`. Kicked
  // off on the Step 1 → Step 2 transition so the assistant chat has
  // crawl-derived business context to draw from when the user
  // references their site. Empty string until the preview returns
  // (chat still works without it; the system prompt falls back to
  // mentioning just the URL). Lives in component state rather than
  // localStorage because it's transient — the persistent ingest at
  // /api/onboard/website-ingest re-runs at "Proceed to Payment" and is
  // the canonical source for `business_configs.website_md`.
  const [websiteMd, setWebsiteMd] = useState("");
  // Tracks which URL produced the cached `websiteMd`. Without this, a
  // user who clicks Back to Step 1, edits the URL, and advances again
  // keeps sending the OLD site's summary in chat requests — the
  // assistant references content from a different site than the one
  // currently in the form. The Step 1 → Step 2 gate only refetches
  // when this source URL no longer matches `form.websiteUrl`, and the
  // chat POST only includes `websiteMd` when the source still matches.
  const [websiteMdSourceUrl, setWebsiteMdSourceUrl] = useState("");
  const chatViewportRef = useRef<HTMLDivElement>(null);
  // AbortController for the latest in-flight website-preview fetch. A
  // user who advances → goes back → edits the URL → advances again can
  // launch a second preview before the first resolves. Without abort
  // the slower (stale) response still calls `setWebsiteMd` after the
  // fresher one wins, permanently losing the correct summary for the
  // session. Aborting the previous fetch makes out-of-order resolution
  // impossible by construction: the prior request's promise rejects
  // with an AbortError that the existing try/catch swallows.
  const websitePreviewAbortRef = useRef<AbortController | null>(null);
  const assistantDone = form.assistantChat?.readyToFinalize ?? false;
  const storedChatMessageCount = form.assistantChat?.messages.length ?? 0;
  const chatLimitReached = storedChatMessageCount >= MAX_ONBOARDING_CHAT_MESSAGES - 1;
  const chatClosed = assistantDone || chatLimitReached;

  // Mount-only hydration. `searchParams` is read inside a `useEffectEvent`
  // wrapper so the linter's exhaustive-deps rule sees this as a hook with no
  // reactive dependencies — which is what we want here. Re-running the effect
  // when `searchParams` changes would re-apply `?step=1` from the URL after
  // we've explicitly stripped it (line below), yanking the user back to step
  // 1 after they've naturally advanced. The single-shot semantics are the
  // contract; useEffectEvent makes that contract lint-clean.
  const hydrateFromStorage = useEffectEvent(() => {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_STORAGE_KEY) ?? "null");
      const storedOnboarding = JSON.parse(
        localStorage.getItem(ONBOARD_STORAGE_KEY) ?? "null"
      ) as OnboardingData | null;

      // URL-driven step intent: ONLY `?step=1` is honored. That's the sole deep-link
      // we currently expose (the "Change it" email link from /signup → step 1, which
      // owns the email field). Honoring ?step=2 or ?step=3 would let users bypass the
      // questionnaire's progression gates — `handleAdvanceStep` requires `chatClosed`
      // to advance from step 2 to step 3 — and land directly on checkout with an empty
      // or low-quality assistant profile. ?step=2/3 therefore falls through to the
      // existing localStorage-derived precedence chain instead of overriding it.
      const stepParamRaw = Number(searchParams.get("step"));
      const stepFromUrl: Step | null = stepParamRaw === 1 ? 1 : null;

      if (stepFromUrl !== null) {
        setStep(stepFromUrl);
        // Strip the consumed `step` param from the URL so a subsequent refresh or
        // browser-back doesn't silently re-apply ?step=1 and yank the user back to
        // step 1 after they've naturally advanced. After consumption, the draft's
        // persisted `step` (written by the effect below on every step change) is the
        // correct source of truth for return visits.
        if (typeof window !== "undefined") {
          const url = new URL(window.location.href);
          url.searchParams.delete("step");
          const search = url.searchParams.toString();
          const cleaned = `${url.pathname}${search ? `?${search}` : ""}${url.hash}`;
          window.history.replaceState(null, "", cleaned);
        }
      } else if (draft?.step && [1, 2, 3].includes(draft.step)) {
        setStep(draft.step as Step);
      } else if (storedOnboarding) {
        setStep(3);
      }

      // Form fields: DRAFT is the source of truth when it exists. It carries the most
      // recent in-progress edits AND the chat transcript (OnboardingAssistantChatState
      // in ONBOARD intentionally omits messages). Only fall back to ONBOARD when DRAFT
      // is missing — overlaying ONBOARD on top of DRAFT would clobber unsynced field
      // edits that the user made between back-navigations. The one downstream-updated
      // field — ownerEmail — is reconciled separately below (it lives in `signupEmail`,
      // not in the form payload) so it does not need to participate in this merge.
      if (draft?.form) {
        setForm((prev) => ({ ...prev, ...draft.form }));
      } else if (storedOnboarding) {
        setForm((prev) => ({ ...prev, ...toFormData(storedOnboarding) }));
      }

      // Email precedence: prefer the authoritative ONBOARD.ownerEmail (it may have been
      // rewritten post-checkout, e.g. by /api/onboard/finalize-signup using the Stripe
      // customer email) over the DRAFT-cached signupEmail. Without this, a stale step-1
      // value would be re-applied via persistOnboardingDraft on a return visit
      // (`signupEmail || existingOnboarding?.ownerEmail`).
      if (typeof storedOnboarding?.ownerEmail === "string" && storedOnboarding.ownerEmail) {
        setSignupEmail(storedOnboarding.ownerEmail);
      } else if (typeof draft?.signupEmail === "string") {
        setSignupEmail(draft.signupEmail);
      }
    } catch { /* ignore corrupt data */ }
    setHydrated(true);
  });

  useEffect(() => {
    hydrateFromStorage();
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({ step, form, signupEmail }));
    } catch { /* quota exceeded — non-critical */ }
  }, [step, form, signupEmail, hydrated]);

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
      // Step 1 is now the canonical source for serviceArea / teamSize
      // / crmUsed (closed-class dropdowns, validated before advance),
      // so prefer the user's form value over whatever the model
      // emitted into the profile. The OR-fallback is retained for
      // legacy localStorage drafts that pre-date the Step 1 fields:
      // those rehydrate with empty form values, and accepting the
      // model's extracted answer is better than nothing.
      serviceArea: prev.serviceArea || nextState.profile.serviceArea,
      teamSize: prev.teamSize || nextState.profile.teamSize,
      crmUsed:
        prev.crmUsed ||
        (nextState.profile.crmUsed.length > 0 ? nextState.profile.crmUsed.join(", ") : ""),
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
          // Pass the URL even when the preview hasn't returned yet so
          // the model at least acknowledges the user has a website
          // (the system prompt branches on this) instead of asking
          // "do you have a website?" right after Step 1's submit.
          websiteUrl: form.websiteUrl?.trim() || undefined,
          // Only forward the cached summary when its source URL still
          // matches what's currently in the form. Without this guard,
          // editing the URL on a Back-to-Step-1 trip would leave the
          // chat referencing the previous site's content.
          websiteMd:
            websiteMd && websiteMdSourceUrl === form.websiteUrl?.trim()
              ? websiteMd
              : undefined,
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

  function buildStoredOnboardingData(
    businessId?: string,
    draftToken?: string,
    ownerEmail?: string,
    onboardingToken?: string,
    persistedToDatabase = false
  ): OnboardingData {
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

    // NOTE: `signupUserId` is intentionally not carried forward here. In the
    // current Stripe-first flow the auth user is minted post-payment by
    // /api/onboard/set-password; there is no Supabase session pre-checkout,
    // so any `signupUserId` left in localStorage is a stale relic from the
    // previous auth-first deployment. Sending it would route the legacy
    // server branches that call `verifySignupIdentity`, which fails for an
    // unauthenticated caller and surfaces as "Not authorized to create
    // business". Dropping it forces the anonymous onboarding-token branch.
    return {
      businessId,
      draftToken,
      ownerEmail,
      onboardingToken,
      persistedToDatabase,
      tier,
      billingPeriod: period,
      ...form,
      assistantChat: storedAssistantChat
    };
  }

  async function persistOnboardingDraft(): Promise<OnboardingData> {
    const existingOnboardingRaw = localStorage.getItem(ONBOARD_STORAGE_KEY);
    const existingOnboarding = existingOnboardingRaw ? JSON.parse(existingOnboardingRaw) as OnboardingData : null;
    const businessId = existingOnboarding?.businessId ?? crypto.randomUUID();
    const draftToken = existingOnboarding?.draftToken ?? crypto.randomUUID();
    const onboardingData = buildStoredOnboardingData(
      businessId,
      draftToken,
      signupEmail || existingOnboarding?.ownerEmail,
      existingOnboarding?.onboardingToken,
      existingOnboarding?.persistedToDatabase ?? false
    );

    const response = await fetch("/api/onboard/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        businessId,
        draftToken,
        onboardingData
      })
    });

    const json = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(json?.error?.message ?? "Could not save onboarding draft");
    }

    localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(onboardingData));
    return onboardingData;
  }

  /**
   * Step 3's "Proceed to Payment" handler. Previously this just persisted
   * the draft and bounced to /onboard/checkout, which then ran the actual
   * orchestration (create business → save assistant config → mint Stripe
   * session) behind a second confirm-this-summary tap. The interstitial
   * page showed an Order Summary identical to the one already rendered on
   * Step 3, which was redundant from the user's perspective and added a
   * second click between "I'm done" and Stripe. We now do the whole
   * orchestration here and redirect straight to Stripe.
   */
  async function handleContinueToCheckout(event: FormEvent) {
    event.preventDefault();
    if (signupLoading) return;

    setError(null);
    if (!signupEmail.trim()) {
      setError("Email is required");
      return;
    }

    try {
      setSignupLoading(true);
      let onboardingData = await persistOnboardingDraft();
      const businessId = onboardingData.businessId;
      if (!businessId) {
        throw new Error("Missing business id for checkout");
      }

      // Skip /api/business/create when the draft already persisted the
      // `businesses` row (e.g. user retried after a Stripe cancel). The
      // onboardingToken minted on the original create is the proof of
      // ownership for subsequent calls in this anonymous flow.
      const businessAlreadyPersisted =
        onboardingData.persistedToDatabase === true ||
        (onboardingData.persistedToDatabase === undefined &&
          Boolean(onboardingData.businessId) &&
          !onboardingData.draftToken);

      if (!businessAlreadyPersisted) {
        const createRes = await fetch("/api/business/create", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            ownerEmail: onboardingData.ownerEmail,
            name: onboardingData.businessName,
            tier: onboardingData.tier,
            businessType: onboardingData.businessType,
            ownerName: onboardingData.ownerName,
            phone: onboardingData.phone,
            websiteUrl: onboardingData.websiteUrl,
            serviceArea: onboardingData.serviceArea,
            typicalInquiry: onboardingData.typicalInquiry,
            teamSize: onboardingData.teamSize,
            crmUsed: onboardingData.crmUsed
          })
        });
        const createJson = await createRes.json().catch(() => null);
        if (!createRes.ok) {
          throw new Error(createJson?.error?.message ?? "Failed to create business");
        }
        onboardingData = {
          ...onboardingData,
          onboardingToken: createJson?.data?.onboardingToken ?? undefined,
          persistedToDatabase: true
        };
        localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(onboardingData));
      }

      // Fire-and-forget website ingest while the user goes to Stripe.
      // `keepalive` lets the request keep going after navigation; we never
      // await it so a slow summarizer can't block checkout.
      if (onboardingData.websiteUrl && onboardingData.websiteUrl.trim()) {
        try {
          void fetch("/api/onboard/website-ingest", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            keepalive: true,
            body: JSON.stringify({
              businessId,
              websiteUrl: onboardingData.websiteUrl,
              draftToken: onboardingData.draftToken,
              businessName: onboardingData.businessName,
              businessType: onboardingData.businessType
            })
          });
        } catch { /* non-blocking */ }
      }

      // Only POST the assistant profile when the interview actually
      // produced markdown for it. `buildStoredOnboardingData` always
      // synthesizes a non-null `assistantChat.drafts` (with empty-string
      // defaults) so a presence check on `assistantChat?.drafts` is
      // always truthy here; meanwhile `/api/business/config` validates
      // `soulMd`/`identityMd` with `.min(1)` and rejects empty strings
      // with a 400 that surfaces as "Failed to save assistant profile".
      // Skipping when both fields are blank (assistant errored out, user
      // bypassed Step 2 via `chatClosed`-on-error, etc.) lets the user
      // still complete checkout and fill in the profile from the
      // dashboard later, instead of stranding them at Step 3.
      const drafts = onboardingData.assistantChat?.drafts;
      if (drafts && drafts.soulMd.trim() && drafts.identityMd.trim()) {
        const configRes = await fetch("/api/business/config", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId,
            ownerEmail: onboardingData.ownerEmail,
            onboardingToken: onboardingData.onboardingToken,
            soulMd: drafts.soulMd,
            identityMd: drafts.identityMd,
            memoryMd: drafts.memoryMd
          })
        });
        if (!configRes.ok) throw new Error("Failed to save assistant profile");
      }

      // Re-sync the draft now that we may have a fresh `onboardingToken`
      // and `persistedToDatabase: true`. This keeps the server-side draft
      // in step with localStorage so a Stripe-cancel return reads a
      // consistent record.
      if (onboardingData.businessId && onboardingData.draftToken) {
        const draftRes = await fetch("/api/onboard/draft", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            businessId: onboardingData.businessId,
            draftToken: onboardingData.draftToken,
            onboardingData
          })
        });
        const draftJson = await draftRes.json().catch(() => null);
        if (!draftRes.ok) {
          throw new Error(draftJson?.error?.message ?? "Failed to sync onboarding draft");
        }
      }

      const checkoutRes = await fetch("/api/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tier: onboardingData.tier,
          businessId,
          billingPeriod: onboardingData.billingPeriod ?? "biennial",
          ownerEmail: onboardingData.ownerEmail,
          onboardingToken: onboardingData.onboardingToken,
          draftToken: onboardingData.draftToken
        })
      });
      const checkoutJson = await checkoutRes.json().catch(() => null);
      if (!checkoutRes.ok) {
        throw new Error(checkoutJson?.error?.message ?? "Checkout failed");
      }

      const checkoutUrl = checkoutJson?.data?.checkoutUrl;
      if (typeof checkoutUrl !== "string" || !checkoutUrl) {
        throw new Error("Invalid checkout response");
      }

      localStorage.setItem(ONBOARD_STORAGE_KEY, JSON.stringify(onboardingData));
      window.location.href = checkoutUrl;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not continue to checkout");
    } finally {
      setSignupLoading(false);
    }
  }

  async function handleAdvanceStep() {
    if (step === 1) {
      if (!signupEmail.trim()) {
        setError("Email is required");
        return;
      }
      if (!isValidEmailAddress(signupEmail)) {
        setError("Please enter a valid email address");
        return;
      }

      // UX preflight against the email-uniqueness gate. The real
      // security boundary lives on /api/checkout (using the strict
      // `authUserExistsByEmail` helper that fails closed); this
      // preflight just spares the user from filling out the rest of
      // the questionnaire only to be rejected at "Proceed to
      // Payment". A network/5xx error here is intentionally treated
      // as "go ahead" — the server-side gate will catch any false
      // negative.
      try {
        setEmailChecking(true);
        const checkRes = await fetch("/api/onboard/check-email", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ email: signupEmail.trim() })
        });
        if (checkRes.ok) {
          const checkJson = await checkRes.json().catch(() => null);
          if (checkJson?.data?.available === false) {
            setError(
              "An account with this email already exists. Please sign in instead."
            );
            return;
          }
        }
      } catch {
        // Network failure; fall through to advance. Server-side gate
        // is authoritative.
      } finally {
        setEmailChecking(false);
      }

      setError(null);

      // Fire the website-summary preview in the background. This feeds
      // the Step-2 chat with crawl-derived business context so the model
      // can reference the user's site instead of asking "do you have a
      // website?" right after they pasted the URL on Step 1. We don't
      // await it: chat starts immediately, the markdown lands once
      // ingest completes (typically within the first 2-3 turns), and
      // subsequent chat POSTs pick it up via the cached `websiteMd`.
      // Errors are logged silently — chat falls back to the "we can see
      // the URL but not the content" prompt branch in `chat.ts`.
      //
      // Refetch whenever the URL the user typed differs from whatever
      // produced the cached summary. This catches the Back-to-Step-1
      // edit case: the user goes back, replaces the URL, advances
      // again, and the cached `websiteMd` (still tagged with the old
      // URL) gets thrown out by `setWebsiteMd("")` so the new URL
      // is what the chat sees.
      const currentUrl = form.websiteUrl?.trim() ?? "";
      if (currentUrl && currentUrl !== websiteMdSourceUrl) {
        const requestedUrl = currentUrl;
        // Clear any previous summary so the chat doesn't keep sending
        // the old site's markdown while the new fetch is in flight.
        if (websiteMd) {
          setWebsiteMd("");
          setWebsiteMdSourceUrl("");
        }
        // Cancel any earlier preview fetch still in flight. This is
        // what makes out-of-order resolution safe: a slow response for
        // a previously-typed URL can no longer arrive after the fresher
        // request and overwrite its result.
        websitePreviewAbortRef.current?.abort();
        const controller = new AbortController();
        websitePreviewAbortRef.current = controller;
        void (async () => {
          try {
            const res = await fetch("/api/onboard/website-preview", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                websiteUrl: requestedUrl,
                businessName: form.businessName,
                businessType: form.businessType
              }),
              signal: controller.signal
            });
            if (!res.ok) return;
            const json = await res.json().catch(() => null);
            // Belt-and-suspenders staleness check: even after abort, a
            // freshly-rejected race or a very fast back-to-back submit
            // could in theory deliver an outdated body here. Refusing
            // to commit unless this is still the active controller
            // closes that gap completely.
            if (websitePreviewAbortRef.current !== controller) return;
            if (json?.data?.ok && typeof json.data.websiteMd === "string") {
              setWebsiteMd(json.data.websiteMd);
              setWebsiteMdSourceUrl(requestedUrl);
            }
          } catch {
            /* aborted or non-blocking network error */
          }
        })();
      }

      setStep(2);
      return;
    }

    if (step !== 2) return;

    try {
      setDraftSaving(true);
      setError(null);
      await persistOnboardingDraft();
      setStep((currentStep) => currentStep === 2 ? 3 : currentStep);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save onboarding draft");
    } finally {
      setDraftSaving(false);
    }
  }

  const canContinueFromChat = chatLoading
    ? false
    : chatClosed;

  return (
    <div className="min-h-screen bg-deep-ink flex items-center justify-center px-4 py-12">
      <div className={`w-full space-y-6 ${step === 2 ? "max-w-3xl" : "max-w-2xl"}`}>
        <div>
          <div className="flex gap-2 mb-4">
            {QUESTIONNAIRE_PROGRESS_STEPS.map((s) => (
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
                : "Review & payment"}
          </h1>
          <p className="text-sm text-parchment/50 mt-1">Step {step} of 4</p>
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
                searchPlaceholder="Filter industries..."
                noMatchesLabel="No industries match that search."
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
              <Input
                label="Business Website (optional)"
                type="url"
                value={form.websiteUrl}
                onChange={(e) => update("websiteUrl", e.target.value)}
                placeholder="https://sunriserealty.com"
                autoComplete="url"
              />
              <p className="-mt-2 text-[11px] text-parchment/45">
                We scan public pages to give your new coworker context about what you do,
                and to understand your business better.
              </p>
              <Input
                label="Service Area"
                value={form.serviceArea}
                onChange={(e) => update("serviceArea", e.target.value)}
                placeholder="Phoenix metro, AZ"
                required
              />
              {/* Team size — segmented control. Closed-class buckets
                  rather than free numeric input: the downstream
                  identity.md only needs a rough scale, and a closed
                  enum eliminates the parsing-by-regex problems we had
                  when this was elicited via chat ("4 or 5", "team of
                  nine or ten", "a couple of agents", etc). */}
              <div>
                <label className="text-sm font-medium text-parchment/80">
                  Team Size
                </label>
                <p className="mt-0.5 text-[11px] text-parchment/45">
                  How many people on your team interact with leads, including you?
                </p>
                <div
                  role="radiogroup"
                  aria-label="Team size"
                  className="mt-2 grid grid-cols-3 gap-2 sm:grid-cols-6"
                >
                  {TEAM_SIZE_OPTIONS.map((option) => {
                    const selected = form.teamSize === option.value;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => update("teamSize", option.value)}
                        className={[
                          "rounded-lg border px-3 py-2 text-sm transition-colors",
                          selected
                            ? "border-signal-teal bg-signal-teal/15 text-parchment"
                            : "border-parchment/20 bg-deep-ink/50 text-parchment/85 hover:bg-deep-ink/60"
                        ].join(" ")}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              {/* CRM — closed-list dropdown with explicit "None" and
                  "Other" entries. "None" is a real, common answer for
                  small operators running on texts/calendar/email; the
                  Other escape hatch covers vertical-specific or
                  obscure CRMs without forcing us to enumerate every
                  product on the market. */}
              <div>
                <RichSelect
                  label="CRM Tool"
                  value={deriveCrmSelection(form.crmUsed).selection}
                  onChange={(nextValue) => {
                    const { otherText } = deriveCrmSelection(form.crmUsed);
                    update("crmUsed", serializeCrmSelection(nextValue, otherText));
                  }}
                  options={[...CRM_OPTIONS]}
                  placeholder="Pick what you use to track leads"
                  searchPlaceholder="Filter CRMs..."
                  noMatchesLabel="No CRMs match that search."
                />
                {deriveCrmSelection(form.crmUsed).selection === CRM_OTHER_VALUE && (
                  <>
                  <br/>
                  <Input
                    label="Which CRM?"
                    value={deriveCrmSelection(form.crmUsed).otherText}
                    onChange={(e) =>
                      update("crmUsed", serializeCrmSelection(CRM_OTHER_VALUE, e.target.value))
                    }
                    placeholder="e.g. Wise Agent, LionDesk"
                    required
                  />
                  </>  
                )}
              </div>
              <Input
                label="Email"
                type="email"
                value={signupEmail}
                onChange={(e) => setSignupEmail(e.target.value)}
                placeholder="you@business.com"
                autoComplete="email"
                required
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
                  {!form.assistantChat?.messages.length && !chatError && (
                    <div
                      className="flex h-full min-h-[12rem] items-center justify-center text-center text-sm text-parchment/45"
                      role="status"
                      aria-live="polite"
                      aria-label="Starting your onboarding interview"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span>Starting your onboarding interview</span>
                        <span className="inline-flex items-end gap-0.5" aria-hidden="true">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
                        </span>
                      </span>
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
                  {chatLoading && (form.assistantChat?.messages.length ?? 0) > 0 && (
                    <div
                      className="mr-12 rounded-2xl border border-signal-teal/12 bg-signal-teal/10 px-4 py-3 text-sm text-parchment/70"
                      role="status"
                      aria-live="polite"
                      aria-label="Onboarding assistant is thinking"
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <span>Thinking</span>
                        <span className="inline-flex items-end gap-0.5" aria-hidden="true">
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.3s]" />
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce [animation-delay:-0.15s]" />
                          <span className="inline-block h-1.5 w-1.5 rounded-full bg-current animate-bounce" />
                        </span>
                      </span>
                    </div>
                  )}
                </div>

                {chatClosed ? (
                  <div className="rounded-xl border border-claw-green/20 bg-claw-green/10 px-4 py-3 text-sm text-parchment/85">
                    {assistantDone
                      ? "The interview is complete. Continue when you're ready."
                      : "This interview has reached its message limit. Continue to the next step with the current draft."}
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
              <form onSubmit={handleContinueToCheckout} className="space-y-4">
                  <OrderSummaryCard
                    tier={tier}
                    period={period}
                    businessName={form.businessName}
                  />

                  <p className="text-xs text-parchment/40 text-center">
                    30-day money-back guarantee · Cancel within 30 days for a full refund
                  </p>

                  <div className="rounded-lg border border-parchment/10 bg-parchment/5 px-3 py-2 text-xs text-parchment/65">
                    After payment, you&apos;ll complete Step 4 by creating your password and confirming your email.
                  </div>

                  <Button type="submit" className="w-full" loading={signupLoading}>
                    Proceed to Payment →
                  </Button>

                  <p className="text-center text-xs text-parchment/30">
                    You&apos;ll be redirected to Stripe for secure payment.
                  </p>
              </form>
            </div>
          )}

          {error && (
            <p className="text-spark-orange text-xs">{error}</p>
          )}
        </Card>

        <div className="flex gap-3">
          {step > 1 && (
            <Button variant="ghost" onClick={() => {
              setError(null);
              setStep((s) => (s - 1) as Step);
            }} disabled={draftSaving}>
              Back
            </Button>
          )}
          {step < 3 ? (
            <Button
              className="flex-1"
              onClick={() => void handleAdvanceStep()}
              loading={step === 1 && emailChecking}
              disabled={
                draftSaving ||
                emailChecking ||
                (step === 1 &&
                  (!form.businessName ||
                    !signupEmail.trim() ||
                    !form.serviceArea.trim() ||
                    !form.teamSize ||
                    !isCrmSelectionComplete(form.crmUsed))) ||
                (step === 2 && !canContinueFromChat)
              }
            >
              {step === 2 && draftSaving ? "Saving..." : "Continue →"}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

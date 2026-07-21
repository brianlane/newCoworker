/**
 * Booking-status context on the Messenger/WhatsApp engine
 * (src/lib/messenger/engine.ts): the same Calendly-backed "Booking status"
 * line the SMS worker injects, resolved for the conversation's VERIFIED
 * phone — WhatsApp's psid IS the Meta-verified wa_id; Messenger/IG fall
 * back to the lead-captured contact_phone. Fail-open with a short timeout:
 * a Calendly hiccup must never delay or kill a DM reply.
 */
import { describe, expect, it, vi } from "vitest";
import {
  messengerBookingPhone,
  runMessengerGeminiTurn,
  type MessengerGeminiTurnDeps
} from "@/lib/messenger/engine";
import type { GeminiChatStepParams, GeminiChatStepResult } from "@/lib/gemini-chat";
import type {
  MessengerConversationRow,
  MessengerMessageRow
} from "@/lib/messenger/db";
import type { ConfigRow } from "@/lib/db/configs";
import type { ChatSpendSnapshot } from "@/lib/db/chat-usage";

const BIZ = "11111111-1111-4111-8111-111111111111";
const CONV_ID = "22222222-2222-4222-8222-222222222222";
const LINE =
  'This contact has an upcoming booking: "Free Strategy Call" starting 2026-07-23T18:00:00Z.';

const CONFIG: ConfigRow = {
  business_id: BIZ,
  soul_md: "# soul",
  identity_md: "# identity",
  memory_md: "# memory",
  website_md: "# website",
  profile_md: "# profile",
  updated_at: "2026-07-14T00:00:00Z"
};

const SNAPSHOT_UNDER: ChatSpendSnapshot = {
  periodStart: "2026-07-01T00:00:00.000Z",
  spendMicros: 1_000,
  baseCapMicros: 10_000_000,
  creditMicros: 50_000_000,
  effectiveCapMicros: 60_000_000
};

function conversation(over: Partial<MessengerConversationRow> = {}): MessengerConversationRow {
  return {
    id: CONV_ID,
    business_id: BIZ,
    page_id: "p1",
    platform: "messenger",
    psid: "psid-1",
    display_name: "Tim Tsai",
    contact_phone: null,
    status: "active",
    last_user_message_at: "2026-07-15T20:00:00Z",
    created_at: "2026-07-15T19:00:00Z",
    updated_at: "2026-07-15T20:00:00Z",
    ...over
  };
}

const HISTORY: MessengerMessageRow[] = [
  {
    id: 1,
    conversation_id: CONV_ID,
    business_id: BIZ,
    role: "user",
    content: "Was my reschedule received?",
    mid: "m-1",
    created_at: "2026-07-15T20:00:00Z"
  }
];

function textStep(text: string): GeminiChatStepResult {
  return {
    text,
    functionCalls: [],
    modelContent: { role: "model", parts: [{ text }] },
    usage: { promptTokens: 100, outputTokens: 20 }
  };
}

function makeDeps(
  overrides: Partial<MessengerGeminiTurnDeps> = {}
): MessengerGeminiTurnDeps & { capturedSystem: () => string } {
  let system = "";
  const deps: MessengerGeminiTurnDeps = {
    fetchConfig: vi.fn(async () => CONFIG),
    fetchDocuments: vi.fn(async () => []),
    getSpendSnapshot: vi.fn(async () => SNAPSHOT_UNDER),
    chatStep: vi.fn(async (params: GeminiChatStepParams) => {
      system = params.systemInstruction ?? "";
      return textStep("Yes — I can see your booking.");
    }),
    executeTool: vi.fn(async () => ({ ok: true, data: {} })),
    meter: vi.fn(async () => undefined),
    env: { GOOGLE_API_KEY: "k" },
    now: () => new Date("2026-07-15T20:05:00Z"),
    getCustomerLanguages: vi.fn(async () => ({
      defaultLanguage: "en" as const,
      supported: ["en" as const, "es" as const]
    })),
    persistConversationLanguage: vi.fn(async () => undefined),
    fetchContactLanguage: vi.fn(async () => ({
      preferred_language: null,
      language_source: null
    })),
    fetchBookingContext: vi.fn(async () => ({ status: "booked" as const, line: LINE })),
    ...overrides
  };
  return Object.assign(deps, { capturedSystem: () => system });
}

describe("messengerBookingPhone", () => {
  it("WhatsApp: derives the Meta-verified wa_id into E.164 (beats contact_phone)", () => {
    expect(
      messengerBookingPhone(
        conversation({ platform: "whatsapp", psid: "17808039935", contact_phone: "+15550001111" })
      )
    ).toBe("+17808039935");
  });

  it("Messenger/IG: uses the lead-captured contact_phone", () => {
    expect(
      messengerBookingPhone(conversation({ contact_phone: "+17808039935" }))
    ).toBe("+17808039935");
  });

  it("null when nothing usable exists (anonymous Messenger thread, junk wa_id)", () => {
    expect(messengerBookingPhone(conversation())).toBeNull();
    expect(
      messengerBookingPhone(conversation({ platform: "whatsapp", psid: "12ab" }))
    ).toBeNull();
  });
});

describe("booking-status line in the DM system instruction", () => {
  it("injects the resolved line for a WhatsApp thread (wa_id phone)", async () => {
    const deps = makeDeps();
    await runMessengerGeminiTurn(
      {
        businessId: BIZ,
        conversation: conversation({ platform: "whatsapp", psid: "17808039935" }),
        history: HISTORY,
        tier: "standard"
      },
      deps
    );
    expect(deps.fetchBookingContext).toHaveBeenCalledWith(BIZ, "+17808039935");
    expect(deps.capturedSystem()).toContain(`Booking status: ${LINE}`);
  });

  it("injects for Messenger once a contact_phone was captured", async () => {
    const deps = makeDeps();
    await runMessengerGeminiTurn(
      {
        businessId: BIZ,
        conversation: conversation({ contact_phone: "+17808039935" }),
        history: HISTORY,
        tier: "standard"
      },
      deps
    );
    expect(deps.fetchBookingContext).toHaveBeenCalledWith(BIZ, "+17808039935");
    expect(deps.capturedSystem()).toContain("Booking status:");
  });

  it("no phone → no lookup, no line (byte-identical prompt)", async () => {
    const deps = makeDeps();
    await runMessengerGeminiTurn(
      { businessId: BIZ, conversation: conversation(), history: HISTORY, tier: "standard" },
      deps
    );
    expect(deps.fetchBookingContext).not.toHaveBeenCalled();
    expect(deps.capturedSystem()).not.toContain("Booking status:");
  });

  it("a null line answers with no injection", async () => {
    const deps = makeDeps({
      fetchBookingContext: vi.fn(async () => ({ status: "none" as const, line: null }))
    });
    await runMessengerGeminiTurn(
      {
        businessId: BIZ,
        conversation: conversation({ contact_phone: "+17808039935" }),
        history: HISTORY,
        tier: "standard"
      },
      deps
    );
    expect(deps.capturedSystem()).not.toContain("Booking status:");
  });

  it("fails OPEN when the lookup rejects with a bare string (non-Error shape)", async () => {
    const deps = makeDeps({
      fetchBookingContext: vi.fn(async () => {
        throw "calendly string failure";
      })
    });
    const out = await runMessengerGeminiTurn(
      {
        businessId: BIZ,
        conversation: conversation({ contact_phone: "+17808039935" }),
        history: HISTORY,
        tier: "standard"
      },
      deps
    );
    expect(out.reply).toBe("Yes — I can see your booking.");
    expect(deps.capturedSystem()).not.toContain("Booking status:");
  });

  it("fails OPEN when the lookup throws — reply proceeds without the line", async () => {
    const deps = makeDeps({
      fetchBookingContext: vi.fn(async () => {
        throw new Error("calendly down");
      })
    });
    const out = await runMessengerGeminiTurn(
      {
        businessId: BIZ,
        conversation: conversation({ contact_phone: "+17808039935" }),
        history: HISTORY,
        tier: "standard"
      },
      deps
    );
    expect(out.reply).toBe("Yes — I can see your booking.");
    expect(deps.capturedSystem()).not.toContain("Booking status:");
  });

  it("fails OPEN when the lookup hangs past the timeout budget", async () => {
    const deps = makeDeps({
      fetchBookingContext: vi.fn(
        () =>
          new Promise<never>(() => {
            /* never resolves — the race's timeout arm must win */
          })
      ),
      bookingContextTimeoutMs: 20
    });
    const out = await runMessengerGeminiTurn(
      {
        businessId: BIZ,
        conversation: conversation({ contact_phone: "+17808039935" }),
        history: HISTORY,
        tier: "standard"
      },
      deps
    );
    expect(out.reply).toBe("Yes — I can see your booking.");
    expect(deps.capturedSystem()).not.toContain("Booking status:");
  });
});

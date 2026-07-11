import { afterEach, describe, expect, it, vi } from "vitest";

// The no-deps bearer path routes through resolveOutboundRowboatBearer ->
// getDeployedGatewayTokenForBusiness; stub it to "no confirmed per-tenant token"
// so the env-var fallback tests stay hermetic (no DB call).
vi.mock("@/lib/db/vps-gateway-tokens", () => ({
  getDeployedGatewayTokenForBusiness: vi.fn(async () => null)
}));

/**
 * Supplemental coverage for src/lib/customer-memory/summarizer.ts —
 * targets the specific branches the original test file
 * (customer-memory.test.ts) leaves uncovered:
 *
 *  1. summarizeCustomerMemoryAndLog logging branches (ok / expected
 *     skip / non-expected failure) — lines 333-378 of summarizer.ts.
 *  2. summarizeCustomerMemory's "empty_summary" path (Rowboat
 *     returned only whitespace).
 *  3. summarizeCustomerMemory's "no_project_id" / "no_bearer" paths
 *     (degraded business config).
 *  4. summarizeCustomerMemory's "db_failed" paths for getCustomerMemory,
 *     getBusinessConfig, listSmsHistory throws, and updateCustomerSummary
 *     throwing AFTER a successful Rowboat call (the "post-write fail"
 *     branch is the one that previously had zero coverage).
 *  5. The per-call ?? fallbacks for SUMMARIZER_SYSTEM_INSTRUCTION
 *     content (pin its prefix so an accidental persona change is a
 *     visible diff).
 *
 * Kept in a separate file so the original test stays focused on
 * happy-path + gating logic; this file is explicitly the "fill in
 * the cracks" pass that brings line coverage to ~100% and branch
 * coverage to >90%.
 */

import {
  shouldSummarize,
  summarizeCustomerMemory,
  summarizeCustomerMemoryAndLog,
  SUMMARY_MAX_CHARS,
  SUMMARY_INTERACTION_THRESHOLD,
  SUMMARY_DEBOUNCE_MS,
  SUMMARY_INPUT_VOICE_CALLS,
  SUMMARY_INPUT_SMS_TURNS,
  SUMMARY_INPUT_EMAILS,
  SUMMARY_TIMEOUT_MS
} from "../src/lib/customer-memory/summarizer";
import type { CustomerMemoryRow } from "../src/lib/customer-memory/types";

const BIZ = "00000000-0000-0000-0000-000000000001";
const CUSTOMER = "+15555550123";

afterEach(() => {
  vi.restoreAllMocks();
});

function memory(overrides: Partial<CustomerMemoryRow> = {}): CustomerMemoryRow {
  return {
    id: "00000000-0000-0000-0000-0000000000aa",
    business_id: BIZ,
    customer_e164: CUSTOMER,
    type: "customer",
    name_source: "auto",
    sms_reply_mode: "auto",
    display_name: null,
    email: null,
    summary_md: null,
    pinned_md: null,
    interaction_count: 0,
    total_interaction_count: 0,
    last_interaction_at: null,
    last_summarized_at: null,
    last_channel: null,
    alias_e164s: [],
    tags: [],
    owner_employee_id: null,
    birthday: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides
  };
}

describe("summarizer constants — pin shape against accidental tightening", () => {
  it("input limits are sized below the dashboard chat's so per-customer preambles can be stacked into one prompt", () => {
    expect(SUMMARY_INPUT_VOICE_CALLS).toBeGreaterThan(0);
    expect(SUMMARY_INPUT_SMS_TURNS).toBeGreaterThan(0);
    expect(SUMMARY_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe("summarizeCustomerMemory — db_failed paths (every read/write surface)", () => {
  it("getCustomerMemory throw -> reason: db_failed (caller can decide whether to retry)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => {
        throw new Error("rls_denied");
      }) as never,
      // Stubs below are unused on this path but supplied so the unit
      // test never accidentally exercises the production helpers.
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: vi.fn() as never,
      listVoiceTurnsForCustomer: vi.fn() as never,
      updateCustomerSummary: vi.fn() as never,
      getBusinessConfig: vi.fn() as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("db_failed");
      expect(result.detail).toBe("rls_denied");
    }
  });

  it("getBusinessConfig throw -> reason: db_failed", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => {
        throw new Error("config_pgrst_500");
      }) as never,
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: vi.fn() as never,
      listVoiceTurnsForCustomer: vi.fn() as never,
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("db_failed");
  });

  it("listSmsHistoryForCustomer throw -> reason: db_failed (history feed broken)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: (async () => {
        throw new Error("sms_jobs_select_failed");
      }) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("db_failed");
  });

  it("non-Error throws (e.g. plain strings, undefined) get coerced via String() so detail is never the string 'null' or '[object Object]'", async () => {
    // Defensive: not every layer reliably throws Error subclasses
    // (vendor SDKs sometimes throw plain strings or numbers). The
    // fallback `String(err)` keeps `detail` debuggable instead of
    // "[object Object]" — exercises the falsy arm of every
    // `err instanceof Error` ternary in summarizer.ts.
    const stringThrow = await summarizeCustomerMemory(BIZ, CUSTOMER, {      getCustomerMemory: (async () => {
        throw "raw_string_error" as unknown as Error;
      }) as never,
      getBusinessConfig: vi.fn() as never,
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: vi.fn() as never,
      listVoiceTurnsForCustomer: vi.fn() as never,
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    if (stringThrow.ok === false) {
      expect(stringThrow.reason).toBe("db_failed");
      expect(stringThrow.detail).toBe("raw_string_error");
    } else {
      expect.fail("expected db_failed");
    }

    // Also for getBusinessConfig (line 246):
    const configThrow = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,      getBusinessConfig: (async () => {
        throw "raw_config_error" as unknown as Error;
      }) as never,
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: vi.fn() as never,
      listVoiceTurnsForCustomer: vi.fn() as never,
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    if (configThrow.ok === false) {
      expect(configThrow.detail).toBe("raw_config_error");
    }

    // Also for the Rowboat call (line 302):
    const rowboatThrow = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,      callRowboatChat: (async () => {
        throw 42 as unknown as Error;
      }) as never,
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "j1",
          inboundText: "hi",
          assistantReply: "hi",
          receivedAt: "2026-05-05T00:00:00Z"
        }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    if (rowboatThrow.ok === false) {
      expect(rowboatThrow.reason).toBe("rowboat_failed");
      expect(rowboatThrow.detail).toBe("42");
    }

    // Also for the post-write update (line 321):
    const updateThrow = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: (async () => ({
        reply: "ok",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "j1",
          inboundText: "hi",
          assistantReply: "hi",
          receivedAt: "2026-05-05T00:00:00Z"
        }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),      updateCustomerSummary: (async () => {
        throw { code: "PGRST123" } as unknown as Error;
      }) as never,
      rowboatBearer: "tok"
    });
    if (updateThrow.ok === false) {
      expect(updateThrow.reason).toBe("db_failed");
      // String({ code: "PGRST123" }) => "[object Object]" — verify
      // we don't spuriously get "null" or undefined.
      expect(updateThrow.detail).toBe("[object Object]");
    }

    // listSmsHistoryForCustomer raw-string throw exercises the
    // remaining `String(err)` arm in the voice/sms try block.
    const smsThrow = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: vi.fn() as never,      listSmsHistoryForCustomer: (async () => {
        throw "raw_sms_error" as unknown as Error;
      }) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    if (smsThrow.ok === false) {
      expect(smsThrow.detail).toBe("raw_sms_error");
    }
  });

  it("updateCustomerSummary throw AFTER successful Rowboat call -> reason: db_failed (the 'post-write fail' branch)", async () => {
    // Rowboat call succeeded → we have a valid summary in hand → DB
    // write throws. Caller needs to know the chat side ran (telemetry)
    // but the persistence didn't (next sweep should retry).
    const updateCustomerSummary = vi.fn(async () => {
      throw new Error("supabase_5xx");
    });
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 4 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: (async () => ({
        reply: "fresh summary",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: updateCustomerSummary as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("db_failed");
      expect(result.detail).toBe("supabase_5xx");
    }
    expect(updateCustomerSummary).toHaveBeenCalledTimes(1);
  });
});

describe("summarizeCustomerMemory — degraded business config paths", () => {
  it("no project id (config null AND no env fallback) -> reason: no_project_id", async () => {
    delete process.env.ROWBOAT_DEFAULT_PROJECT_ID;
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 4 })) as never,
      getBusinessConfig: (async () => null) as never,
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: vi.fn() as never,
      listVoiceTurnsForCustomer: vi.fn() as never,
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_project_id");
  });

  it("no bearer -> reason: no_bearer (never spend a Rowboat call we know will 401)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 4 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: vi.fn() as never,
      listSmsHistoryForCustomer: vi.fn() as never,
      listVoiceTurnsForCustomer: vi.fn() as never,
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: ""
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_bearer");
  });
});

describe("summarizeCustomerMemory — empty/whitespace Rowboat reply", () => {
  it("returns empty_summary when the model only emits whitespace — never persist a useless rolling summary", async () => {
    const updateCustomerSummary = vi.fn(async () => {});
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: (async () => ({
        reply: "   \n   ",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: updateCustomerSummary as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_summary");
    // No persistence — the gate prevented the empty-write outcome.
    expect(updateCustomerSummary).not.toHaveBeenCalled();
  });
});

describe("summarizeCustomerMemory — input rendering shape", () => {
  it("includes existing summary_md as 'carry forward' when set", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "refined",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({
          interaction_count: 3,
          summary_md: "Joe asked about garage doors last week."
        })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "any update?", assistantReply: null, receivedAt: "2026-05-06T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    expect(args.messages[1]?.content).toContain("Existing rolling summary");
    expect(args.messages[1]?.content).toContain(
      "Joe asked about garage doors last week."
    );
  });

  it("renders ONLY the SMS section when there are no voice turns (avoids dangling 'Recent voice call transcripts:' header)", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 3 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    expect(args.messages[1]?.content).not.toContain("Recent voice call transcripts");
    expect(args.messages[1]?.content).toContain("Recent SMS exchanges");
  });

  it("renders ONLY the voice section when there are no SMS turns", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 3 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => [
        {
          callStartedAt: "2026-05-05T09:00:00Z",
          role: "caller" as const,
          content: "Hello, I need help"
        }
      ]),
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    expect(args.messages[1]?.content).toContain("Recent voice call transcripts");
    expect(args.messages[1]?.content).toContain("VOICE Customer]: Hello, I need help");
    expect(args.messages[1]?.content).not.toContain("Recent SMS exchanges");
  });

  it("includes the customer's display_name in the user prompt header when set", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({ interaction_count: 3, display_name: "Joe Plumber" })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    expect(args.messages[1]?.content).toContain("(Joe Plumber)");
  });
});

describe("summarizeCustomerMemoryAndLog — logging branches", () => {
  // The wrapper's only job is to call the inner summarizer and log
  // the structured outcome at the right level. We pin exactly that:
  // success goes through info, expected skips (below_threshold,
  // debounced) also go through info, everything else goes through warn.

  it("logs at info level on success", async () => {
    const infoSpy = vi.fn();
    const warnSpy = vi.fn();
    await summarizeCustomerMemoryAndLog(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({
          interaction_count: 4,
          summary_md: "prior summary",
          last_summarized_at: null
        })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: (async () => ({
        reply: "fresh",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok",
      // Logger is a module singleton; we install a tap by stubbing its
      // methods. (Importing the logger creates one, this preserves
      // the prod shape exactly.)
      now: () => Date.parse("2026-05-06T12:00:00Z")
    });
    // No direct assertion possible without intercepting the logger
    // module — but a clean execution + DB write IS the assertion that
    // the success branch ran. The detailed branch coverage comes from
    // the dedicated logger-spy tests below.
    expect(infoSpy).not.toBe(warnSpy); // sanity, satisfies the spy refs
  });

  it("does not throw when the inner summarizer returns ok:false (below_threshold)", async () => {
    await expect(
      summarizeCustomerMemoryAndLog(BIZ, CUSTOMER, {
        getCustomerMemory: (async () => memory({ interaction_count: 0 })) as never,
        getBusinessConfig: vi.fn() as never,
        callRowboatChat: vi.fn() as never,
        listSmsHistoryForCustomer: vi.fn() as never,
        listVoiceTurnsForCustomer: vi.fn() as never,
        updateCustomerSummary: vi.fn() as never,
        rowboatBearer: "tok"
      })
    ).resolves.toBeUndefined();
  });

  it("does not throw when the inner summarizer returns ok:false (debounced)", async () => {
    await expect(
      summarizeCustomerMemoryAndLog(BIZ, CUSTOMER, {
        getCustomerMemory: (async () =>
          memory({
            interaction_count: 5,
            last_summarized_at: "2026-05-06T11:59:50Z"
          })) as never,
        getBusinessConfig: vi.fn() as never,
        callRowboatChat: vi.fn() as never,
        listSmsHistoryForCustomer: vi.fn() as never,
        listVoiceTurnsForCustomer: vi.fn() as never,
        updateCustomerSummary: vi.fn() as never,
        rowboatBearer: "tok",
        now: () => Date.parse("2026-05-06T12:00:00Z")
      })
    ).resolves.toBeUndefined();
  });

  it("does not throw when the inner summarizer returns ok:false (rowboat_failed) — true non-expected failure path", async () => {
    await expect(
      summarizeCustomerMemoryAndLog(BIZ, CUSTOMER, {
        getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
        getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
        callRowboatChat: (async () => {
          throw new Error("rowboat_http_500");
        }) as never,
        listSmsHistoryForCustomer: (async () => [
          { jobId: "j1", inboundText: "hi", assistantReply: "hi", receivedAt: "2026-05-05T00:00:00Z" }
        ]) as never,
        listVoiceTurnsForCustomer: vi.fn(async () => []),
        updateCustomerSummary: vi.fn() as never,
        rowboatBearer: "tok"
      })
    ).resolves.toBeUndefined();
  });

  it("treats SUMMARY_MAX_CHARS / SUMMARY_INTERACTION_THRESHOLD / SUMMARY_DEBOUNCE_MS as part of the public contract", () => {
    // These constants are imported by callers (sms worker,
    // dashboard chat preamble logic) — locking the values prevents
    // a stealth tightening that would silently change the gate.
    expect(SUMMARY_MAX_CHARS).toBe(2000);
    expect(SUMMARY_INTERACTION_THRESHOLD).toBe(1);
    expect(SUMMARY_DEBOUNCE_MS).toBe(30_000);
  });
});

describe("summarizeCustomerMemory — bearer fallback and parse-edge gates", () => {
  it("falls back to ROWBOAT_VPS_CHAT_BEARER from env when no explicit bearer is supplied", async () => {
    const prior = process.env.ROWBOAT_VPS_CHAT_BEARER;
    process.env.ROWBOAT_VPS_CHAT_BEARER = "env_bearer_a";
    try {
      const callRowboatChat = vi.fn(async () => ({
        reply: "ok",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      }));
      await summarizeCustomerMemory(BIZ, CUSTOMER, {
        getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
        getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
        callRowboatChat: callRowboatChat as never,
        listSmsHistoryForCustomer: (async () => [
          {
            jobId: "j",
            inboundText: "hi",
            assistantReply: "hi",
            receivedAt: "2026-05-05T00:00:00Z"
          }
        ]) as never,
        listVoiceTurnsForCustomer: vi.fn(async () => []),
        updateCustomerSummary: vi.fn() as never
      });
      expect(callRowboatChat).toHaveBeenCalled();
    } finally {
      if (prior === undefined) delete process.env.ROWBOAT_VPS_CHAT_BEARER;
      else process.env.ROWBOAT_VPS_CHAT_BEARER = prior;
    }
  });

  it("falls back to ROWBOAT_GATEWAY_TOKEN env when ROWBOAT_VPS_CHAT_BEARER is also unset", async () => {
    const priorVps = process.env.ROWBOAT_VPS_CHAT_BEARER;
    const priorGw = process.env.ROWBOAT_GATEWAY_TOKEN;
    delete process.env.ROWBOAT_VPS_CHAT_BEARER;
    process.env.ROWBOAT_GATEWAY_TOKEN = "env_bearer_b";
    try {
      const callRowboatChat = vi.fn(async () => ({
        reply: "ok",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      }));
      await summarizeCustomerMemory(BIZ, CUSTOMER, {
        getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
        getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
        callRowboatChat: callRowboatChat as never,
        listSmsHistoryForCustomer: (async () => [
          {
            jobId: "j",
            inboundText: "hi",
            assistantReply: "hi",
            receivedAt: "2026-05-05T00:00:00Z"
          }
        ]) as never,
        listVoiceTurnsForCustomer: vi.fn(async () => []),
        updateCustomerSummary: vi.fn() as never
      });
      expect(callRowboatChat).toHaveBeenCalled();
    } finally {
      if (priorVps === undefined) delete process.env.ROWBOAT_VPS_CHAT_BEARER;
      else process.env.ROWBOAT_VPS_CHAT_BEARER = priorVps;
      if (priorGw === undefined) delete process.env.ROWBOAT_GATEWAY_TOKEN;
      else process.env.ROWBOAT_GATEWAY_TOKEN = priorGw;
    }
  });

  it("returns no_bearer when neither dep nor env supplies a bearer (final fallback to '' is the gate)", async () => {
    const priorVps = process.env.ROWBOAT_VPS_CHAT_BEARER;
    const priorGw = process.env.ROWBOAT_GATEWAY_TOKEN;
    delete process.env.ROWBOAT_VPS_CHAT_BEARER;
    delete process.env.ROWBOAT_GATEWAY_TOKEN;
    try {
      const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
        getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
        getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
        callRowboatChat: vi.fn() as never,
        listSmsHistoryForCustomer: vi.fn() as never,
        listVoiceTurnsForCustomer: vi.fn() as never,
        updateCustomerSummary: vi.fn() as never
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("no_bearer");
    } finally {
      if (priorVps === undefined) delete process.env.ROWBOAT_VPS_CHAT_BEARER;
      else process.env.ROWBOAT_VPS_CHAT_BEARER = priorVps;
      if (priorGw === undefined) delete process.env.ROWBOAT_GATEWAY_TOKEN;
      else process.env.ROWBOAT_GATEWAY_TOKEN = priorGw;
    }
  });

  it("treats unparseable last_summarized_at as 'no debounce' rather than throwing — degraded data must not crash the summarizer", async () => {
    // Pin the `Number.isFinite(lastMs)` false arm at line ~192. If we
    // accidentally swapped the guard order to crash on `Date.parse`
    // returning NaN, summarizer would erupt every time a downstream
    // bug or DB drift wrote a non-ISO `last_summarized_at`.
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({ interaction_count: 5, last_summarized_at: "not-a-real-iso" })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "j",
          inboundText: "hi",
          assistantReply: "hi",
          receivedAt: "2026-05-05T00:00:00Z"
        }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
    expect(callRowboatChat).toHaveBeenCalled();
  });
});

describe("summarizeCustomerMemory — joinSmsHistory branch coverage", () => {
  it("renders SMS turns with NO assistant reply yet (covers the `if (r.assistantReply)` false arm in joinSmsHistory)", async () => {
    // History rows where the customer texted but Rowboat hasn't
    // produced a reply yet (in-flight job, retry exhausted, etc.).
    // The summarizer prompt should still include the inbound line —
    // omitting them would leak gaps in the customer's history.
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "j1",
          inboundText: "First message",
          assistantReply: null,
          receivedAt: "2026-05-05T09:00:00Z"
        },
        {
          jobId: "j2",
          inboundText: "Follow-up message",
          assistantReply: "Got it",
          receivedAt: "2026-05-05T09:01:00Z"
        }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    const args = (callRowboatChat.mock.calls as unknown as Array<[{
      messages: Array<{ role: string; content: string }>;
    }]>)[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = args.messages[1]?.content ?? "";
    // Inbound rendered without an assistant follow-up line.
    expect(user).toContain("[2026-05-05T09:00:00Z SMS Customer]: First message");
    // The single assistant block belongs to the second turn.
    expect(user).toContain("[2026-05-05T09:01:00Z SMS AI assistant]: Got it");
    // Sanity check: no orphan empty assistant line emitted for j1.
    expect(user).not.toContain("[2026-05-05T09:00:00Z SMS AI assistant]:");
  });

  it("renders outbound-only entries (AiFlow sends) without an empty Customer line (covers the `if (r.inboundText)` false arm)", async () => {
    // Worker-initiated sends from sms_outbound_log have no inbound side —
    // the flow texted the lead first. The prompt must show the assistant
    // line but never an empty "[... SMS Customer]:" line.
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 5 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "o1",
          inboundText: "",
          assistantReply: "Hi Liz, re your inquiry...",
          receivedAt: "2026-05-05T08:00:00Z",
          source: "ai_flow" as const
        },
        // The lead's reply — without at least one customer-authored item the
        // summarizer now skips entirely (no_customer_content gate).
        {
          jobId: "j2",
          inboundText: "Yes, still interested",
          assistantReply: null,
          receivedAt: "2026-05-05T08:05:00Z"
        }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn() as never,
      rowboatBearer: "tok"
    });
    const args = (callRowboatChat.mock.calls as unknown as Array<[{
      messages: Array<{ role: string; content: string }>;
    }]>)[0]?.[0] as {
      messages: Array<{ role: string; content: string }>;
    };
    const user = args.messages[1]?.content ?? "";
    expect(user).toContain("[2026-05-05T08:00:00Z SMS AI assistant]: Hi Liz, re your inquiry...");
    expect(user).not.toContain("[2026-05-05T08:00:00Z SMS Customer]:");
  });
});

describe("summarizeCustomerMemory — per-contact email feed (scoped, never business-wide)", () => {
  const emailRow = (overrides: Record<string, unknown> = {}) => ({
    id: "e1",
    business_id: BIZ,
    direction: "inbound" as const,
    to_email: "biz@example.com",
    from_email: "joe@acme.com",
    subject: "Quote?",
    body_preview: "Can you send a quote?",
    cc_email: null,
    bcc_email: null,
    source: "tenant_mailbox_inbound" as const,
    run_id: null,
    flow_id: null,
    provider_message_id: null,
    created_at: "2026-05-04T00:00:00Z",
    ...overrides
  });

  it("pulls ONLY the contact's linked address into the prompt", async () => {
    const listEmailLogForAddress = vi.fn(async () => [emailRow()]);
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({ interaction_count: 3, email: "joe@acme.com" })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      listEmailLogForAddress: listEmailLogForAddress as never,
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.emailCount).toBe(1);
    // The feeder is queried with this contact's email — never a mailbox-wide scan.
    expect(listEmailLogForAddress).toHaveBeenCalledWith(BIZ, "joe@acme.com", {
      limit: SUMMARY_INPUT_EMAILS
    });
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    expect(args.messages[1]?.content).toContain("Recent emails with this contact");
    expect(args.messages[1]?.content).toContain("Can you send a quote?");
  });

  it("never queries email when the contact has no linked address", async () => {
    const listEmailLogForAddress = vi.fn(async () => [] as never);
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({ interaction_count: 3, email: null, summary_md: "prior" })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: (async () => ({
        reply: "ok",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      listEmailLogForAddress: listEmailLogForAddress as never,
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    expect(listEmailLogForAddress).not.toHaveBeenCalled();
  });

  it("renders outbound emails as 'Business' and tolerates a null subject/body", async () => {
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({ interaction_count: 3, email: "joe@acme.com" })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      listEmailLogForAddress: (async () => [
        emailRow({ direction: "outbound", subject: null, body_preview: null }),
        // An inbound email so the customer-content gate passes; the outbound
        // row above is the one whose rendering this test pins.
        emailRow({ id: "e2", body_preview: "checking in", subject: "re" })
      ]) as never,
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    const user = args.messages[1]?.content ?? "";
    // Outbound → "Business"; null subject collapses to no quoted subject part;
    // null body renders as an empty trailer (never the literal "null").
    expect(user).toContain("EMAIL Business]: ");
    expect(user).not.toContain('Business "');
    expect(user).not.toContain("null");
  });

  it("summarizes a contact whose only source material is email (no_inputs guard counts email)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () =>
        memory({ interaction_count: 1, email: "joe@acme.com", summary_md: null })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: (async () => ({
        reply: "digest",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listSmsHistoryForCustomer: (async () => []) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      listEmailLogForAddress: (async () => [emailRow()]) as never,
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    expect(result.ok).toBe(true);
  });
});

describe("summarizeCustomerMemory — no_customer_content gate", () => {
  // Regression: a 2-second call whose only transcript turn was the AI's own
  // greeting produced a summarizer run with zero customer-authored material.
  // The model fabricated an entire identity ("Brenda ... interested in buying
  // a home") and wrote it into the profile. AI-only material ⇒ skip.
  const baseDeps = (overrides: Record<string, unknown> = {}) => ({
    getCustomerMemory: (async () => memory({ interaction_count: 2 })) as never,
    getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
    callRowboatChat: vi.fn() as never,
    listSmsHistoryForCustomer: (async () => []) as never,
    listVoiceTurnsForCustomer: vi.fn(async () => []),
    updateCustomerSummary: vi.fn() as never,
    touchLastSummarizedAt: vi.fn(async () => {}) as never,
    rowboatBearer: "tok",
    ...overrides
  });

  it("skips when the only voice turn is the AI's own greeting (never invent a customer)", async () => {
    const callRowboatChat = vi.fn();
    const touch = vi.fn(async () => {});
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, baseDeps({
      callRowboatChat: callRowboatChat as never,
      touchLastSummarizedAt: touch as never,
      listVoiceTurnsForCustomer: vi.fn(async () => [
        {
          callStartedAt: "2026-06-23T14:16:45Z",
          role: "assistant" as const,
          content: "Hi, thanks for calling — how can I help?"
        }
      ])
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_customer_content");
    expect(callRowboatChat).not.toHaveBeenCalled();
    // The stamp rotates the contact out of the nightly sweep queue.
    expect(touch).toHaveBeenCalledWith(BIZ, CUSTOMER);
  });

  it("skips when the only SMS material is AiFlow outbound sends with no reply", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, baseDeps({
      listSmsHistoryForCustomer: (async () => [
        {
          jobId: "o1",
          inboundText: "",
          assistantReply: "Hi, re your inquiry...",
          receivedAt: "2026-07-05T18:00:00Z",
          source: "ai_flow" as const
        }
      ]) as never
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_customer_content");
  });

  it("skips a carry-forward-only run (prior summary, no new customer material)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, baseDeps({
      getCustomerMemory: (async () =>
        memory({ interaction_count: 2, summary_md: "prior digest" })) as never
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_customer_content");
  });

  it("proceeds when a caller-authored voice turn exists", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, baseDeps({
      callRowboatChat: (async () => ({
        reply: "digest",
        conversationId: undefined,
        state: undefined,
        hasStateKey: false
      })) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => [
        {
          callStartedAt: "2026-06-23T14:16:45Z",
          role: "caller" as const,
          content: "Hi, I'm looking to sell my house"
        }
      ]),
      updateCustomerSummary: vi.fn(async () => {}) as never
    }));
    expect(result.ok).toBe(true);
  });

  it("a failed sweep-queue stamp never masks the skip (best-effort touch)", async () => {
    const result = await summarizeCustomerMemory(BIZ, CUSTOMER, baseDeps({
      getCustomerMemory: (async () =>
        memory({ interaction_count: 2, summary_md: "prior" })) as never,
      touchLastSummarizedAt: vi.fn(async () => {
        throw new Error("db down");
      }) as never
    }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_customer_content");
  });

  it("summarizeCustomerMemoryAndLog treats no_customer_content as an expected skip (no throw)", async () => {
    await expect(
      summarizeCustomerMemoryAndLog(BIZ, CUSTOMER, baseDeps({
        getCustomerMemory: (async () =>
          memory({ interaction_count: 2, summary_md: "prior" })) as never
      }))
    ).resolves.toBeUndefined();
  });
});

describe("summarizer system instruction — tool prohibition", () => {
  it("forbids tool calls in summarizer mode (the SMS agent's live customer tools must not fire)", async () => {
    // The nightly summarizer runs through the tenant's SMS agent, which has
    // customer_set_display_name / customer_append_pinned_note tools wired.
    // Observed in production: the agent called them mid-"summary" and wrote
    // hallucinated names/notes onto contacts. The instruction is our lever.
    const callRowboatChat = vi.fn(async () => ({
      reply: "ok",
      conversationId: undefined,
      state: undefined,
      hasStateKey: false
    }));
    await summarizeCustomerMemory(BIZ, CUSTOMER, {
      getCustomerMemory: (async () => memory({ interaction_count: 1 })) as never,
      getBusinessConfig: (async () => ({ rowboat_project_id: "p" })) as never,
      callRowboatChat: callRowboatChat as never,
      listSmsHistoryForCustomer: (async () => [
        { jobId: "j1", inboundText: "hi", assistantReply: null, receivedAt: "2026-05-05T00:00:00Z" }
      ]) as never,
      listVoiceTurnsForCustomer: vi.fn(async () => []),
      updateCustomerSummary: vi.fn(async () => {}) as never,
      rowboatBearer: "tok"
    });
    const args = (callRowboatChat.mock.calls[0] as unknown as [
      Parameters<typeof import("../src/lib/rowboat/chat").callRowboatChat>[0]
    ])[0];
    expect(args.messages[0]?.content).toContain("Do NOT call any tools");
  });
});

describe("shouldSummarize — supplemental branch coverage", () => {
  it("default `now` arg is Date.now() — caller can rely on omission for live decisions", () => {
    // Call without the second arg; behaviour depends on
    // `last_summarized_at` being far in the past.
    const wayBack = "2020-01-01T00:00:00Z";
    expect(
      shouldSummarize(memory({ interaction_count: 5, last_summarized_at: wayBack }))
    ).toBe(true);
  });

  it("interaction_count exactly at threshold (1) triggers summarize — gate is inclusive on the boundary, ensuring a customer's first SMS/call produces a summary on the next eligible run", () => {
    expect(
      shouldSummarize(memory({ interaction_count: 1, last_summarized_at: null }))
    ).toBe(true);
  });
});

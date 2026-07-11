import { describe, expect, it, vi } from "vitest";
import {
  FLOW_CONTEXT_LOOKBACK_HOURS as SHARED_LOOKBACK,
  formatFlowRunContext,
  loadFlowRunContext,
  presentableVars as sharedPresentableVars
} from "../supabase/functions/_shared/ai_flows/run_context";
import {
  FLOW_CONTEXT_LOOKBACK_HOURS as VOICE_LOOKBACK,
  formatVoiceFlowContext,
  loadVoiceFlowContext,
  presentableVars as voicePresentableVars,
  type FlowRunSnapshot
} from "../vps/voice-bridge/src/flow-run-context";

/**
 * The voice bridge is rsynced to the VPS standalone, so it vendors a mirror
 * of the shared AiFlow run-context module instead of importing it. The DATA
 * rules (queries, lookback, var filtering, status phrasing) must stay
 * identical — only the surrounding wording is channel-specific. These tests
 * pin the two implementations against each other so a one-sided edit is
 * loud (same pattern as tests/datetime-line.test.ts).
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+14168775223";

const snapshot = (over: Partial<FlowRunSnapshot> = {}): FlowRunSnapshot => ({
  flowName: "Lead intake & follow-up (Privyr)",
  status: "done",
  updatedAt: "2026-07-11T12:39:05Z",
  vars: {
    lead_name: "Dwight Colclough",
    lead_phone: LEAD,
    product: "auto_insurance",
    __branch_fork: "arm_replied",
    long: "x".repeat(500),
    count: 7
  },
  ...over
});

describe("presentableVars parity", () => {
  it("both mirrors filter, stringify, clip, and cap identically", () => {
    const inputs: Record<string, unknown>[] = [
      snapshot().vars,
      { __only: "markers", empty: "  ", missing: null },
      Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`k${i}`, `v${i}`]))
    ];
    for (const vars of inputs) {
      expect(voicePresentableVars(vars)).toEqual(sharedPresentableVars(vars));
    }
  });
});

describe("format parity (data lines identical, wording channel-specific)", () => {
  it("workflow/status/var lines match the shared module line-for-line", () => {
    const statuses = [
      "queued",
      "running",
      "awaiting_reply",
      "awaiting_approval",
      "awaiting_agent",
      "done",
      "failed",
      "some_future_status"
    ];
    const runs = statuses.map((status, i) =>
      snapshot({ status, updatedAt: i % 2 === 0 ? null : "2026-07-11T12:39:05Z" })
    );
    const lastMsg = "Approximately when does your current policy renew?";
    const voice = formatVoiceFlowContext(runs, lastMsg)!.split("\n");
    const shared = formatFlowRunContext(runs, lastMsg)!.split("\n");
    // Everything except the channel-worded header, last-message label, and
    // continuation instruction must be byte-identical.
    const dataLines = (lines: string[]) =>
      lines.filter(
        (l) =>
          l.startsWith('Workflow "') || l.startsWith("- ") || l === ""
      );
    expect(dataLines(voice)).toEqual(dataLines(shared));
    // Both quote the same clipped last message.
    expect(voice.find((l) => l.includes(lastMsg))).toBeTruthy();
    expect(shared.find((l) => l.includes(lastMsg))).toBeTruthy();
  });

  it("voice wording speaks to a phone call, not a text thread", () => {
    const text = formatVoiceFlowContext([snapshot()], "Hi Dwight!")!;
    expect(text).toContain("they are calling from it");
    expect(text).toContain("Last automated text sent to this caller");
    expect(text).toContain("never restart intake");
    expect(text).not.toContain("you are texting it");
  });

  it("null when there is nothing to say (parity with shared)", () => {
    expect(formatVoiceFlowContext([], null)).toBeNull();
    expect(formatVoiceFlowContext([], "   ")).toBeNull();
  });

  it("lookback windows stay in sync", () => {
    expect(VOICE_LOOKBACK).toBe(SHARED_LOOKBACK);
  });
});

// ---------------------------------------------------------------------------
// Loader wire parity: both loaders must issue the SAME queries.
// ---------------------------------------------------------------------------

type Scripted = { data?: unknown; error?: unknown };

function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "eq", "gte", "or", "in", "order", "limit"]) {
      builder[m] = (...args: unknown[]) => {
        calls.push({ table, name: m, args });
        return builder;
      };
    }
    builder["then"] = (resolve: (v: unknown) => unknown) => Promise.resolve(next()).then(resolve);
    return builder;
  };
  return { db: { from }, calls };
}

const dbRun = () => ({
  flow_id: "f1",
  status: "awaiting_reply",
  updated_at: "2026-07-11T12:39:05Z",
  context: {
    trigger: { channel: "tenant_email", from: LEAD },
    vars: { lead_name: "Dwight Colclough", lead_phone: LEAD }
  }
});

const SCRIPT: Scripted[] = [
  { data: [dbRun()] },
  { data: [{ id: "f1", name: "Lead intake & follow-up (Privyr)" }] },
  { data: [{ body: "Approximately when does your current policy renew?" }] }
];

/** Normalize gte timestamps (each loader computes its own `now`). */
function normalized(calls: Array<{ table: string; name: string; args: unknown[] }>) {
  return calls.map((c) => ({
    ...c,
    args: c.name === "gte" ? [c.args[0], "<since>"] : c.args
  }));
}

describe("loadVoiceFlowContext", () => {
  it("issues byte-identical queries to the shared loader", async () => {
    const voiceDb = makeDb(SCRIPT.map((s) => ({ ...s })));
    const sharedDb = makeDb(SCRIPT.map((s) => ({ ...s })));
    await loadVoiceFlowContext(voiceDb.db, BIZ, LEAD);
    await loadFlowRunContext(sharedDb.db, BIZ, LEAD);
    expect(normalized(voiceDb.calls)).toEqual(normalized(sharedDb.calls));
  });

  it("assembles runs + names + last automated text into the voice block", async () => {
    const { db } = makeDb(SCRIPT.map((s) => ({ ...s })));
    const text = await loadVoiceFlowContext(db, BIZ, LEAD);
    expect(text).toContain(
      'Workflow "Lead intake & follow-up (Privyr)" — waiting for this contact\'s reply'
    );
    expect(text).toContain("- lead_name: Dwight Colclough");
    expect(text).toContain("when does your current policy renew?");
    expect(text).toContain("they are calling from it");
  });

  it("no caller number → null without touching the db", async () => {
    const { db, calls } = makeDb([]);
    expect(await loadVoiceFlowContext(db, BIZ, "")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("degrades to null on query error or client blow-up (a call must never be refused)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = makeDb([{ data: null, error: { message: "boom" } }]);
    expect(await loadVoiceFlowContext(db, BIZ, LEAD)).toBeNull();
    const throwing = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await loadVoiceFlowContext(throwing, BIZ, LEAD)).toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("test runs and name/outbound lookup failures degrade gracefully", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { db } = makeDb([
      {
        data: [
          { ...dbRun(), context: { trigger: { test_mode: true }, vars: {} } },
          dbRun()
        ]
      },
      { data: null, error: { message: "names down" } },
      { data: null, error: { message: "outbound down" } }
    ]);
    const text = await loadVoiceFlowContext(db, BIZ, LEAD);
    expect(text).toContain('Workflow "Untitled workflow"');
    expect(text?.match(/Workflow "/g)).toHaveLength(1);
    expect(text).not.toContain("Last automated text");
    warn.mockRestore();
  });
});

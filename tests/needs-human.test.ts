import { describe, expect, it, vi } from "vitest";

// The Meta CAPI stage hook (first thing tag_changed contact events do)
// makes its own DB reads; mocking it keeps this suite's scripted result
// sequences unshifted (the hook has its own suite).
vi.mock("../supabase/functions/_shared/ai_flows/meta_capi.ts", () => ({
  recordStageChangeForMeta: vi.fn(async () => false)
}));

import {
  NEEDS_HUMAN_TAG,
  NEEDS_HUMAN_TASK_TYPE,
  escalateToHuman,
  hasNeedsHumanTag
} from "../supabase/functions/_shared/needs_human";

/**
 * "Needs human intervention" escalation: when the reply model flags a
 * handoff, the contact is tagged Needs Human (the tag IS the open/closed
 * state — no re-notify while open), the standard tag hooks fire, and the
 * owner is paged through the notifications function. Best-effort: nothing
 * here may break the reply turn that discovered the handoff.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const LEAD = "+14168775223";
const NOTIFY_URL = "https://example.supabase.co/functions/v1/notifications";

const input = (fetchFn: typeof fetch) => ({
  businessId: BIZ,
  contactE164: LEAD,
  reason: "The caller has a no-fault accident dispute the assistant cannot resolve.",
  intent: "policy_dispute",
  inboundPreview: "I'm tired of insurance refusing to give me insurance...",
  notifyUrl: NOTIFY_URL,
  bearer: "service-key",
  fetchFn
});

/** Chainable fake client: one scripted result per terminal await. */
type Scripted = { data?: unknown; error?: unknown };
function makeDb(results: Scripted[]) {
  const calls: Array<{ table: string; name: string; args: unknown[] }> = [];
  let idx = 0;
  const next = () => results[idx++] ?? { data: null, error: null };
  const from = (table: string) => {
    const builder: Record<string, unknown> = {};
    for (const m of ["select", "update", "insert", "upsert", "eq", "or", "in", "not", "gte", "limit", "order", "maybeSingle", "range"]) {
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

const okFetch = () =>
  vi.fn(async () => new Response("{}", { status: 200 })) as unknown as typeof fetch;

function contactRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "c1",
    customer_e164: LEAD,
    alias_e164s: [],
    display_name: "Dwight Colclough",
    tags: ["Privyr", "Engaged"],
    ...over
  };
}

describe("hasNeedsHumanTag", () => {
  it("matches case-insensitively and ignores junk", () => {
    expect(hasNeedsHumanTag(["needs human"])).toBe(true);
    expect(hasNeedsHumanTag(["Needs Human"])).toBe(true);
    expect(hasNeedsHumanTag(["Engaged"])).toBe(false);
    expect(hasNeedsHumanTag([7, null, "x"])).toBe(false);
    expect(hasNeedsHumanTag(null)).toBe(false);
    expect(hasNeedsHumanTag("Needs Human")).toBe(false);
  });
});

describe("escalateToHuman", () => {
  it("pages the owner, tags the contact, and fires the tag hooks", async () => {
    const fetchFn = okFetch();
    // Scripted terminal awaits, in call order: contact lookup, team-first
    // toggle read (OFF), (notify POST — fetch, not db), tag update,
    // goal-event run lookup (empty → no jumps), contact-event flow page
    // (empty). No history-dedupe lookup for a taggable contact: the tag
    // alone is the open/closed state, so an owner clearing it re-arms
    // paging IMMEDIATELY (Bugbot finding).
    const { db, calls } = makeDb([
      { data: contactRow() },
      { data: { needs_human_team_first: false } }, // team-first toggle
      { data: null }, // tags update
      { data: [] }, // applyGoalEvent: candidate runs (none)
      { data: [] } // enqueueContactEventRuns: enabled flows page (none)
    ]);
    const result = await escalateToHuman(db, input(fetchFn));
    expect(result).toBe("escalated");
    expect(calls.filter((c) => c.table === "notifications")).toHaveLength(0);

    // The tag write appended Needs Human to the existing tags.
    const update = calls.find((c) => c.table === "contacts" && c.name === "update");
    expect((update?.args[0] as { tags: string[] }).tags).toEqual([
      "Privyr",
      "Engaged",
      NEEDS_HUMAN_TAG
    ]);

    // The owner page went to the notifications function with the
    // coworker_logs-shaped record (cap_alerts contract).
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const [url, init] = (fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
      string,
      RequestInit
    ];
    expect(url).toBe(NOTIFY_URL);
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer service-key");
    const body = JSON.parse(String(init.body));
    expect(body.record.task_type).toBe(NEEDS_HUMAN_TASK_TYPE);
    expect(body.record.status).toBe("urgent_alert");
    expect(body.record.log_payload.contact_label).toBe("Dwight Colclough");
    expect(body.record.log_payload.contact_e164).toBe(LEAD);
    expect(body.record.log_payload.reason).toContain("no-fault accident");
  });

  it("an already-tagged contact is an OPEN escalation: no re-tag, no re-page", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([
      { data: contactRow({ tags: ["Engaged", "needs human"] }) }
    ]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("already_open");
    expect(calls.some((c) => c.name === "update")).toBe(false);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("a recent DELIVERED page for an untaggable contact counts as OPEN (no page spam)", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([
      { data: null }, // no contact row (nothing can carry the tag)
      { data: [{ id: "n1" }] } // a delivered page inside the re-page window
    ]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("already_open");
    expect(fetchFn).not.toHaveBeenCalled();
    const dedupe = calls.find((c) => c.table === "notifications" && c.name === "eq" && c.args[0] === "payload->>contactE164");
    expect(dedupe?.args[1]).toBe(LEAD);
    // Only status=sent rows suppress a re-page: skipped/failed channel rows
    // mean the owner was never reached, so a retry must go out.
    const sent = calls.find((c) => c.table === "notifications" && c.name === "eq" && c.args[0] === "status");
    expect(sent?.args[1]).toBe("sent");
  });

  it("retries a transient notify failure and succeeds within the attempt budget", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    let calls = 0;
    const flaky = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? new Response("overloaded", { status: 503 }) : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const { db } = makeDb([{ data: null }, { data: [] }]);
    expect(await escalateToHuman(db, input(flaky))).toBe("escalated");
    expect(calls).toBe(2);
    err.mockRestore();
  });

  it("a permanent notify 4xx fails fast without burning retries", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejecting = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
    const { db } = makeDb([{ data: null }, { data: [] }]);
    expect(await escalateToHuman(db, input(rejecting))).toBe("notify_failed");
    expect(rejecting).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a throwing notify fetch is retried, then reported as notify_failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const throwing = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const { db } = makeDb([{ data: null }, { data: [] }]);
    expect(await escalateToHuman(db, input(throwing))).toBe("notify_failed");
    expect(throwing).toHaveBeenCalledTimes(3);
    err.mockRestore();
  });

  it("no contact row: nothing to tag, but the owner is still paged", async () => {
    const fetchFn = okFetch();
    // Dedupe lookup returns null data (not an empty page) — same outcome.
    const { db, calls } = makeDb([{ data: null }, { data: null }]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    expect(calls.some((c) => c.name === "update")).toBe(false);
    const body = JSON.parse(
      String(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body)
    );
    // Label falls back to the number when there is no display name.
    expect(body.record.log_payload.contact_label).toBe(LEAD);
  });

  it("a full tag list (25) skips the tag write but still pages", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = okFetch();
    const full = Array.from({ length: 25 }, (_, i) => `t${i}`);
    const { db, calls } = makeDb([{ data: contactRow({ tags: full }) }, { data: [] }]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    expect(calls.some((c) => c.name === "update")).toBe(false);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a failed tag write after a successful page still reports escalated (page won)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = okFetch();
    const { db, calls } = makeDb([
      { data: contactRow() },
      { data: { needs_human_team_first: false } }, // team-first toggle
      { data: null, error: { message: "boom" } } // tags update fails
    ]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    // No goal/contact-event lookups after the failed write.
    expect(calls.filter((c) => c.table === "ai_flow_runs")).toHaveLength(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a recent-page lookup error degrades to paging (never blocks the alert)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = okFetch();
    const { db } = makeDb([{ data: null }, { data: null, error: { message: "boom" } }]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("goal hooks fire for every linked number (primary + aliases + texter)", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([
      { data: contactRow({ customer_e164: "+16025550000", alias_e164s: [LEAD] }) },
      { data: { needs_human_team_first: false } }, // team-first toggle
      { data: null }, // tag update
      { data: [] }, // goal lookup for +16025550000
      { data: [] }, // goal lookup for +14168775223 (texter/alias)
      { data: [] } // contact-event flows page
    ]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    const ors = calls.filter((c) => c.table === "ai_flow_runs" && c.name === "or");
    expect(ors).toHaveLength(2);
    expect(String(ors[0]?.args[0])).toContain("+16025550000");
    expect(String(ors[1]?.args[0])).toContain(LEAD);
  });

  it("a sparse contact row (null tags/name/primary/aliases) tags and pages cleanly", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([
      {
        data: contactRow({
          customer_e164: null,
          alias_e164s: null,
          display_name: null,
          tags: null
        })
      },
      { data: { needs_human_team_first: false } }, // team-first toggle
      { data: null }, // tag update
      { data: [] }, // goal lookup (texter number only)
      { data: [] } // contact-event flows page
    ]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    const update = calls.find((c) => c.name === "update");
    expect((update?.args[0] as { tags: string[] }).tags).toEqual([NEEDS_HUMAN_TAG]);
    // Only the texter's number carries a goal hook; the label falls back to it.
    expect(calls.filter((c) => c.table === "ai_flow_runs" && c.name === "or")).toHaveLength(1);
    const body = JSON.parse(
      String(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.record.log_payload.contact_label).toBe(LEAD);
  });

  it("junk tag entries (non-strings, blanks) are dropped before the append", async () => {
    const fetchFn = okFetch();
    const { db, calls } = makeDb([
      { data: contactRow({ tags: ["Engaged", 7, "  ", null] as unknown as string[] }) },
      { data: { needs_human_team_first: false } }, // team-first toggle
      { data: null },
      { data: [] },
      { data: [] }
    ]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    const update = calls.find((c) => c.name === "update");
    expect((update?.args[0] as { tags: string[] }).tags).toEqual(["Engaged", NEEDS_HUMAN_TAG]);
  });

  it("a contact-lookup error degrades to page-only (never throws)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchFn = okFetch();
    const { db } = makeDb([{ data: null, error: { message: "boom" } }, { data: [] }]);
    expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a failed notify POST reports notify_failed (global fetch when none injected)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const globalFetch = vi.fn(async () => new Response("nope", { status: 500 }));
    vi.stubGlobal("fetch", globalFetch);
    try {
      const { db, calls } = makeDb([{ data: null }, { data: [] }]);
      const { fetchFn: _omitted, ...noFetch } = input(okFetch());
      expect(await escalateToHuman(db, noFetch)).toBe("notify_failed");
      // Transient 5xx: every attempt in the budget was spent.
      expect(globalFetch).toHaveBeenCalledTimes(3);
      // Page-first ordering: a failed page must leave NO tag behind.
      expect(calls.some((c) => c.name === "update")).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      err.mockRestore();
    }
  });

  it("never throws: a client blow-up returns notify_failed", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = {
      from: () => {
        throw new Error("boom");
      }
    };
    expect(await escalateToHuman(db, input(okFetch()))).toBe("notify_failed");
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  describe("team-first handoff (businesses.needs_human_team_first)", () => {
    const toggleOn = { data: { needs_human_team_first: true } };
    const toggleOff = { data: { needs_human_team_first: false } };
    /** An enabled flow whose trigger matches the Needs Human tag event. */
    const handoffFlowRow = {
      id: "flow-1",
      definition: {
        version: 1,
        trigger: { channel: "tag_changed", tag: NEEDS_HUMAN_TAG, change: "added", conditions: [] },
        steps: []
      }
    };

    it("toggle ON + a matching flow: tag + hooks fire, a run enqueues, the owner page is SKIPPED", async () => {
      const fetchFn = okFetch();
      const { db, calls } = makeDb([
        { data: contactRow() }, // contact lookup
        toggleOn, // businesses.needs_human_team_first
        { data: null }, // tag update (ok)
        { data: [] }, // applyGoalEvent candidate runs
        { data: [handoffFlowRow] }, // enqueueContactEventRuns: enabled flows page
        { data: null } // run insert (ok)
      ]);
      const result = await escalateToHuman(db, input(fetchFn));
      expect(result).toBe("team_offered");
      // The team offer OWNS notification now — no direct owner page.
      expect(fetchFn).not.toHaveBeenCalled();
      // Tag written exactly once (the open/closed state is unchanged).
      const updates = calls.filter((c) => c.table === "contacts" && c.name === "update");
      expect(updates).toHaveLength(1);
      expect((updates[0].args[0] as { tags: string[] }).tags).toContain(NEEDS_HUMAN_TAG);
      // The enqueued run carries the customer's message as the trigger note,
      // so the broadcast offer SMS can show what they need.
      const insert = calls.find((c) => c.table === "ai_flow_runs" && c.name === "insert");
      const ctx = (insert?.args[0] as { context: { trigger: Record<string, unknown> } }).context;
      expect(String(ctx.trigger.note)).toContain("I'm tired of insurance");
      expect(String(ctx.trigger.windowText)).toContain("note:");
    });

    it("toggle ON but NO matching flow enqueued: falls through to the owner page (never silent)", async () => {
      const fetchFn = okFetch();
      const { db, calls } = makeDb([
        { data: contactRow() },
        toggleOn,
        { data: null }, // tag update (ok)
        { data: [] }, // goal-event runs
        { data: [] } // flows page: nothing enabled matches → 0 runs
      ]);
      expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      // The tag was already written in the team-first attempt — no re-write.
      expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(1);
    });

    it("toggle ON but the tag write fails: pages the owner, then RETRIES the tag (never tag-less)", async () => {
      // A transiently failed team-first tag write must not leave a paged
      // owner with an untagged contact (no open/closed dedupe, no hooks) —
      // the post-page block re-attempts it (Bugbot, PR #801).
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchFn = okFetch();
      const { db, calls } = makeDb([
        { data: contactRow() },
        toggleOn,
        { data: null, error: { message: "boom" } }, // team-first tag write fails
        { data: null }, // post-page tag retry (ok)
        { data: [] }, // goal runs
        { data: [] } // flows page
      ]);
      expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      const updates = calls.filter((c) => c.table === "contacts" && c.name === "update");
      expect(updates).toHaveLength(2);
      expect((updates[1].args[0] as { tags: string[] }).tags).toContain(NEEDS_HUMAN_TAG);
      err.mockRestore();
    });

    it("a THROWING toggle read degrades to the legacy page-first path", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchFn = okFetch();
      const inner = makeDb([
        { data: contactRow() },
        { data: null }, // tag update
        { data: [] }, // goal runs
        { data: [] } // flows page
      ]);
      // businesses.* blows up synchronously; everything else is scripted.
      const db = {
        from: (table: string) => {
          if (table === "businesses") throw new Error("boom");
          return inner.db.from(table);
        }
      };
      expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      err.mockRestore();
    });

    it("a toggle read error degrades to the legacy page-first path", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchFn = okFetch();
      const { db, calls } = makeDb([
        { data: contactRow() },
        { data: null, error: { message: "boom" } }, // toggle read fails → OFF
        { data: null }, // tag update
        { data: [] }, // goal runs
        { data: [] } // flows page
      ]);
      expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(1);
      err.mockRestore();
    });

    it("toggle OFF keeps today's page-first ordering byte-for-byte", async () => {
      const fetchFn = okFetch();
      const { db, calls } = makeDb([
        { data: contactRow() },
        toggleOff,
        { data: null }, // tag update
        { data: [] }, // goal runs
        { data: [] } // flows page
      ]);
      expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => c.table === "contacts" && c.name === "update")).toHaveLength(1);
    });

    it("toggle ON, no flow run, AND a failed page: the team-first tag is ROLLED BACK", async () => {
      // Without the rollback the contact stays tagged after a failed page,
      // every later escalation returns already_open, and the owner never
      // hears about it (Bugbot, PR #801). A failed page must leave NO state.
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const failingFetch = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
      const { db, calls } = makeDb([
        { data: contactRow() },
        toggleOn,
        { data: null }, // tag update (ok)
        { data: [] }, // goal runs
        { data: [] }, // flows page → 0 runs
        { data: null } // rollback update (ok)
      ]);
      expect(await escalateToHuman(db, input(failingFetch))).toBe("notify_failed");
      const updates = calls.filter((c) => c.table === "contacts" && c.name === "update");
      expect(updates).toHaveLength(2);
      // First write appended the tag; the rollback restored the original set.
      expect((updates[0].args[0] as { tags: string[] }).tags).toContain(NEEDS_HUMAN_TAG);
      expect((updates[1].args[0] as { tags: string[] }).tags).toEqual(["Privyr", "Engaged"]);
      err.mockRestore();
    });

    it("a failed tag rollback is logged, never thrown", async () => {
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      const failingFetch = vi.fn(async () => new Response("bad", { status: 400 })) as unknown as typeof fetch;
      const { db } = makeDb([
        { data: contactRow() },
        toggleOn,
        { data: null }, // tag update (ok)
        { data: [] }, // goal runs
        { data: [] }, // flows page → 0 runs
        { data: null, error: { message: "boom" } } // rollback fails
      ]);
      expect(await escalateToHuman(db, input(failingFetch))).toBe("notify_failed");
      err.mockRestore();
    });

    it("an untaggable contact (no row) never consults the toggle — legacy path", async () => {
      const fetchFn = okFetch();
      const { db, calls } = makeDb([
        { data: null }, // no contact row
        { data: [] } // recent-page dedupe lookup
      ]);
      expect(await escalateToHuman(db, input(fetchFn))).toBe("escalated");
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(calls.filter((c) => c.table === "businesses")).toHaveLength(0);
    });
  });

  it("clips oversized intent/reason/preview to the payload bounds", async () => {
    const fetchFn = okFetch();
    const { db } = makeDb([{ data: null }, { data: [] }]);
    await escalateToHuman(db, {
      ...input(fetchFn),
      intent: "i".repeat(200),
      reason: "r".repeat(600),
      inboundPreview: "p".repeat(600)
    });
    const body = JSON.parse(
      String(((fetchFn as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [string, RequestInit])[1].body)
    );
    expect(body.record.log_payload.intent).toHaveLength(80);
    expect(body.record.log_payload.reason).toHaveLength(300);
    expect(body.record.log_payload.inbound_preview).toHaveLength(300);
  });
});

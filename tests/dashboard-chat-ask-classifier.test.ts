import { describe, expect, it, vi } from "vitest";
import type { geminiGenerateText } from "@/lib/gemini-generate-content";
import {
  ASK_CLASSIFIER_MAX_INPUT_CHARS,
  ASK_CLASSIFIER_MODEL,
  ASK_CLASSIFIER_THINKING_LEVEL,
  classifyOwnerAsk,
  investigationDirective,
  OWNER_ASK_CLASSIFIER_PROMPT,
  parseAskClassification,
  thinkingLevelForAsk,
  toolStepsForAsk,
  UNKNOWN_ASK,
  type OwnerAskClassification
} from "@/lib/dashboard-chat/ask-classifier";

/**
 * The classifier that decides whether an owner turn has to go and read the
 * account before it answers. Its whole value is in the failure directions:
 * a wrong "preference" call reproduces the Aug 23 bug (a promise nothing
 * backs), and a broken classifier must degrade to exactly the pre-classifier
 * behavior rather than to something worse.
 *
 * The live-model half (does it call Amy's real message an automation change?)
 * is pinned in tests/e2e/owner-ask-needs-flow-change.e2e.test.ts. This file
 * pins the deterministic half.
 */

const ok = (body: unknown) => JSON.stringify(body);

/** The shape `classifyOwnerAsk` hands its injected generator. */
type GenParams = Parameters<typeof geminiGenerateText>[0];

function classification(over: Partial<OwnerAskClassification> = {}): OwnerAskClassification {
  return { kind: "automation_change", needsInvestigation: true, target: "the lead alerts", ...over };
}

describe("parseAskClassification", () => {
  it("reads a well-formed automation_change", () => {
    expect(
      parseAskClassification(
        ok({ kind: "automation_change", needs_investigation: true, target: "  the lead alerts  " })
      )
    ).toEqual({
      kind: "automation_change",
      needsInvestigation: true,
      target: "the lead alerts"
    });
  });

  it("reads the non-investigating kinds and clears their target", () => {
    for (const kind of ["preference", "action", "question"] as const) {
      expect(
        parseAskClassification(ok({ kind, needs_investigation: false, target: "ignored" }))
      ).toEqual({ kind, needsInvestigation: false, target: "" });
    }
  });

  // The two fields must agree, and the kind is the half the prompt weights.
  // A model that contradicts itself gets the useful reading, not a coin flip.
  it("recomputes needs_investigation from the kind, both directions", () => {
    expect(
      parseAskClassification(
        ok({ kind: "automation_change", needs_investigation: false, target: "alerts" })
      ).needsInvestigation
    ).toBe(true);
    expect(
      parseAskClassification(ok({ kind: "preference", needs_investigation: true, target: "x" }))
        .needsInvestigation
    ).toBe(false);
  });

  it("falls open on anything it cannot trust", () => {
    for (const raw of [
      "not json",
      "",
      "null",
      "[]",
      '"a string"',
      "42",
      ok({ needs_investigation: true }),
      ok({ kind: "" }),
      ok({ kind: 5 }),
      ok({ kind: "escalate_to_human" }),
      ok({ kind: "unknown" })
    ]) {
      expect(parseAskClassification(raw), raw).toEqual(UNKNOWN_ASK);
    }
  });

  it("tolerates a missing or non-string target on a valid kind", () => {
    expect(parseAskClassification(ok({ kind: "automation_change" })).target).toBe("");
    expect(parseAskClassification(ok({ kind: "automation_change", target: 7 })).target).toBe("");
  });
});

describe("thinkingLevelForAsk / toolStepsForAsk", () => {
  it("spends the expensive level only on an ask that needs the account read", () => {
    expect(thinkingLevelForAsk(classification())).toBe("high");
    for (const kind of ["preference", "action", "question", "unknown"] as const) {
      expect(
        thinkingLevelForAsk(classification({ kind, needsInvestigation: false })),
        kind
      ).toBe("low");
    }
  });

  it("gives an investigating turn room to list and read, and nobody else", () => {
    expect(toolStepsForAsk(classification(), 6)).toBe(10);
    expect(toolStepsForAsk(classification({ kind: "action", needsInvestigation: false }), 6)).toBe(6);
  });

  // The whole degrade contract in one assertion: an outage costs the old
  // behavior, never a worse one.
  it("UNKNOWN_ASK selects exactly the pre-classifier settings", () => {
    expect(thinkingLevelForAsk(UNKNOWN_ASK)).toBe("low");
    expect(toolStepsForAsk(UNKNOWN_ASK, 6)).toBe(6);
    expect(investigationDirective(UNKNOWN_ASK)).toBe("");
  });
});

describe("investigationDirective", () => {
  it("is empty for every kind that does not investigate", () => {
    for (const kind of ["preference", "action", "question", "unknown"] as const) {
      expect(investigationDirective(classification({ kind, needsInvestigation: false }))).toBe("");
    }
  });

  it("names the mechanism, the tools, and the honesty rule", () => {
    const d = investigationDirective(classification());
    expect(d).toContain("the lead alerts");
    expect(d).toContain("list_aiflows");
    expect(d).toContain("edit_aiflow");
    // The model's own wrong belief is what produced the promise, so the
    // directive corrects the belief, not just the behavior.
    expect(d).toContain("do NOT read the business memory");
    expect(d).toContain("Never name an automation you did not see in the list");
    expect(d).toContain("An honest miss is worth more than a promise");
  });

  it("works without a target, rather than emitting a dangling phrase", () => {
    const d = investigationDirective(classification({ target: "" }));
    expect(d).toContain("list_aiflows");
    expect(d).not.toContain("asking about: .");
    expect(d.startsWith("THIS ASK NEEDS THE ACCOUNT READ FIRST. The owner is asking you")).toBe(true);
  });

  it("carries no em dash", () => {
    expect(investigationDirective(classification())).not.toMatch(/—/);
    expect(OWNER_ASK_CLASSIFIER_PROMPT).not.toMatch(/—/);
  });
});

describe("classifyOwnerAsk", () => {
  it("sends the production call shape and returns the parsed answer", async () => {
    const generate = vi.fn(async (_p: GenParams) =>
      ok({ kind: "automation_change", needs_investigation: true, target: "lead alerts" })
    );
    const out = await classifyOwnerAsk({
      ownerMessage: "[SMS from owner] please add the price to these alerts",
      apiKey: "k",
      generate: generate as never
    });
    expect(out).toEqual({
      kind: "automation_change",
      needsInvestigation: true,
      target: "lead alerts"
    });
    const call = generate.mock.calls[0][0];
    expect(call.model).toBe(ASK_CLASSIFIER_MODEL);
    expect(call.temperature).toBe(0);
    expect(call.responseMimeType).toBe("application/json");
    expect(call.thinkingLevel).toBe(ASK_CLASSIFIER_THINKING_LEVEL);
    expect(call.systemInstruction).toBe(OWNER_ASK_CLASSIFIER_PROMPT);
    // The channel marker is stripped: it is transport, not what the owner said.
    expect(call.userText).toBe("please add the price to these alerts");
  });

  it("strips a dashboard marker too", async () => {
    const generate = vi.fn(async (_p: GenParams) =>
      ok({ kind: "question", needs_investigation: false, target: "" })
    );
    await classifyOwnerAsk({
      ownerMessage: "[Dashboard] what did we book today?",
      apiKey: "k",
      generate: generate as never
    });
    expect(generate.mock.calls[0][0].userText).toBe("what did we book today?");
  });

  it("caps a long paste so a forwarded transcript cannot blow the input", async () => {
    const generate = vi.fn(async (_p: GenParams) =>
      ok({ kind: "preference", needs_investigation: false, target: "" })
    );
    await classifyOwnerAsk({
      ownerMessage: "x".repeat(ASK_CLASSIFIER_MAX_INPUT_CHARS + 500),
      apiKey: "k",
      generate: generate as never
    });
    expect(generate.mock.calls[0][0].userText.length).toBe(ASK_CLASSIFIER_MAX_INPUT_CHARS);
  });

  it("honors a model override", async () => {
    const generate = vi.fn(async (_p: GenParams) =>
      ok({ kind: "action", needs_investigation: false, target: "" })
    );
    await classifyOwnerAsk({
      ownerMessage: "text Dave",
      apiKey: "k",
      model: "gemini-3.7-flash",
      generate: generate as never
    });
    expect(generate.mock.calls[0][0].model).toBe("gemini-3.7-flash");
  });

  it("never calls the model with nothing to classify", async () => {
    const generate = vi.fn(async (_p: GenParams) =>
      ok({ kind: "action", needs_investigation: false, target: "" })
    );
    for (const ownerMessage of ["", "   ", "[SMS from owner]   "]) {
      expect(
        await classifyOwnerAsk({ ownerMessage, apiKey: "k", generate: generate as never })
      ).toEqual(UNKNOWN_ASK);
    }
    expect(
      await classifyOwnerAsk({
        ownerMessage: undefined as never,
        apiKey: "k",
        generate: generate as never
      })
    ).toEqual(UNKNOWN_ASK);
    expect(generate).not.toHaveBeenCalled();
  });

  it("does not call the model without a key", async () => {
    const generate = vi.fn(async (_p: GenParams) =>
      ok({ kind: "action", needs_investigation: false, target: "" })
    );
    expect(
      await classifyOwnerAsk({ ownerMessage: "hi", apiKey: "", generate: generate as never })
    ).toEqual(UNKNOWN_ASK);
    expect(generate).not.toHaveBeenCalled();
  });

  // The failure contract. Every one of these used to be "the turn behaves as
  // it did before the classifier existed", and it must stay that way.
  it("falls open when the model throws, and when it answers junk", async () => {
    const thrower = vi.fn(async () => {
      throw new Error("gemini_http_503");
    });
    expect(
      await classifyOwnerAsk({ ownerMessage: "hi", apiKey: "k", generate: thrower as never })
    ).toEqual(UNKNOWN_ASK);

    const junk = vi.fn(async () => "<html>proxy error</html>");
    expect(
      await classifyOwnerAsk({ ownerMessage: "hi", apiKey: "k", generate: junk as never })
    ).toEqual(UNKNOWN_ASK);
  });

  it("passes an abort signal and clears its timer on the happy path", async () => {
    const generate = vi.fn(async (p: { signal?: AbortSignal }) => {
      expect(p.signal).toBeInstanceOf(AbortSignal);
      expect(p.signal?.aborted).toBe(false);
      return ok({ kind: "question", needs_investigation: false, target: "" });
    });
    const out = await classifyOwnerAsk({
      ownerMessage: "hi",
      apiKey: "k",
      generate: generate as never
    });
    expect(out.kind).toBe("question");
  });

  it("aborts a classifier that outruns its budget, and still answers", async () => {
    vi.useFakeTimers();
    try {
      const generate = vi.fn(
        (p: { signal?: AbortSignal }) =>
          new Promise<string>((_resolve, reject) => {
            p.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          })
      );
      const pending = classifyOwnerAsk({
        ownerMessage: "hi",
        apiKey: "k",
        timeoutMs: 50,
        generate: generate as never
      });
      await vi.advanceTimersByTimeAsync(60);
      expect(await pending).toEqual(UNKNOWN_ASK);
    } finally {
      vi.useRealTimers();
    }
  });
});

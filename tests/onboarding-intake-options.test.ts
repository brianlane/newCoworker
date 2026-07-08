import { describe, expect, it } from "vitest";
import {
  CRM_OPTIONS,
  CRM_OTHER_PREFIX,
  CRM_OTHER_SENTINEL,
  CRM_OTHER_VALUE,
  TEAM_SIZE_OPTIONS,
  deriveCrmSelection,
  isCrmSelectionComplete,
  serializeCrmSelection,
  teamSizeBucketToInt
} from "@/lib/onboarding/intakeOptions";

describe("intakeOptions: TEAM_SIZE_OPTIONS", () => {
  it("exposes a closed-class team-size enum that downstream identity.md can render verbatim", () => {
    // Identity.md uses `knownContext.teamSize` directly as a string;
    // the values must be human-readable, stable, and mutually
    // exclusive. Pin the full enum to make any future drift
    // explicit.
    expect(TEAM_SIZE_OPTIONS.map((option) => option.value)).toEqual([
      "Just me",
      "2-3",
      "4-5",
      "6-10",
      "11-25",
      "25+"
    ]);
  });

  it("uses en-dash labels even though the values use ASCII hyphens (label vs value separation)", () => {
    // Labels contain en-dashes ("2–3") for visual polish, but the
    // values use ASCII hyphens ("2-3") so that `identity.md` and any
    // downstream string comparisons stay ASCII-safe. Asserting the
    // distinction prevents accidental unification that would break
    // either rendering or persisted data round-tripping.
    const range = TEAM_SIZE_OPTIONS.find((option) => option.value === "2-3");
    expect(range).toBeDefined();
    expect(range?.label).toBe("2–3");
  });
});

describe("intakeOptions: CRM_OPTIONS", () => {
  it("starts with the explicit None-CRM entry so single-operator users have a positive answer", () => {
    // Pre-migration the chat had to scan transcripts for "I just use
    // texts/email" and treat that as a CRM-known signal. Now the
    // dropdown carries an explicit value the user can pick — there
    // is no ambiguity between "user skipped" and "user said no
    // CRM".
    expect(CRM_OPTIONS[0]?.value).toBe("None — texts, email, or calendar only");
    // Label diverges from the value on purpose: the value is a persisted
    // sentinel, while the visible label follows the no-em-dash copy rule.
    expect(CRM_OPTIONS[0]?.label).toBe("None: texts, email, or calendar only");
  });

  it("ends with an Other escape hatch so the dropdown isn't an exhaustive enumeration", () => {
    expect(CRM_OPTIONS[CRM_OPTIONS.length - 1]?.value).toBe(CRM_OTHER_VALUE);
  });

  it("offers Privyr so lead-response CRM users don't fall into Other", () => {
    // Privyr tenants have a first-class Meta-leads path (lead forwarding to
    // the AI mailbox), so knowing they use it matters at onboarding time.
    expect(CRM_OPTIONS.some((o) => o.value === "Privyr")).toBe(true);
  });
});

describe("intakeOptions: deriveCrmSelection / serializeCrmSelection round-trip", () => {
  it("treats unset CRM as { selection: '', otherText: '' }", () => {
    expect(deriveCrmSelection("")).toEqual({ selection: "", otherText: "" });
    expect(deriveCrmSelection(undefined)).toEqual({ selection: "", otherText: "" });
    expect(deriveCrmSelection(null)).toEqual({ selection: "", otherText: "" });
  });

  it("maps a known label directly to its dropdown selection (case-insensitive)", () => {
    expect(deriveCrmSelection("HubSpot")).toEqual({ selection: "HubSpot", otherText: "" });
    expect(deriveCrmSelection("hubspot")).toEqual({ selection: "HubSpot", otherText: "" });
    expect(deriveCrmSelection("Follow Up Boss")).toEqual({
      selection: "Follow Up Boss",
      otherText: ""
    });
  });

  it("decomposes the Other-prefix into selection + free-text", () => {
    expect(deriveCrmSelection("Other: Wise Agent")).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: "Wise Agent"
    });
  });

  it("buckets unknown free-text values as Other so legacy localStorage drafts don't lose their answer", () => {
    // Pre-migration users had a free-text CRM field. When their
    // draft rehydrates against the new dropdown, the value should
    // surface in the Other-text field rather than disappear or
    // silently match an unintended option.
    expect(deriveCrmSelection("My Custom Vertical CRM")).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: "My Custom Vertical CRM"
    });
  });

  it("trims surrounding whitespace on both halves of the Other prefix", () => {
    expect(deriveCrmSelection("  Other:   Wise Agent   ")).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: "Wise Agent"
    });
  });

  it("serializes a known selection back to its label verbatim", () => {
    expect(serializeCrmSelection("HubSpot", "")).toBe("HubSpot");
    expect(serializeCrmSelection("None — texts, email, or calendar only", "")).toBe(
      "None — texts, email, or calendar only"
    );
  });

  it("serializes Other + non-empty text with the canonical prefix", () => {
    expect(serializeCrmSelection(CRM_OTHER_VALUE, "Wise Agent")).toBe(
      `${CRM_OTHER_PREFIX}Wise Agent`
    );
  });

  it("serializes Other-with-empty-text to the sentinel so the dropdown can re-render in Other state", () => {
    // Regression: previously this serialized to `""`, which made the
    // dropdown round-trip back to its placeholder on the next render
    // and hid the "Which CRM?" text input. Picking Other became
    // a UX dead-end — users couldn't fill out or advance Step 1.
    // The sentinel preserves the in-flight selection across renders
    // while still being recognized as incomplete by
    // `isCrmSelectionComplete`.
    expect(serializeCrmSelection(CRM_OTHER_VALUE, "")).toBe(CRM_OTHER_SENTINEL);
    expect(serializeCrmSelection(CRM_OTHER_VALUE, "   ")).toBe(CRM_OTHER_SENTINEL);
  });

  it("rehydrates the Other-empty sentinel back to { selection: 'Other', otherText: '' }", () => {
    expect(deriveCrmSelection(CRM_OTHER_SENTINEL)).toEqual({
      selection: CRM_OTHER_VALUE,
      otherText: ""
    });
  });

  it("serializes empty selection as ''", () => {
    expect(serializeCrmSelection("", "")).toBe("");
    expect(serializeCrmSelection("", "stray text")).toBe("");
  });

  it("round-trips every supported (selection, text) pair without lossy mutation", () => {
    const cases: { selection: string; otherText: string; expectedStored: string }[] = [
      ...CRM_OPTIONS.filter((option) => option.value !== CRM_OTHER_VALUE).map((option) => ({
        selection: option.value,
        otherText: "",
        expectedStored: option.value
      })),
      // In-flight Other-with-empty-text uses the sentinel
      { selection: CRM_OTHER_VALUE, otherText: "", expectedStored: CRM_OTHER_SENTINEL },
      { selection: CRM_OTHER_VALUE, otherText: "Wise Agent", expectedStored: "Other: Wise Agent" }
    ];
    for (const { selection, otherText, expectedStored } of cases) {
      const stored = serializeCrmSelection(selection, otherText);
      expect(stored).toBe(expectedStored);
      expect(deriveCrmSelection(stored)).toEqual({ selection, otherText });
    }
  });
});

describe("intakeOptions: isCrmSelectionComplete", () => {
  it("rejects empty / nullish / sentinel values as incomplete", () => {
    // These are exactly the states the Step 1 advance gate must
    // block. The sentinel is truthy as a string but represents
    // "Other selected, no text typed" — letting it through would
    // submit `body.crmUsed = "Other:"` to the server.
    expect(isCrmSelectionComplete("")).toBe(false);
    expect(isCrmSelectionComplete("   ")).toBe(false);
    expect(isCrmSelectionComplete(undefined)).toBe(false);
    expect(isCrmSelectionComplete(null)).toBe(false);
    expect(isCrmSelectionComplete(CRM_OTHER_SENTINEL)).toBe(false);
  });

  it("rejects the bare CRM_OTHER_VALUE ('Other') as incomplete (legacy localStorage / non-serialized path)", () => {
    // Regression: `serializeCrmSelection` never writes the bare
    // string `"Other"` (it always produces either the sentinel
    // `"Other:"` for empty text or the prefixed `"Other: <name>"`
    // for non-empty text), but a legacy localStorage draft or a
    // direct API caller could land that value in storage by
    // pulling `CRM_OPTIONS`' Other entry's `value` directly.
    // `deriveCrmSelection("Other")` matches the option entry and
    // renders the dropdown in Other state with an empty "Which
    // CRM?" text input — so for UX consistency the advance gate
    // MUST also flag this as incomplete. Otherwise the user can
    // bypass the text input entirely and submit `crmUsed: "Other"`
    // as if it were a real answer.
    expect(isCrmSelectionComplete(CRM_OTHER_VALUE)).toBe(false);
    expect(isCrmSelectionComplete("  Other  ")).toBe(false);
  });

  it("agrees with deriveCrmSelection on every Other-state representation (no UI/gate disagreement)", () => {
    // Whenever `deriveCrmSelection(stored).selection === "Other"`
    // and `otherText === ""`, the UI shows an empty "Which CRM?"
    // text input — regardless of whether `stored` is the sentinel,
    // the bare "Other", or some legacy unknown free-text value
    // that happens to round-trip into Other. In all of those
    // cases `isCrmSelectionComplete` MUST return false; otherwise
    // the user reads "Which CRM?" and can advance without typing.
    // Pinning this invariant prevents future drift between the
    // two helpers.
    const otherEmptyStates = ["Other", "Other:", "  Other:  ", "Other: ", "Other:    "];
    for (const stored of otherEmptyStates) {
      const { selection, otherText } = deriveCrmSelection(stored);
      expect(selection, `for "${stored}"`).toBe(CRM_OTHER_VALUE);
      expect(otherText, `for "${stored}"`).toBe("");
      expect(isCrmSelectionComplete(stored), `for "${stored}"`).toBe(false);
    }
  });

  it("accepts known dropdown values, including the explicit None entry", () => {
    expect(isCrmSelectionComplete("HubSpot")).toBe(true);
    expect(isCrmSelectionComplete("None — texts, email, or calendar only")).toBe(true);
  });

  it("accepts Other only when the prefix has non-empty trailing text", () => {
    expect(isCrmSelectionComplete("Other: Wise Agent")).toBe(true);
    // Prefix with whitespace-only payload is still an in-flight
    // state — the user hasn't actually named a CRM yet.
    expect(isCrmSelectionComplete("Other:    ")).toBe(false);
  });

  it("accepts legacy free-text values (anything that's not the prefix or sentinel)", () => {
    expect(isCrmSelectionComplete("My Custom Vertical CRM")).toBe(true);
  });
});

describe("intakeOptions: teamSizeBucketToInt", () => {
  it("maps every Step 1 dropdown bucket to the LOWER bound of its range", () => {
    // The DB column is `int`. Picking the lower bound preserves
    // the semantic that `team_size >= N` queries don't over-count
    // operators (e.g. a 4-5 team should NOT satisfy `team_size >= 5`).
    expect(teamSizeBucketToInt("Just me")).toBe(1);
    expect(teamSizeBucketToInt("2-3")).toBe(2);
    expect(teamSizeBucketToInt("4-5")).toBe(4);
    expect(teamSizeBucketToInt("6-10")).toBe(6);
    expect(teamSizeBucketToInt("11-25")).toBe(11);
    expect(teamSizeBucketToInt("25+")).toBe(25);
  });

  it("trims surrounding whitespace before matching buckets", () => {
    expect(teamSizeBucketToInt("  Just me ")).toBe(1);
    expect(teamSizeBucketToInt("\t4-5\n")).toBe(4);
  });

  it("falls back to a guarded parseInt for legacy localStorage drafts that pre-date the dropdown", () => {
    // Pre-migration the field was free-text. Bare numbers and
    // numbers-with-trailing-noise should still parse rather than
    // crash, so old drafts survive the migration.
    expect(teamSizeBucketToInt("5")).toBe(5);
    expect(teamSizeBucketToInt("12 agents")).toBe(12);
  });

  it("defaults to 1 (solo) for unparseable input rather than NaN", () => {
    // Critical: `parseInt("Just me")` was the original bug — `NaN`
    // hits the DB integer column and breaks create/checkout. Solo
    // is the safest default because it's the most common small-team
    // case AND any over/under-count is recoverable from the chat
    // transcript or follow-up profile edits.
    expect(teamSizeBucketToInt("nonsense")).toBe(1);
    expect(teamSizeBucketToInt("0")).toBe(1);
    expect(teamSizeBucketToInt("-5")).toBe(1);
    expect(teamSizeBucketToInt("")).toBe(1);
    expect(teamSizeBucketToInt(undefined)).toBe(1);
    expect(teamSizeBucketToInt(null)).toBe(1);
  });
});

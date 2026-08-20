import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  CONFIRM_LABEL_RE,
  DEMO_ACTION_CAP_MESSAGE,
  DEMO_GONE_MESSAGE,
  DEMO_LIVE_WARNING,
  DEMO_REMOVE_WARNING,
  DEMO_RESOLVE_FAILURE_REASONS,
  describeDemoResolveFailure,
  isConfirmLabel,
  MAX_DEMO_ACTIONS,
  toEditorActions,
  type DemoResolveFailureReason
} from "@/lib/ai-flows/demo-session-view";
import { MAX_CHECKABLE_ACTIONS } from "@/lib/ai-flows/action-check-view";
import { MAX_ACTIONS } from "../vps/aiflow-render/actions.mjs";

describe("the confirm-label vocabulary", () => {
  it("is the sidecar's CONFIRM_LABEL_RE verbatim (which is the probe's DESTRUCTIVE_TARGETS)", () => {
    // Three copies exist on purpose (this client-safe module cannot import
    // the .mjs, and the .mjs cannot import app TypeScript), so the sources
    // are pinned to each other. The sidecar test pins .mjs against the probe;
    // this pins the client copy against the .mjs.
    const demoSource = readFileSync(
      new URL("../vps/aiflow-render/demo.mjs", import.meta.url),
      "utf8"
    );
    const m = /export const CONFIRM_LABEL_RE =\s*\n?\s*(\/[^/]+\/i)/.exec(demoSource);
    expect(m, "demo.mjs no longer defines CONFIRM_LABEL_RE?").toBeTruthy();
    expect(CONFIRM_LABEL_RE.toString()).toBe(m![1]);
  });

  it("flags labels that commit and passes ones that merely navigate", () => {
    expect(isConfirmLabel("Submit Update")).toBe(true);
    expect(isConfirmLabel("Accept referral")).toBe(true);
    expect(isConfirmLabel("Provide Update")).toBe(false);
    expect(isConfirmLabel("Offers")).toBe(false);
  });
});

describe("MAX_DEMO_ACTIONS", () => {
  it("mirrors both the dry run's cap and the engine's MAX_ACTIONS", () => {
    expect(MAX_DEMO_ACTIONS).toBe(MAX_CHECKABLE_ACTIONS);
    expect(MAX_DEMO_ACTIONS).toBe(MAX_ACTIONS);
  });
});

describe("toEditorActions", () => {
  it("moves the recorded literal into valueTemplate and drops empty values", () => {
    expect(
      toEditorActions([
        { kind: "click_text", target: "Offers" },
        { kind: "fill_selector", target: 'textarea[name="message"]', value: "Called, no answer" },
        { kind: "select_option", target: 'select[name="hour"]', value: "9" },
        { kind: "click_selector", target: "#next", value: "" }
      ])
    ).toEqual([
      { kind: "click_text", target: "Offers" },
      {
        kind: "fill_selector",
        target: 'textarea[name="message"]',
        valueTemplate: "Called, no answer"
      },
      { kind: "select_option", target: 'select[name="hour"]', valueTemplate: "9" },
      { kind: "click_selector", target: "#next" }
    ]);
  });
});

describe("describeDemoResolveFailure", () => {
  it("gives every reason distinct wording that says what to do next", () => {
    const lines = [...DEMO_RESOLVE_FAILURE_REASONS].map((reason) =>
      describeDemoResolveFailure(reason as DemoResolveFailureReason)
    );
    for (const line of lines) expect(line.length).toBeGreaterThan(20);
    expect(new Set(lines).size).toBe(lines.length);
  });

  it("lists a dropdown's real choices when it has them", () => {
    expect(describeDemoResolveFailure("select_needs_option", ["9", "10"])).toContain("9, 10");
    expect(describeDemoResolveFailure("select_needs_option")).toContain("dropdown");
    expect(describeDemoResolveFailure("select_needs_option", [])).toContain("list below");
  });

  it("routes ambiguity and unstable controls to the list, not to retrying the click", () => {
    expect(describeDemoResolveFailure("ambiguous")).toContain("Pick it from the list");
    expect(describeDemoResolveFailure("no_stable_selector")).toContain("list below");
  });
});

describe("the honesty copy", () => {
  it("keeps the live warning and the removal truth explicit", () => {
    // These lines are load-bearing product copy: a demonstration is REAL, and
    // recording-undo does not undo the site. Pinned so a wording cleanup
    // cannot soften them into ambiguity.
    expect(DEMO_LIVE_WARNING).toContain("really happens");
    expect(DEMO_REMOVE_WARNING).toContain("stays done");
    expect(DEMO_GONE_MESSAGE).toContain("recorded steps are kept");
    expect(DEMO_ACTION_CAP_MESSAGE).toContain(String(MAX_DEMO_ACTIONS));
  });
});

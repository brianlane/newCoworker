import { describe, expect, it } from "vitest";
import { replaceSchedulingRule } from "../scripts/oneshot/disable-amy-voice-booking";

// The live memory_md shape as of Aug 3 2026, trimmed to the relevant sections.
const LIVE_MEMORY = `# memory.md
Business: Amy Laidlaw Real Estate

## Facts To Remember
- Service area is the entire Phoenix metro area.
- Team size is 4-5.

## Scheduling Rules
- Use the team calendar to schedule consultations/showings by default.

## Inquiry Playbooks
- Cause: Visitor submits a form or calls/texts about listing a home
`;

describe("replaceSchedulingRule", () => {
  it("replaces the booking rule that told voice to use the team calendar", () => {
    const { next, status } = replaceSchedulingRule(LIVE_MEMORY);
    expect(status).toBe("replaced");
    expect(next).not.toContain("Use the team calendar to schedule");
    expect(next).toContain("Do not book appointments directly.");
    expect(next).toContain("notify_team");
  });

  it("leaves every other section untouched", () => {
    const { next } = replaceSchedulingRule(LIVE_MEMORY);
    expect(next).toContain("## Scheduling Rules");
    expect(next).toContain("## Inquiry Playbooks");
    expect(next).toContain("- Service area is the entire Phoenix metro area.");
    expect(next.split("\n").length).toBe(LIVE_MEMORY.split("\n").length);
  });

  it("is idempotent: a second run reports already_applied and changes nothing", () => {
    const first = replaceSchedulingRule(LIVE_MEMORY);
    const second = replaceSchedulingRule(first.next);
    expect(second.status).toBe("already_applied");
    expect(second.next).toBe(first.next);
  });

  it("tolerates leading and trailing whitespace on the old line", () => {
    const spaced = LIVE_MEMORY.replace(
      "- Use the team calendar to schedule consultations/showings by default.",
      "-  Use the team calendar to schedule consultations/showings by default.   "
    );
    expect(replaceSchedulingRule(spaced).status).toBe("replaced");
  });

  // A hand-edited config must not silently report success; the script warns.
  it("reports not_found when neither the old nor the new line is present", () => {
    const { next, status } = replaceSchedulingRule("# memory.md\n\n## Scheduling Rules\n- Something else.\n");
    expect(status).toBe("not_found");
    expect(next).toBe("# memory.md\n\n## Scheduling Rules\n- Something else.\n");
  });

  it("reports not_found on an empty document rather than throwing", () => {
    expect(replaceSchedulingRule("").status).toBe("not_found");
  });

  it("only replaces the scheduling bullet, not a similar sentence elsewhere", () => {
    const withProse = LIVE_MEMORY.replace(
      "## Inquiry Playbooks",
      "## Notes\nThe team calendar is shared with the front desk.\n\n## Inquiry Playbooks"
    );
    const { next } = replaceSchedulingRule(withProse);
    expect(next).toContain("The team calendar is shared with the front desk.");
  });
});

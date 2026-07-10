import { describe, expect, it } from "vitest";
import { buildWhiteGloveIntakeEmail } from "@/lib/email/templates/white-glove-intake";

const BASE = {
  intakeUrl: "https://www.newcoworker.com/intake/tok-abc",
  recipientEmail: "prospect@example.com",
  siteUrl: "https://www.newcoworker.com/"
};

describe("buildWhiteGloveIntakeEmail", () => {
  it("carries the questionnaire link and sets expectations (short, multiple choice)", () => {
    const { subject, text, html } = buildWhiteGloveIntakeEmail(BASE);
    expect(subject).toBe("Your NewCoworker white-glove setup questionnaire");
    expect(text).toContain(BASE.intakeUrl);
    expect(text).toContain("multiple choice");
    expect(text).toContain("5 minutes");
    expect(html).toContain(BASE.intakeUrl);
    expect(html).toContain("Start the questionnaire");
  });
});

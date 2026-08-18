/**
 * The call history LIST has to say "Voicemail" the same way the transcript
 * detail page does.
 *
 * Before this, the answering-machine verdict lived only on the detail page:
 * an outbound call a voicemail picked up looked exactly like one a person
 * answered until you opened it, so an owner scanning the list could not tell
 * which of their assistant's calls actually reached anybody. The Forwarded
 * pill was already carried into the list for the same reason, and these
 * assertions keep the two surfaces from drifting apart again.
 *
 * Source-level assertions, matching blog-post-cta.test.ts: the list is a
 * client component fed by an async server component, so its wiring is cheaper
 * to verify by reading it than by standing up a render harness.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..");
const LIST = readFileSync(join(ROOT, "src/components/dashboard/CallsList.tsx"), "utf8");
const PAGE = readFileSync(join(ROOT, "src/app/dashboard/calls/page.tsx"), "utf8");
const DETAIL = readFileSync(
  join(ROOT, "src/app/dashboard/calls/[callControlId]/page.tsx"),
  "utf8"
);
const ANALYTICS_CARDS = readFileSync(
  join(ROOT, "src/components/dashboard/AnalyticsCards.tsx"),
  "utf8"
);
const ANALYTICS_LIB = readFileSync(
  join(ROOT, "src/lib/analytics/dashboard-analytics.ts"),
  "utf8"
);

describe("call history list voicemail badge", () => {
  it("renders the same AnsweringMachineBadge the detail page renders", () => {
    expect(DETAIL).toContain("<AnsweringMachineBadge");
    expect(LIST).toMatch(/AnsweringMachineBadge[\s\S]*from "@\/components\/dashboard\/voice-transcript-helpers"/);
    expect(LIST).toContain("<AnsweringMachineBadge");
  });

  it("passes both AMD inputs, so a message left reads differently from a machine reached", () => {
    // voicemailLeft is what splits "Voicemail" from "No answer, machine"
    // (see answeringMachineBadgeLabel). Dropping it would silently label
    // every machine answer as the milder "No answer, machine".
    const badge = LIST.slice(LIST.indexOf("<AnsweringMachineBadge"));
    expect(badge).toMatch(/result=\{row\.answeringMachineResult\}/);
    expect(badge).toMatch(/voicemailLeft=\{row\.voicemailLeft\}/);
  });

  it("feeds the badge from the transcript row, not a default", () => {
    // A row shape the page never populates renders nothing at all, which is
    // indistinguishable from "this call reached a human".
    expect(PAGE).toContain("answeringMachineResult: row.answering_machine_result ?? null");
    expect(PAGE).toContain("voicemailLeft: row.voicemail_left === true");
  });

  it("keeps the pill in the badge row beside Forwarded and the status", () => {
    const forwarded = LIST.indexOf("<ForwardedBadge />");
    const status = LIST.indexOf("<StatusBadge status={row.status} />");
    const amd = LIST.indexOf("<AnsweringMachineBadge");
    expect(forwarded).toBeGreaterThan(-1);
    expect(status).toBeGreaterThan(forwarded);
    expect(amd).toBeGreaterThan(status);
    // Same wrapping badge row, not stranded in the timestamp line below it.
    const timestamps = LIST.indexOf("<LocalDateTime iso={row.startedAt} />");
    expect(amd).toBeLessThan(timestamps);
  });
});

/**
 * The Analytics drill-down lists (day / sentiment / peak-hour) render calls
 * through the same CallRowsList, and they had the same blind spot: a call a
 * voicemail picked up was indistinguishable from one a person answered.
 *
 * The projection assertion is the load-bearing one. The badge can be wired
 * perfectly and still never render if `answering_machine_result` is missing
 * from the column list the analytics query selects, and a badge that never
 * appears is not a failure anyone notices.
 */
describe("analytics drill-down voicemail badge", () => {
  it("renders the shared badge in the drill-down call rows", () => {
    expect(ANALYTICS_CARDS).toMatch(
      /AnsweringMachineBadge[\s\S]*from "@\/components\/dashboard\/voice-transcript-helpers"/
    );
    const badge = ANALYTICS_CARDS.slice(ANALYTICS_CARDS.indexOf("<AnsweringMachineBadge"));
    expect(badge).toMatch(/result=\{row\.answeringMachineResult\}/);
    expect(badge).toMatch(/voicemailLeft=\{row\.voicemailLeft\}/);
  });

  it("selects both AMD columns, or the badge could never render", () => {
    const columns = ANALYTICS_LIB.slice(
      ANALYTICS_LIB.indexOf("const DETAIL_CALL_COLUMNS"),
      ANALYTICS_LIB.indexOf("type DetailCallRow")
    );
    expect(columns).toContain('"answering_machine_result"');
    expect(columns).toContain('"voicemail_left"');
  });

  it("drops an unrecognized verdict instead of passing it to the badge", () => {
    expect(ANALYTICS_LIB).toContain("AMD_RESULT_KEYS");
    expect(ANALYTICS_LIB).toMatch(/voicemailLeft: row\.voicemail_left === true/);
  });
});

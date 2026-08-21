import { describe, expect, it } from "vitest";

import {
  boardsFromStageRows,
  isClosedCustomer,
  selectCampaignAudience,
  type AudienceContact
} from "@/lib/campaigns/filter";

/**
 * The audience rules, shared by the composer's preview and the sweep's
 * snapshot. The point of the module is that those two agree, so these tests
 * are about the rules themselves; campaigns-audience and campaigns-send
 * cover each caller wiring them up.
 */

const BOARD = boardsFromStageRows([
  { id: "s0", pipeline_id: "p1", name: "New Lead", position: 0 },
  { id: "s1", pipeline_id: "p1", name: "Contacted", position: 1 },
  { id: "s2", pipeline_id: "p1", name: "Engaged", position: 2 },
  { id: "s3", pipeline_id: "p1", name: "Won", position: 4 },
  { id: "s4", pipeline_id: "p1", name: "Onboarded", position: 5 }
]);

const contact = (over: Partial<AudienceContact> = {}): AudienceContact => ({
  id: "c1",
  email: "a@x.test",
  tags: [],
  ...over
});

const rules = (over: Record<string, unknown> = {}) => ({
  audienceTag: "",
  excludeTag: "",
  includeClosed: false,
  boards: BOARD,
  ...over
});

describe("isClosedCustomer", () => {
  it("counts the won stage and everything after it", () => {
    // "Do not mail my existing customers" means Onboarded and Active too,
    // not just the moment the deal closed.
    expect(isClosedCustomer(BOARD, ["Won"])).toBe(true);
    expect(isClosedCustomer(BOARD, ["Onboarded"])).toBe(true);
  });

  it("leaves everyone before it alone", () => {
    expect(isClosedCustomer(BOARD, ["Engaged"])).toBe(false);
    expect(isClosedCustomer(BOARD, ["New Lead"])).toBe(false);
    expect(isClosedCustomer(BOARD, ["VIP"])).toBe(false);
    expect(isClosedCustomer(BOARD, [])).toBe(false);
    expect(isClosedCustomer(BOARD, null)).toBe(false);
  });

  it("matches the stage name case-insensitively", () => {
    // Contact tags keep the owner's casing; stage names are their own row.
    expect(isClosedCustomer(BOARD, ["won"])).toBe(true);
  });

  it("says no when the board has no won column", () => {
    // The platform writes no won stage there either, so there is no closed
    // state to detect and guessing would exclude people silently.
    const other = boardsFromStageRows([
      { id: "a", pipeline_id: "p9", name: "Working", position: 0 }
    ]);
    expect(isClosedCustomer(other, ["Working"])).toBe(false);
  });

  it("says no when there is no board at all", () => {
    expect(isClosedCustomer([], ["Won"])).toBe(false);
  });

  it("is true when ANY board says so", () => {
    const two = [
      ...boardsFromStageRows([{ id: "a", pipeline_id: "p9", name: "Working", position: 0 }]),
      ...BOARD
    ];
    expect(isClosedCustomer(two, ["Won"])).toBe(true);
  });
});

describe("selectCampaignAudience: the addition", () => {
  it("takes everyone when no tag is asked for", () => {
    const out = selectCampaignAudience(
      [contact({ id: "a" }), contact({ id: "b", email: "b@x.test", tags: ["VIP"] })],
      rules()
    );
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("matches the audience tag case-insensitively", () => {
    const out = selectCampaignAudience(
      [
        contact({ id: "a", tags: ["VIP"] }),
        contact({ id: "b", email: "b@x.test", tags: ["other"] })
      ],
      rules({ audienceTag: "vip" })
    );
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("selectCampaignAudience: the subtractions", () => {
  it("drops a contact carrying the excluded tag", () => {
    const out = selectCampaignAudience(
      [
        contact({ id: "a", tags: ["VIP"] }),
        contact({ id: "b", email: "b@x.test", tags: ["VIP", "Onboarding"] })
      ],
      rules({ audienceTag: "vip", excludeTag: "onboarding" })
    );
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("lets the exclusion beat the audience tag when a contact has both", () => {
    // Subtraction runs after addition, so "everyone tagged VIP except the
    // ones I am onboarding" is expressible.
    const out = selectCampaignAudience(
      [contact({ id: "a", tags: ["VIP", "Onboarding"] })],
      rules({ audienceTag: "vip", excludeTag: "onboarding" })
    );
    expect(out).toEqual([]);
  });

  it("leaves closed customers out by default", () => {
    const out = selectCampaignAudience(
      [
        contact({ id: "a", tags: ["Engaged"] }),
        contact({ id: "b", email: "b@x.test", tags: ["Won"] })
      ],
      rules()
    );
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("includes them when the owner ticks the box", () => {
    // Which is what an onboarding or upsell campaign wants.
    const out = selectCampaignAudience(
      [
        contact({ id: "a", tags: ["Engaged"] }),
        contact({ id: "b", email: "b@x.test", tags: ["Won"] })
      ],
      rules({ includeClosed: true })
    );
    expect(out.map((c) => c.id)).toEqual(["a", "b"]);
  });

  it("still excludes closed customers from a TAGGED send", () => {
    // The checkbox means what it says on every send, not only on a
    // broadcast. Targeting a tag that only closed customers carry shows a
    // recipient count of zero in the composer, which is the prompt to tick
    // the box rather than a silent surprise.
    const out = selectCampaignAudience(
      [contact({ id: "a", tags: ["VIP", "Won"] })],
      rules({ audienceTag: "vip" })
    );
    expect(out).toEqual([]);
    expect(
      selectCampaignAudience(
        [contact({ id: "a", tags: ["VIP", "Won"] })],
        rules({ audienceTag: "vip", includeClosed: true })
      ).map((c) => c.id)
    ).toEqual(["a"]);
  });

  it("cannot exclude anyone as closed without a board", () => {
    const out = selectCampaignAudience(
      [contact({ id: "a", tags: ["Won"] })],
      rules({ boards: [] })
    );
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("handles a contact with no tags at all against a tagged send", () => {
    const out = selectCampaignAudience(
      [contact({ id: "a", tags: null }), contact({ id: "b", email: "b@x.test", tags: ["VIP"] })],
      rules({ audienceTag: "vip" })
    );
    expect(out.map((c) => c.id)).toEqual(["b"]);
  });

  it("ignores a blank exclude tag rather than matching empty tags", () => {
    const out = selectCampaignAudience([contact({ id: "a", tags: ["", "  "] })], rules());
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });
});

describe("selectCampaignAudience: de-duping", () => {
  it("gives two rows sharing an address ONE mail", () => {
    const out = selectCampaignAudience(
      [
        contact({ id: "a", email: "same@x.test" }),
        contact({ id: "b", email: "SAME@x.test" })
      ],
      rules()
    );
    expect(out.map((c) => c.id)).toEqual(["a"]);
  });

  it("de-dupes AFTER the rules, so an excluded row cannot claim the address", () => {
    // If the excluded duplicate won the de-dupe, its survivor would be
    // dropped too and a legitimate recipient would silently vanish.
    const out = selectCampaignAudience(
      [
        contact({ id: "excluded", email: "same@x.test", tags: ["Onboarding"] }),
        contact({ id: "keep", email: "same@x.test", tags: ["VIP"] })
      ],
      rules({ excludeTag: "onboarding" })
    );
    expect(out.map((c) => c.id)).toEqual(["keep"]);
  });
});

describe("boardsFromStageRows", () => {
  it("groups the flat read into one entry per board", () => {
    const boards = boardsFromStageRows([
      { id: "a", pipeline_id: "p1", name: "New Lead", position: 0 },
      { id: "b", pipeline_id: "p2", name: "Intake", position: 0 },
      { id: "c", pipeline_id: "p1", name: "Won", position: 1 }
    ]);
    expect(boards).toHaveLength(2);
    expect(boards[0].map((s) => s.name)).toEqual(["New Lead", "Won"]);
  });

  it("answers nothing for no rows", () => {
    expect(boardsFromStageRows([])).toEqual([]);
  });
});

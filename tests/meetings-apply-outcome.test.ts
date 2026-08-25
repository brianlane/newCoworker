import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `after()` runs the callback inline here and keeps its promise, so a test
 * can await the deferred pass instead of racing it: the real applier awaits
 * the ledger read before it classifies anything, so nothing it does has
 * happened yet when scheduleMeetingClassification returns.
 */
let deferred: Promise<unknown> | null = null;
const after = vi.fn((fn: () => unknown) => {
  deferred = Promise.resolve(fn());
  return undefined;
});
vi.mock("next/server", () => ({ after: (fn: () => unknown) => after(fn) }));

import {
  applyMeetingClassification,
  matchRosterMember,
  MEETING_NOTE_AUTHOR_LABEL,
  scheduleMeetingClassification
} from "@/lib/meetings/apply-outcome";

/**
 * The writes. Two things are load-bearing throughout: every sink is
 * INDEPENDENTLY guarded (a failed to-do must not cost the note), and nothing
 * here may throw, because the import that discovered this meeting already
 * succeeded and the document is the valuable part.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const CONTACT_ID = "c-kingsley";
const CONTACT_KEY = "+17807076365";
const MEETING_UUID = "WRkTlvIESr+N4HTcIESuww==";

const input = {
  businessId: BIZ,
  documentId: "doc-1",
  documentTitle: "Kingsley Moyo + New Coworker: Discovery Call",
  minutes: "Kingsley agreed to sign up.",
  summary: "Two clinics, two accounts.",
  vtt: "WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nKingsley Moyo: Yes.\n",
  meetingUuid: MEETING_UUID,
  zoomMeetingId: "89815540862",
  hostNames: ["New Coworker"]
};

function deps(over: Record<string, unknown> = {}) {
  return {
    classify: vi.fn(async () => ({
      outcome: "signed",
      actionItems: [{ title: "Send the questionnaire", owner: "Brian" }]
    })),
    resolveContact: vi.fn(async () => ({
      contactId: CONTACT_ID,
      contactKey: CONTACT_KEY,
      matchedOn: "booking_ledger"
    })),
    patchDocument: vi.fn(async () => {}),
    createNote: vi.fn(async () => ({}) as never),
    createTodoFn: vi.fn(async () => ({}) as never),
    listMembers: vi.fn(async () => [
      { id: "m-brian", name: "Brian", active: true },
      { id: "m-james", name: "James", active: true }
    ]),
    fireStage: vi.fn(async () => "written"),
    stampLedger: vi.fn(async () => {}),
    claimClassification: vi.fn(async () => true),
    readClassification: vi.fn(async () => null),
    logSystem: vi.fn(async () => {}),
    ...over
  } as never;
}

beforeEach(() => {
  after.mockClear();
  deferred = null;
});

describe("matchRosterMember", () => {
  const roster = [
    { id: "m-brian", name: "Brian", active: true },
    { id: "m-james", name: "James", active: true }
  ];

  it("assigns on an exact, case-insensitive name", () => {
    expect(matchRosterMember(roster, "brian")).toBe("m-brian");
    expect(matchRosterMember(roster, "  Brian  ")).toBe("m-brian");
  });

  it("refuses a partial name", () => {
    // "Bri" handing work to Brian is the sort of friendliness that quietly
    // assigns a task to the wrong person.
    expect(matchRosterMember(roster, "Bri")).toBeNull();
  });

  it("refuses an ambiguous name rather than picking one", () => {
    const twoDaves = [
      { id: "m-1", name: "Dave", active: true },
      { id: "m-2", name: "Dave", active: true }
    ];
    expect(matchRosterMember(twoDaves, "Dave")).toBeNull();
  });

  it("ignores inactive members and empty owners", () => {
    expect(matchRosterMember([{ id: "m-1", name: "Gone", active: false }], "Gone")).toBeNull();
    expect(matchRosterMember(roster, null)).toBeNull();
    expect(matchRosterMember(roster, "   ")).toBeNull();
  });
});

describe("applyMeetingClassification: the happy path", () => {
  it("links the document, files the note, moves the card, files the to-dos", async () => {
    const d = deps();
    const out = await applyMeetingClassification(input, d);

    expect(out).toMatchObject({
      outcome: "signed",
      contactId: CONTACT_ID,
      matchedOn: "booking_ledger",
      linkedDocument: true,
      wroteNote: true,
      stageOutcome: "written",
      todosCreated: 1
    });

    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).patchDocument)
      .toHaveBeenCalledWith(BIZ, "doc-1", { contact_id: CONTACT_ID });
  });

  it("files the note as the AI coworker, with no auth user behind it", async () => {
    const d = deps();
    await applyMeetingClassification(input, d);
    const note = (d as never as Record<string, ReturnType<typeof vi.fn>>).createNote.mock
      .calls[0][0];
    expect(note).toMatchObject({
      business_id: BIZ,
      contact_id: CONTACT_ID,
      author_user_id: null,
      author_label: MEETING_NOTE_AUTHOR_LABEL
    });
    expect(note.body).toContain("Agreed to move forward");
  });

  it("moves the stage with a per-meeting dedupe suffix", async () => {
    const d = deps();
    await applyMeetingClassification(input, d);
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).fireStage)
      .toHaveBeenCalledWith(BIZ, CONTACT_KEY, "won", { dedupeSuffix: `zoom:${MEETING_UUID}` });
  });

  it("assigns a to-do when the minutes name someone on the roster", async () => {
    const d = deps();
    await applyMeetingClassification(input, d);
    const [, todo] = (d as never as Record<string, ReturnType<typeof vi.fn>>).createTodoFn.mock
      .calls[0];
    expect(todo).toMatchObject({
      title: "Send the questionnaire",
      contactId: CONTACT_ID,
      assigneeEmployeeId: "m-brian"
    });
  });

  it("leaves a to-do unassigned when the named owner is not on the roster", async () => {
    const d = deps({
      classify: vi.fn(async () => ({
        outcome: "follow_up",
        actionItems: [{ title: "Send the quote", owner: "Kingsley" }]
      }))
    });
    await applyMeetingClassification(input, d);
    const [, todo] = (d as never as Record<string, ReturnType<typeof vi.fn>>).createTodoFn.mock
      .calls[0];
    expect(todo.assigneeEmployeeId).toBeUndefined();
  });

  it("sends follow_up to the softer stage", async () => {
    const d = deps({
      classify: vi.fn(async () => ({ outcome: "follow_up", actionItems: [] }))
    });
    await applyMeetingClassification(input, d);
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).fireStage.mock.calls[0][2])
      .toBe("met");
  });

  it("stamps the ledger with what it decided", async () => {
    const d = deps();
    await applyMeetingClassification(input, d);
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).stampLedger)
      .toHaveBeenCalledWith(BIZ, MEETING_UUID, {
        contactId: CONTACT_ID,
        outcome: "signed"
      });
  });
});

describe("applyMeetingClassification: what it refuses to write", () => {
  it("files an unclear meeting on an IDENTITY match, but writes nothing to the record", async () => {
    // The booking that created this Zoom meeting names its attendee, so who
    // the call was with is not in doubt even when what it WAS is. The
    // document goes on their record; the note, the card and the to-dos do
    // not, because none of those can be written from "unclear".
    const d = deps({ classify: vi.fn(async () => ({ outcome: "unclear", actionItems: [] })) });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(out.linkedDocument).toBe(true);
    expect(m.patchDocument).toHaveBeenCalledWith(BIZ, "doc-1", { contact_id: CONTACT_ID });
    expect(m.createNote).not.toHaveBeenCalled();
    expect(m.fireStage).not.toHaveBeenCalled();
    expect(m.createTodoFn).not.toHaveBeenCalled();
    // Stamped anyway: "we have decided about this meeting" is the fact.
    expect(m.stampLedger).toHaveBeenCalled();
  });

  it("writes nothing at all for an unclear meeting matched only by NAME", async () => {
    // Two people sharing a first name is exactly the case where an
    // uncategorizable meeting must not land on anybody: a document filed on
    // a stranger is still a stranger reading someone else's minutes.
    const d = deps({
      classify: vi.fn(async () => ({ outcome: "unclear", actionItems: [] })),
      resolveContact: vi.fn(async () => ({
        contactId: CONTACT_ID,
        contactKey: CONTACT_KEY,
        matchedOn: "speaker_name"
      }))
    });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(out.contactId).toBeNull();
    expect(out.matchedOn).toBeNull();
    expect(m.patchDocument).not.toHaveBeenCalled();
    expect(m.createNote).not.toHaveBeenCalled();
    expect(m.stampLedger).toHaveBeenCalledWith(BIZ, MEETING_UUID, {
      contactId: null,
      outcome: "unclear"
    });
  });

  it("keeps an internal meeting off everyone's record", async () => {
    const d = deps({ classify: vi.fn(async () => ({ outcome: "internal", actionItems: [] })) });
    await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.resolveContact).not.toHaveBeenCalled();
    expect(m.patchDocument).not.toHaveBeenCalled();
  });

  it("files a not_a_fit meeting on the record but moves no card", async () => {
    // The meeting DID happen with this person, so the note and the link are
    // right; there is just no column to move them to.
    const d = deps({
      classify: vi.fn(async () => ({ outcome: "not_a_fit", actionItems: [] }))
    });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.createNote).toHaveBeenCalled();
    expect(m.fireStage).not.toHaveBeenCalled();
    expect(out.stageOutcome).toBeNull();
  });

  it("writes nothing to a record when it cannot tell whose meeting it was", async () => {
    const d = deps({ resolveContact: vi.fn(async () => null) });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(out.contactId).toBeNull();
    expect(m.patchDocument).not.toHaveBeenCalled();
    expect(m.createNote).not.toHaveBeenCalled();
    expect(m.createTodoFn).not.toHaveBeenCalled();
    expect(m.stampLedger).toHaveBeenCalled();
  });
});

describe("applyMeetingClassification: each sink fails alone", () => {
  it("still files the note when the document link fails", async () => {
    const d = deps({
      patchDocument: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const out = await applyMeetingClassification(input, d);
    expect(out.linkedDocument).toBe(false);
    expect(out.wroteNote).toBe(true);
    expect(out.todosCreated).toBe(1);
  });

  it("still moves the card when the note fails", async () => {
    const d = deps({
      createNote: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const out = await applyMeetingClassification(input, d);
    expect(out.wroteNote).toBe(false);
    expect(out.stageOutcome).toBe("written");
  });

  it("counts only the to-dos that landed", async () => {
    let n = 0;
    const d = deps({
      classify: vi.fn(async () => ({
        outcome: "signed",
        actionItems: [
          { title: "One", owner: null },
          { title: "Two", owner: null }
        ]
      })),
      createTodoFn: vi.fn(async () => {
        n += 1;
        if (n === 1) throw new Error("boom");
        return {} as never;
      })
    });
    expect((await applyMeetingClassification(input, d)).todosCreated).toBe(1);
  });

  it("files to-dos unassigned when the roster cannot be read", async () => {
    const d = deps({
      listMembers: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const out = await applyMeetingClassification(input, d);
    expect(out.todosCreated).toBe(1);
    const [, todo] = (d as never as Record<string, ReturnType<typeof vi.fn>>).createTodoFn.mock
      .calls[0];
    expect(todo.assigneeEmployeeId).toBeUndefined();
  });

  it("skips the roster read entirely when there are no action items", async () => {
    const d = deps({
      classify: vi.fn(async () => ({ outcome: "signed", actionItems: [] }))
    });
    await applyMeetingClassification(input, d);
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).listMembers)
      .not.toHaveBeenCalled();
  });

  it("survives a failing ledger stamp", async () => {
    const d = deps({
      stampLedger: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    expect((await applyMeetingClassification(input, d)).outcome).toBe("signed");
  });
});

describe("applyMeetingClassification: a re-imported meeting", () => {
  const prior = {
    contactId: CONTACT_ID,
    outcome: "signed",
    classifiedAt: "2026-08-20T21:00:00Z"
  };

  it("re-links the new document without re-deciding anything", async () => {
    const d = deps({
      claimClassification: vi.fn(async () => false),
      readClassification: vi.fn(async () => prior)
    });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;

    expect(out.reusedPriorClassification).toBe(true);
    expect(out.linkedDocument).toBe(true);
    expect(m.patchDocument).toHaveBeenCalledWith(BIZ, "doc-1", { contact_id: CONTACT_ID });
    // No second model call, no second note, no second stage move, no
    // duplicate to-dos.
    expect(m.classify).not.toHaveBeenCalled();
    expect(m.createNote).not.toHaveBeenCalled();
    expect(m.fireStage).not.toHaveBeenCalled();
    expect(m.createTodoFn).not.toHaveBeenCalled();
    expect(m.stampLedger).not.toHaveBeenCalled();
  });

  it("logs that the earlier decision still stands", async () => {
    const d = deps({
      claimClassification: vi.fn(async () => false),
      readClassification: vi.fn(async () => prior)
    });
    await applyMeetingClassification(input, d);
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).logSystem.mock.calls[0][0])
      .toMatchObject({ event: "meeting_reclassify_skipped" });
  });

  it("claims before doing any work, so a racing pass cannot double-write", async () => {
    // Bugbot, PR #1566: this used to READ classified_at at the start and
    // stamp it at the end, leaving the whole classify pass (two model calls)
    // as a window in which a manual re-import scheduled a second pass that
    // also saw no stamp. Both then wrote a note and a set of to-dos.
    const order: string[] = [];
    const d = deps({
      claimClassification: vi.fn(async () => {
        order.push("claim");
        return true;
      }),
      classify: vi.fn(async () => {
        order.push("classify");
        return { outcome: "signed", actionItems: [] };
      })
    });
    await applyMeetingClassification(input, d);
    expect(order).toEqual(["claim", "classify"]);
  });

  it("writes nothing to a record while the winning pass is still running", async () => {
    // Claim lost AND the winner has not stamped an outcome yet, so there is
    // no contact to attribute to. Guessing one would file this meeting on
    // whoever a fresh resolve happened to return.
    const d = deps({
      claimClassification: vi.fn(async () => false),
      readClassification: vi.fn(async () => ({
        contactId: null,
        outcome: null,
        classifiedAt: "2026-08-20T21:00:00Z"
      }))
    });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(out.linkedDocument).toBe(false);
    expect(m.createNote).not.toHaveBeenCalled();
    expect(m.logSystem.mock.calls[0][0].payload.winnerInFlight).toBe(true);
  });

  it("declines to write when the ledger cannot be reached at all", async () => {
    // A claim blip answers false, so the pass skips rather than risking the
    // duplicate the claim exists to prevent.
    const d = deps({
      claimClassification: vi.fn(async () => false),
      readClassification: vi.fn(async () => null)
    });
    const out = await applyMeetingClassification(input, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.classify).not.toHaveBeenCalled();
    expect(m.createNote).not.toHaveBeenCalled();
    expect(out.reusedPriorClassification).toBe(true);
  });

  it("skips the link when the earlier run matched nobody", async () => {
    const d = deps({
      claimClassification: vi.fn(async () => false),
      readClassification: vi.fn(async () => ({ ...prior, contactId: null, outcome: "unclear" }))
    });
    const out = await applyMeetingClassification(input, d);
    expect(out.outcome).toBe("unclear");
    expect(out.linkedDocument).toBe(false);
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).patchDocument)
      .not.toHaveBeenCalled();
  });
});

describe("scheduleMeetingClassification", () => {
  it("defers the pass past the response", async () => {
    const d = deps();
    scheduleMeetingClassification(input, d);
    expect(after).toHaveBeenCalledTimes(1);
    await deferred;
    expect((d as never as Record<string, ReturnType<typeof vi.fn>>).classify)
      .toHaveBeenCalled();
  });

  it("swallows a scheduling failure outside a request scope", async () => {
    // after() throws in some tests and CLIs; the import must not care.
    after.mockImplementationOnce(() => {
      throw new Error("outside a request scope");
    });
    expect(() => scheduleMeetingClassification(input, deps())).not.toThrow();

    after.mockImplementationOnce(() => {
      throw "raw string";
    });
    expect(() => scheduleMeetingClassification(input, deps())).not.toThrow();
  });
});

describe("applyMeetingClassification: things that throw something other than an Error", () => {
  it("logs a raw thrown value from a sink without crashing", async () => {
    const d = deps({
      patchDocument: vi.fn(async () => {
        throw "raw string";
      })
    });
    const out = await applyMeetingClassification(input, d);
    expect(out.linkedDocument).toBe(false);
    expect(out.wroteNote).toBe(true);
  });

  it("logs a raw thrown value from the roster read without crashing", async () => {
    const d = deps({
      listMembers: vi.fn(async () => {
        throw "raw string";
      })
    });
    expect((await applyMeetingClassification(input, d)).todosCreated).toBe(1);
  });
});

describe("applyMeetingClassification: an owner-forced contact", () => {
  const forced = {
    ...input,
    forcedContact: { contactId: CONTACT_ID, contactKey: CONTACT_KEY }
  };

  it("skips attribution entirely and records that a person answered", async () => {
    const d = deps();
    const out = await applyMeetingClassification(forced, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.resolveContact).not.toHaveBeenCalled();
    expect(out.matchedOn).toBe("owner");
    expect(out.contactId).toBe(CONTACT_ID);
  });

  it("files the note and the to-dos even when the model cannot categorize the call", async () => {
    // The whole point of the reassign: "I do not know what this was" plus
    // "a person told me who it was with" is enough to file the meeting.
    const d = deps({
      classify: vi.fn(async () => ({
        outcome: "unclear",
        actionItems: [{ title: "Send the proposal", owner: "Brian" }]
      }))
    });
    const out = await applyMeetingClassification(forced, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(out.linkedDocument).toBe(true);
    expect(out.wroteNote).toBe(true);
    expect(out.todosCreated).toBe(1);
    // No stage move: `unclear` maps to no lifecycle event, and a human
    // saying who was on the call is not a claim about what it meant.
    expect(m.fireStage).not.toHaveBeenCalled();
    expect(out.stageOutcome).toBeNull();
  });

  it("asks for action items on an outcome that would normally skip them", async () => {
    const classify = vi.fn(async () => ({ outcome: "unclear", actionItems: [] }));
    await applyMeetingClassification(forced, deps({ classify }));
    expect(classify).toHaveBeenCalledWith(BIZ, input.minutes, {
      alwaysExtractActionItems: true
    });
  });

  it("does not ask for them on an ordinary automatic pass", async () => {
    const classify = vi.fn(async () => ({ outcome: "signed", actionItems: [] }));
    await applyMeetingClassification(input, deps({ classify }));
    expect(classify).toHaveBeenCalledWith(BIZ, input.minutes, {
      alwaysExtractActionItems: false
    });
  });

  it("still keeps an internal meeting off the record, forced or not", async () => {
    // A team sync is a team sync even if somebody reassigns it: the guard
    // that stops a colleague's name collecting a note is not overridable.
    const d = deps({ classify: vi.fn(async () => ({ outcome: "internal", actionItems: [] })) });
    const out = await applyMeetingClassification(forced, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.patchDocument).not.toHaveBeenCalled();
    expect(m.createNote).not.toHaveBeenCalled();
    expect(out.contactId).toBeNull();
  });

  it("moves the card when the model DOES categorize the reassigned call", async () => {
    const d = deps({
      classify: vi.fn(async () => ({ outcome: "follow_up", actionItems: [] }))
    });
    const out = await applyMeetingClassification(forced, d);
    const m = d as never as Record<string, ReturnType<typeof vi.fn>>;
    expect(m.fireStage).toHaveBeenCalledWith(BIZ, CONTACT_KEY, "met", {
      dedupeSuffix: `zoom:${MEETING_UUID}`
    });
    expect(out.stageOutcome).toBe("written");
  });
});

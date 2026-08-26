import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServiceClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...args: unknown[]) => createSupabaseServiceClient(...args)
}));

const getBusiness = vi.fn();
vi.mock("@/lib/db/businesses", () => ({
  getBusiness: (...args: unknown[]) => getBusiness(...args)
}));

const getActiveZoomConnection = vi.fn();
vi.mock("@/lib/db/zoom-connections", () => ({
  getActiveZoomConnection: (...args: unknown[]) => getActiveZoomConnection(...args)
}));

import {
  getContactForReassign,
  loadMeetingHostNames,
  reassignMeetingContact,
  repairGraphGuestName
} from "@/lib/meetings/reassign";

/**
 * "This meeting was with somebody else."
 *
 * The wrong name lands in five places and only two of them are visible to
 * the owner, so the assertions here are mostly about the invisible three:
 * the summary, the knowledge-graph node, and the classification that filed
 * the meeting on nobody. Two rules run through all of it: the document write
 * is the only step allowed to fail loudly, and a name that matches more than
 * one thing is never guessed at.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const DOC = "11111111-1111-1111-1111-111111111111";
const CONTACT_ID = "22222222-2222-2222-2222-222222222222";
const CONTACT_KEY = "+17208438676";
const MEETING_UUID = "QLQhqIqqRpekMveHl273TQ==";

const VTT = [
  "WEBVTT",
  "",
  "1",
  "00:00:01.000 --> 00:00:04.000",
  "Brian Lane: Hey, Bobby.",
  "",
  "2",
  "00:00:05.000 --> 00:00:09.000",
  "Alexander: Oh, good. Hi, morning.",
  ""
].join("\n");

const documentRow = (over: Record<string, unknown> = {}) => ({
  id: DOC,
  business_id: BIZ,
  title: "Alexander Zoom meeting recording",
  category: "meeting",
  audience: "staff",
  storage_path: `${BIZ}/${DOC}/zoom-meeting-88471846305.vtt`,
  summary: "Alexander discusses his apartment locating business model.",
  content_md: "- Alexander operates as a rental locator.\n\n## Transcript\n\nAlexander: Yes.",
  contact_id: null,
  ...over
});

const entityRow = (over: Record<string, unknown> = {}) => ({
  id: "e-alexander",
  business_id: BIZ,
  kind: "person",
  canonical_name: "Alexander",
  aliases: [] as string[],
  phones: [] as string[],
  emails: [] as string[],
  customer_e164: null,
  source: "document",
  trust: 2,
  attributed_to: "Brian Lane's Zoom Meeting (transcript)",
  created_at: "2026-08-25T20:02:09.567Z",
  updated_at: "2026-08-25T20:02:09.567Z",
  ...over
});

const factRow = (over: Record<string, unknown> = {}) => ({
  id: "f-1",
  business_id: BIZ,
  subject_entity_id: "e-alexander",
  predicate: "brokerage",
  object_entity_id: "e-amigo",
  object_value: null,
  source_text: "Alexander operates as a rental locator.",
  stated_at: "2026-08-25T20:02:10.049Z",
  active: true,
  superseded_by: null,
  source: "document",
  trust: 2,
  attributed_to: "Brian Lane's Zoom Meeting (transcript)",
  created_at: "2026-08-25T20:02:10.049Z",
  ...over
});

/**
 * Arguments of one recorded call.
 *
 * The fakes are declared as zero-argument `vi.fn`s (they ignore what they
 * are handed), so TypeScript types `mock.calls` as an empty tuple and
 * indexing it is an error. This widens it once instead of casting at every
 * assertion.
 */
function callArgs(fn: unknown, call = 0): unknown[] {
  return ((fn as { mock: { calls: unknown[][] } }).mock.calls[call] ?? []) as unknown[];
}

function deps(over: Record<string, unknown> = {}) {
  return {
    getDocument: vi.fn(async () => documentRow() as never),
    patchDocument: vi.fn(async () => {}),
    getContactById: vi.fn(async () => ({
      id: CONTACT_ID,
      display_name: "Bobby",
      customer_e164: CONTACT_KEY
    })),
    getLedgerRow: vi.fn(async () => ({
      meeting_uuid: MEETING_UUID,
      contact_id: null,
      outcome: "unclear"
    })),
    loadHostNames: vi.fn(async () => ["New Coworker", "Brian Lane"]),
    reopenClassification: vi.fn(async () => "reopened"),
    fetchTranscript: vi.fn(async () => VTT),
    classifyAndApply: vi.fn(async () => ({
      outcome: "follow_up",
      contactId: CONTACT_ID,
      matchedOn: "owner" as const,
      linkedDocument: true,
      wroteNote: true,
      stageOutcome: "written",
      todosCreated: 2,
      reusedPriorClassification: false
    })),
    listEntities: vi.fn(async () => [entityRow()]),
    listFacts: vi.fn(async () => [factRow()]),
    updateEntity: vi.fn(async () => {}),
    updateFactSourceText: vi.fn(async () => {}),
    syncVault: vi.fn(async () => ({ ok: true }) as never),
    logSystem: vi.fn(async () => {}),
    ...over
  };
}

beforeEach(() => {
  createSupabaseServiceClient.mockReset();
  getBusiness.mockReset();
  getActiveZoomConnection.mockReset();
});

describe("reassignMeetingContact: refusals", () => {
  it("refuses a document that is not there", async () => {
    const d = deps({ getDocument: vi.fn(async () => null) });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result).toEqual({ ok: false, error: "document_not_found", detail: "Document not found" });
    expect(d.patchDocument).not.toHaveBeenCalled();
  });

  it("refuses a contact that is not there", async () => {
    const d = deps({ getContactById: vi.fn(async () => null) });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("contact_not_found");
    expect(d.patchDocument).not.toHaveBeenCalled();
  });

  it.each<[string | null]>([["   "], [null]])(
    "refuses a contact whose display name is %s rather than blanking the guest out",
    async (displayName) => {
      const d = deps({
        getContactById: vi.fn(async () => ({
          id: CONTACT_ID,
          display_name: displayName,
          customer_e164: CONTACT_KEY
        }))
      });
      const result = await reassignMeetingContact(
        { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
        d as never
      );
      expect(result.ok === false && result.error).toBe("contact_unnamed");
      expect(d.patchDocument).not.toHaveBeenCalled();
    }
  );

  it("keeps going when a guarded step throws a non-Error value", async () => {
    const d = deps({
      syncVault: vi.fn(async () => {
        throw "raw string";
      })
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok).toBe(true);
  });
});

describe("reassignMeetingContact: the repair", () => {
  it("renames the guest through the title, summary and minutes, and links the contact", async () => {
    const d = deps();
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );

    expect(result.ok).toBe(true);
    expect(d.patchDocument).toHaveBeenCalledWith(BIZ, DOC, {
      title: "Bobby Zoom meeting recording",
      summary: "Bobby discusses his apartment locating business model.",
      content_md: "- Bobby operates as a rental locator.\n\n## Transcript\n\nBobby: Yes.",
      contact_id: CONTACT_ID,
      audience: "staff"
    });
    expect(result.ok === true && result.rewrote).toEqual(["title", "summary", "content"]);
    expect(result.ok === true && result.renamedFrom).toBe("Alexander");
  });

  it("re-runs the classification with the contact forced, against the CORRECTED content", async () => {
    const d = deps();
    await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );

    expect(d.reopenClassification).toHaveBeenCalledWith(BIZ, MEETING_UUID);
    const applied = callArgs(d.classifyAndApply)[0] as Record<string, unknown>;
    expect(applied.forcedContact).toEqual({ contactId: CONTACT_ID, contactKey: CONTACT_KEY });
    expect(applied.documentTitle).toBe("Bobby Zoom meeting recording");
    expect(applied.content).toContain("Bobby operates as a rental locator");
    expect(applied.content).not.toContain("Alexander");
  });

  it("reports what the re-classification filed", async () => {
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      deps() as never
    );
    expect(result.ok === true && result.reclassified).toBe(true);
    expect(result.ok === true && result.outcome).toBe("follow_up");
    expect(result.ok === true && result.wroteNote).toBe(true);
    expect(result.ok === true && result.todosCreated).toBe(2);
    expect(result.ok === true && result.stageOutcome).toBe("written");
  });

  it("reports a lost claim as NOT reclassified, so a double-click never reads as two passes", async () => {
    const d = deps({
      classifyAndApply: vi.fn(async () => ({
        outcome: "unclear",
        contactId: null,
        matchedOn: null,
        linkedDocument: true,
        wroteNote: false,
        stageOutcome: null,
        todosCreated: 0,
        reusedPriorClassification: true
      }))
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok === true && result.reclassified).toBe(false);
  });

  it("re-runs the classification for a meeting nothing has ever classified", async () => {
    // An import predating the classifier has a null stamp and no owner.
    const d = deps({ reopenClassification: vi.fn(async () => "not_classified") });
    await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(d.classifyAndApply).toHaveBeenCalledTimes(1);
  });

  it("leaves an in-flight pass alone and says the note was not filed", async () => {
    // Bugbot, PR #1618: running alongside it lets the loser stamp its own
    // answer over this correction, and in the motivating case that answer is
    // "nobody". The rename and the link still stand.
    const d = deps({ reopenClassification: vi.fn(async () => "in_flight") });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(d.classifyAndApply).not.toHaveBeenCalled();
    expect(result.ok === true && result.reclassifyBlocked).toBe(true);
    expect(result.ok === true && result.reclassified).toBe(false);
    expect(callArgs(d.patchDocument)[2]).toMatchObject({
      title: "Bobby Zoom meeting recording",
      contact_id: CONTACT_ID
    });
  });

  it("treats a ledger blip as in-flight, so a blip never buys a duplicate note", async () => {
    const d = deps({
      reopenClassification: vi.fn(async () => {
        throw new Error("ledger down");
      })
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(d.classifyAndApply).not.toHaveBeenCalled();
    expect(result.ok === true && result.reclassifyBlocked).toBe(true);
  });

  it("skips the classification for a document the import ledger does not know", async () => {
    const d = deps({ getLedgerRow: vi.fn(async () => null) });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(d.classifyAndApply).not.toHaveBeenCalled();
    expect(d.fetchTranscript).not.toHaveBeenCalled();
    expect(result.ok === true && result.reclassified).toBe(false);
    // The rename still happened, off the title alone.
    expect(result.ok === true && result.renamedFrom).toBe("Alexander");
  });

  it("honours a wrong name the owner supplies over the one it would derive", async () => {
    const d = deps({
      getDocument: vi.fn(
        async () =>
          documentRow({
            title: "Renamed by the owner",
            summary: "Sandy explained the model.",
            content_md: "Sandy: Yes."
          }) as never
      )
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID, wrongName: "Sandy" },
      d as never
    );
    expect(result.ok === true && result.renamedFrom).toBe("Sandy");
    expect(callArgs(d.patchDocument)[2]).toMatchObject({
      summary: "Bobby explained the model.",
      content_md: "Bobby: Yes."
    });
  });

  it("links the contact without renaming when no wrong name can be found", async () => {
    const d = deps({
      getDocument: vi.fn(
        async () =>
          documentRow({
            title: "Renamed by the owner",
            summary: "",
            content_md: "Nothing to rename."
          }) as never
      ),
      fetchTranscript: vi.fn(async () => "")
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok === true && result.renamedFrom).toBeNull();
    expect(result.ok === true && result.rewrote).toEqual([]);
    expect(callArgs(d.patchDocument)[2]).toMatchObject({ contact_id: CONTACT_ID });
    // Nothing to rename means nothing to repair in the graph either.
    expect(d.listEntities).not.toHaveBeenCalled();
  });

  it("handles a document with no summary and no condensed body yet", async () => {
    const d = deps({
      getDocument: vi.fn(async () => documentRow({ summary: null, content_md: null }) as never)
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok === true && result.rewrote).toEqual(["title"]);
    expect(callArgs(d.patchDocument)[2]).toMatchObject({ summary: "", content_md: "" });
  });

  it("clamps the rewritten summary to the length the documents API accepts", async () => {
    const d = deps({
      getDocument: vi.fn(
        async () => documentRow({ summary: `Alexander ${"x".repeat(400)}` }) as never
      )
    });
    await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    const patch = callArgs(d.patchDocument)[2] as { summary: string };
    expect(patch.summary.length).toBe(300);
    expect(patch.summary.startsWith("Bobby ")).toBe(true);
  });

  it("re-syncs the box, which holds its own copy of both corrections", async () => {
    const d = deps();
    await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(d.syncVault).toHaveBeenCalledWith(BIZ);
  });

  it("records what it did, naming both names", async () => {
    const d = deps();
    await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    const logged = callArgs(d.logSystem)[0] as {
      message: string;
      payload: Record<string, unknown>;
    };
    expect(logged.message).toContain("Alexander");
    expect(logged.message).toContain("Bobby");
    expect(logged.payload).toMatchObject({ documentId: DOC, contactId: CONTACT_ID });
  });

  it("names only the new contact in the log when nothing was renamed", async () => {
    const d = deps({
      getDocument: vi.fn(
        async () =>
          documentRow({ title: "Owner title", summary: "", content_md: "Nothing." }) as never
      ),
      fetchTranscript: vi.fn(async () => "")
    });
    await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    const logged = callArgs(d.logSystem)[0] as { message: string };
    expect(logged.message).toBe("Meeting minutes reassigned to Bobby");
  });
});

describe("reassignMeetingContact: nothing after the document write may throw", () => {
  it("surfaces a failed document write instead of reporting success", async () => {
    const d = deps({
      patchDocument: vi.fn(async () => {
        throw new Error("write failed");
      })
    });
    await expect(
      reassignMeetingContact({ businessId: BIZ, documentId: DOC, contactId: CONTACT_ID }, d as never)
    ).rejects.toThrow("write failed");
  });

  it.each([
    ["getLedgerRow", "ledger"],
    ["loadHostNames", "host names"],
    ["fetchTranscript", "transcript"],
    ["syncVault", "vault"],
    ["logSystem", "log"]
  ])("survives %s throwing", async (dep) => {
    const d = deps({
      [dep]: vi.fn(async () => {
        throw new Error("boom");
      })
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok).toBe(true);
    expect(d.patchDocument).toHaveBeenCalled();
  });

  it("survives a graph read throwing, and says nothing was renamed there", async () => {
    const d = deps({
      listEntities: vi.fn(async () => {
        throw new Error("graph down");
      })
    });
    const result = await reassignMeetingContact(
      { businessId: BIZ, documentId: DOC, contactId: CONTACT_ID },
      d as never
    );
    expect(result.ok === true && result.graphEntitiesRenamed).toBe(0);
  });
});

describe("repairGraphGuestName", () => {
  const input = {
    businessId: BIZ,
    wrongName: "Alexander",
    rightName: "Bobby",
    contactKey: CONTACT_KEY,
    hostNames: ["Brian Lane"]
  };

  it("renames the node, keeps its edges, and files the old name as an alias", async () => {
    const d = deps();
    const result = await repairGraphGuestName(input, d as never);

    expect(d.updateEntity).toHaveBeenCalledWith("e-alexander", {
      canonical_name: "Bobby",
      aliases: ["alexander"],
      customer_e164: CONTACT_KEY
    });
    expect(result).toEqual({ entitiesRenamed: 1, factsRewritten: 1 });
  });

  it("rewrites the quoted source text on the renamed node's own facts", async () => {
    const d = deps();
    await repairGraphGuestName(input, d as never);
    expect(d.updateFactSourceText).toHaveBeenCalledWith(
      "f-1",
      "Bobby operates as a rental locator."
    );
  });

  it("rewrites a fact that points AT the node, not only ones it is the subject of", async () => {
    const d = deps({
      listFacts: vi.fn(async () => [
        factRow({
          id: "f-2",
          subject_entity_id: "e-amigo",
          object_entity_id: "e-alexander",
          source_text: "Apartment Amigo pays Alexander a commission."
        })
      ])
    });
    await repairGraphGuestName(input, d as never);
    expect(d.updateFactSourceText).toHaveBeenCalledWith(
      "f-2",
      "Apartment Amigo pays Bobby a commission."
    );
  });

  it("leaves other entities' facts alone", async () => {
    const d = deps({
      listFacts: vi.fn(async () => [
        factRow({
          id: "f-3",
          subject_entity_id: "e-someone-else",
          object_entity_id: null,
          source_text: "A different Alexander runs the Denver desk."
        })
      ])
    });
    const result = await repairGraphGuestName(input, d as never);
    expect(d.updateFactSourceText).not.toHaveBeenCalled();
    expect(result.factsRewritten).toBe(0);
  });

  it("skips a fact whose text does not carry the name at all", async () => {
    const d = deps({
      listFacts: vi.fn(async () => [factRow({ source_text: "Rental locator, nine cities." })])
    });
    const result = await repairGraphGuestName(input, d as never);
    expect(d.updateFactSourceText).not.toHaveBeenCalled();
    expect(result.factsRewritten).toBe(0);
  });

  it("matches the node under the FIRST name when Zoom recorded a full one", async () => {
    // Bugbot, PR #1618: the extractor reads the minutes, which use the first
    // name, so the node is usually "Alexander" even when the Zoom label was
    // "Alexander Delacroix". Matching only the full string corrected the
    // document and left the node wrong.
    const d = deps();
    const result = await repairGraphGuestName(
      { ...input, wrongName: "Alexander Delacroix" },
      d as never
    );
    expect(result.entitiesRenamed).toBe(1);
    expect(callArgs(d.updateEntity)[1]).toMatchObject({ canonical_name: "Bobby" });
  });

  it("still refuses when two nodes answer to different forms of the name", async () => {
    const d = deps({
      listEntities: vi.fn(async () => [
        entityRow(),
        entityRow({ id: "e-2", canonical_name: "Alexander Delacroix" })
      ])
    });
    const result = await repairGraphGuestName(
      { ...input, wrongName: "Alexander Delacroix" },
      d as never
    );
    expect(result.entitiesRenamed).toBe(0);
  });

  it("matches a node that carries the wrong name as an ALIAS", async () => {
    const d = deps({
      listEntities: vi.fn(async () => [
        entityRow({ canonical_name: "Alex D", aliases: ["alexander"] })
      ])
    });
    const result = await repairGraphGuestName(input, d as never);
    expect(result.entitiesRenamed).toBe(1);
    // Already an alias, so it is not added twice.
    expect(callArgs(d.updateEntity)[1]).toMatchObject({ aliases: ["alexander"] });
  });

  it("does not file the old name as an alias of itself", async () => {
    const d = deps({ listEntities: vi.fn(async () => [entityRow({ canonical_name: "Bobby" })]) });
    const result = await repairGraphGuestName({ ...input, wrongName: "Bobby" }, d as never);
    expect(result.entitiesRenamed).toBe(1);
    expect(callArgs(d.updateEntity)[1]).toMatchObject({ aliases: [] });
  });

  it("leaves the graph alone when two people answer to the name", async () => {
    const d = deps({
      listEntities: vi.fn(async () => [entityRow(), entityRow({ id: "e-alexander-2" })])
    });
    const result = await repairGraphGuestName(input, d as never);
    expect(d.updateEntity).not.toHaveBeenCalled();
    expect(result).toEqual({ entitiesRenamed: 0, factsRewritten: 0 });
  });

  it("leaves the graph alone when it never learned this person", async () => {
    const d = deps({ listEntities: vi.fn(async () => []) });
    const result = await repairGraphGuestName(input, d as never);
    expect(result).toEqual({ entitiesRenamed: 0, factsRewritten: 0 });
  });

  it("never renames an organization that happens to share the name", async () => {
    const d = deps({
      listEntities: vi.fn(async () => [entityRow({ kind: "organization" })])
    });
    const result = await repairGraphGuestName(input, d as never);
    expect(result.entitiesRenamed).toBe(0);
  });

  it("treats an empty name as no match rather than matching everything", async () => {
    // No variants means no candidates: an empty wrong name must never match
    // a node whose own name is blank.
    const d = deps({ listEntities: vi.fn(async () => [entityRow({ canonical_name: "  " })]) });
    const result = await repairGraphGuestName({ ...input, wrongName: "   " }, d as never);
    expect(result.entitiesRenamed).toBe(0);
    expect(d.updateEntity).not.toHaveBeenCalled();
  });
});

describe("getContactForReassign", () => {
  function contactQuery(result: Record<string, unknown>) {
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => result
    };
    return { from: () => builder };
  }

  it("reads the contact centrally, since contacts are a kept table", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      contactQuery({
        data: { id: CONTACT_ID, display_name: "Bobby", customer_e164: CONTACT_KEY },
        error: null
      }) as never
    );
    await expect(getContactForReassign(BIZ, CONTACT_ID)).resolves.toEqual({
      id: CONTACT_ID,
      display_name: "Bobby",
      customer_e164: CONTACT_KEY
    });
  });

  it("answers null for a contact that is not there", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      contactQuery({ data: null, error: null }) as never
    );
    await expect(getContactForReassign(BIZ, CONTACT_ID)).resolves.toBeNull();
  });

  it("throws on a query error rather than reporting nobody", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      contactQuery({ data: null, error: { message: "boom" } }) as never
    );
    await expect(getContactForReassign(BIZ, CONTACT_ID)).rejects.toThrow("boom");
  });
});

describe("loadMeetingHostNames", () => {
  it("pairs the business name with the connected Zoom account's own name", async () => {
    getBusiness.mockResolvedValue({ name: "New Coworker" });
    getActiveZoomConnection.mockResolvedValue({ account_name: "Brian Lane" });
    await expect(loadMeetingHostNames(BIZ)).resolves.toEqual(["New Coworker", "Brian Lane"]);
  });

  it("falls back to nothing when the business is gone", async () => {
    getBusiness.mockResolvedValue(null);
    getActiveZoomConnection.mockResolvedValue(null);
    await expect(loadMeetingHostNames(BIZ)).resolves.toEqual([]);
  });
});

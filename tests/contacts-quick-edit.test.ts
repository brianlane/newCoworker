/**
 * The Tasks page quick editor's save contract (src/lib/contacts/quick-edit.ts).
 *
 * The load-bearing rule: the PATCH body carries ONLY fields the user
 * changed. The contacts PATCH stamps any non-empty displayName as a manual
 * label, so a body that echoed the card's resolved name unchanged would
 * turn a derived name (owner overlay, phone fallback) into a stored one.
 */
import { describe, expect, it } from "vitest";
import {
  addTagToDraft,
  buildContactPatch
} from "@/lib/contacts/quick-edit";
import {
  MAX_CONTACT_TAGS,
  MAX_CONTACT_TAG_LENGTH
} from "@/lib/customer-memory/types";

const initial = {
  displayName: "Brett Douglas",
  tags: ["Booking Page", "Won"],
  ownerEmployeeId: "emp-1"
};

describe("buildContactPatch", () => {
  it("returns null when nothing changed", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "Brett Douglas",
        tags: ["Booking Page", "Won"],
        ownerEmployeeId: "emp-1"
      })
    ).toBeNull();
  });

  it("treats surrounding whitespace on the name as no change", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "  Brett Douglas  ",
        tags: initial.tags,
        ownerEmployeeId: "emp-1"
      })
    ).toBeNull();
  });

  it("sends only the name when only the name changed", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "Brett D.",
        tags: initial.tags,
        ownerEmployeeId: "emp-1"
      })
    ).toEqual({ displayName: "Brett D." });
  });

  it("clears the name with null (provenance resets to auto)", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "   ",
        tags: initial.tags,
        ownerEmployeeId: "emp-1"
      })
    ).toEqual({ displayName: null });
  });

  it("does not report a change for an unnamed contact left unnamed", () => {
    expect(
      buildContactPatch(
        { ...initial, displayName: null },
        { displayName: "", tags: initial.tags, ownerEmployeeId: "emp-1" }
      )
    ).toBeNull();
  });

  it("sends the full tag set when a tag was added or removed", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "Brett Douglas",
        tags: ["Booking Page", "Won", "VIP"],
        ownerEmployeeId: "emp-1"
      })
    ).toEqual({ tags: ["Booking Page", "Won", "VIP"] });
    expect(
      buildContactPatch(initial, {
        displayName: "Brett Douglas",
        tags: ["Won"],
        ownerEmployeeId: "emp-1"
      })
    ).toEqual({ tags: ["Won"] });
  });

  it("does not confuse tag boundaries that only differ by spacing", () => {
    // "New Lead" + "b" vs "New" + "Lead b": different sets, same space-join.
    expect(
      buildContactPatch(
        { ...initial, tags: ["New Lead", "b"] },
        {
          displayName: "Brett Douglas",
          tags: ["New", "Lead b"],
          ownerEmployeeId: "emp-1"
        }
      )
    ).toEqual({ tags: ["New", "Lead b"] });
  });

  it("sends an owner change, and empty string means unassign (null)", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "Brett Douglas",
        tags: initial.tags,
        ownerEmployeeId: "emp-2"
      })
    ).toEqual({ ownerEmployeeId: "emp-2" });
    expect(
      buildContactPatch(initial, {
        displayName: "Brett Douglas",
        tags: initial.tags,
        ownerEmployeeId: ""
      })
    ).toEqual({ ownerEmployeeId: null });
  });

  it("treats unassigned-to-unassigned as no change", () => {
    expect(
      buildContactPatch(
        { ...initial, ownerEmployeeId: null },
        { displayName: "Brett Douglas", tags: initial.tags, ownerEmployeeId: "" }
      )
    ).toBeNull();
  });

  it("combines several changed fields into one body", () => {
    expect(
      buildContactPatch(initial, {
        displayName: "New Name",
        tags: ["Won"],
        ownerEmployeeId: ""
      })
    ).toEqual({
      displayName: "New Name",
      tags: ["Won"],
      ownerEmployeeId: null
    });
  });
});

describe("addTagToDraft", () => {
  it("trims and appends a new tag", () => {
    expect(addTagToDraft(["a"], "  VIP  ")).toEqual(["a", "VIP"]);
  });

  it("caps the tag at the max length", () => {
    const long = "x".repeat(MAX_CONTACT_TAG_LENGTH + 10);
    expect(addTagToDraft([], long)).toEqual(["x".repeat(MAX_CONTACT_TAG_LENGTH)]);
  });

  it("returns the same array for empty input", () => {
    const tags = ["a"];
    expect(addTagToDraft(tags, "   ")).toBe(tags);
  });

  it("returns the same array for a case-insensitive duplicate", () => {
    const tags = ["VIP"];
    expect(addTagToDraft(tags, "vip")).toBe(tags);
  });

  it("returns the same array when the set is at the cap", () => {
    const tags = Array.from({ length: MAX_CONTACT_TAGS }, (_, i) => `t${i}`);
    expect(addTagToDraft(tags, "one-more")).toBe(tags);
  });
});

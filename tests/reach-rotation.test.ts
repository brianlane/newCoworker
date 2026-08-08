import { describe, expect, it } from "vitest";
import {
  rotateReachOrder,
  type ReachRotationCursor
} from "../supabase/functions/_shared/ai_flows/reach_rotation";

/**
 * The reach ladder's round-robin ordering rule (reach_rotation.ts). Amy's
 * case throughout: ladder [Dave, Gabby, Amy] with rotateFirst 2 means Dave
 * and Gabby alternate who rings first and Amy NEVER leaves the last slot.
 */

type Item = { refId: string; name: string };
const DAVE: Item = { refId: "dave-id", name: "Dave Lane" };
const GABBY: Item = { refId: "gabby-id", name: "Gabrielle Mota" };
const AMY: Item = { refId: "amy-id", name: "Amy Laidlaw" };
const LADDER = [DAVE, GABBY, AMY];
const idOf = (i: Item) => i.refId;

const cursor = (
  memberId: string,
  lastReachFirstAt: string | null,
  createdAt = "2026-01-01T00:00:00Z"
): ReachRotationCursor => ({ memberId, lastReachFirstAt, createdAt });

describe("rotateReachOrder", () => {
  it("puts the least-recently-first teammate first; the last resort never moves", () => {
    const cursors = [
      cursor("dave-id", "2026-08-08T10:00:00Z"),
      cursor("gabby-id", "2026-08-08T09:00:00Z")
    ];
    expect(rotateReachOrder(LADDER, 2, cursors, idOf)).toEqual([GABBY, DAVE, AMY]);
  });

  it("alternates across consecutive calls as the stamp advances", () => {
    const afterGabbyRangFirst = [
      cursor("dave-id", "2026-08-08T10:00:00Z"),
      cursor("gabby-id", "2026-08-08T11:00:00Z")
    ];
    expect(rotateReachOrder(LADDER, 2, afterGabbyRangFirst, idOf)).toEqual([DAVE, GABBY, AMY]);
  });

  it("a teammate who never rang first is owed the first turn", () => {
    const cursors = [cursor("dave-id", "2026-08-08T10:00:00Z"), cursor("gabby-id", null)];
    expect(rotateReachOrder(LADDER, 2, cursors, idOf)[0]).toEqual(GABBY);
    // Same when the cursor row is missing entirely (fresh roster member).
    expect(rotateReachOrder(LADDER, 2, [cursor("dave-id", "2026-08-08T10:00:00Z")], idOf)[0]).toEqual(
      GABBY
    );
  });

  it("breaks null-vs-null and equal-stamp ties deterministically", () => {
    // Both null: roster created_at decides.
    const bothNull = [
      cursor("dave-id", null, "2026-02-01T00:00:00Z"),
      cursor("gabby-id", null, "2026-01-01T00:00:00Z")
    ];
    expect(rotateReachOrder(LADDER, 2, bothNull, idOf)[0]).toEqual(GABBY);
    // Equal stamps AND equal created_at: authored position holds.
    const equal = [
      cursor("dave-id", "2026-08-08T10:00:00Z"),
      cursor("gabby-id", "2026-08-08T10:00:00Z")
    ];
    expect(rotateReachOrder(LADDER, 2, equal, idOf)).toEqual([DAVE, GABBY, AMY]);
  });

  it("rotateFirst 3 rotates the whole ladder", () => {
    const cursors = [
      cursor("dave-id", "2026-08-08T10:00:00Z"),
      cursor("gabby-id", "2026-08-08T09:00:00Z"),
      cursor("amy-id", "2026-08-08T08:00:00Z")
    ];
    expect(rotateReachOrder(LADDER, 3, cursors, idOf)).toEqual([AMY, GABBY, DAVE]);
  });

  it("returns the authored order untouched when there is nothing to rotate", () => {
    expect(rotateReachOrder(LADDER, undefined, [], idOf)).toEqual(LADDER);
    expect(rotateReachOrder(LADDER, 1, [], idOf)).toEqual(LADDER);
    // Window larger than the list: nothing sensible to do, keep authored.
    expect(rotateReachOrder([DAVE, GABBY], 3, [], idOf)).toEqual([DAVE, GABBY]);
    // Non-integer windows floor (2.9 -> 2).
    expect(
      rotateReachOrder(LADDER, 2.9, [cursor("dave-id", "2026-08-08T10:00:00Z")], idOf)[0]
    ).toEqual(GABBY);
  });

  it("never mutates the input", () => {
    const input = [...LADDER];
    rotateReachOrder(input, 2, [cursor("dave-id", "2026-08-08T10:00:00Z")], idOf);
    expect(input).toEqual(LADDER);
  });
});

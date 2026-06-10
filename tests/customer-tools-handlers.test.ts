/**
 * Direct tests for the branches of the shared customer-tool cores that the
 * route-level suites can't reach: the voice adapters validate phone shape
 * before calling, and the note/stamp caps make `note_too_long` unreachable
 * through the 1500-char route schema.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/customer-memory/db", () => ({
  getCustomerMemory: vi.fn(),
  recordInteractionAndIncrement: vi.fn(),
  updateCustomerOwnerFields: vi.fn()
}));

import {
  appendCustomerPinnedNote,
  lookupCustomerByPhone,
  PINNED_MAX_CHARS
} from "@/lib/customer-tools/handlers";
import { getCustomerMemory, updateCustomerOwnerFields } from "@/lib/customer-memory/db";

const BIZ = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("lookupCustomerByPhone", () => {
  it("treats a malformed phone (spotty-CNAM 'anonymous') as nobody on file", async () => {
    const result = await lookupCustomerByPhone(BIZ, "anonymous");
    expect(result).toEqual({ ok: true, data: { found: false } });
    expect(vi.mocked(getCustomerMemory)).not.toHaveBeenCalled();
  });
});

describe("appendCustomerPinnedNote", () => {
  it("refuses a single note that alone exceeds the pinned_md cap", async () => {
    const result = await appendCustomerPinnedNote(
      BIZ,
      "+15551230000",
      "x".repeat(PINNED_MAX_CHARS),
      "sms",
      "chat"
    );
    expect(result).toEqual({ ok: false, detail: "note_too_long" });
    expect(vi.mocked(updateCustomerOwnerFields)).not.toHaveBeenCalled();
  });
});

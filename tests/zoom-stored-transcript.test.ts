import { beforeEach, describe, expect, it, vi } from "vitest";

const createSupabaseServiceClient = vi.fn();
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: (...args: unknown[]) => createSupabaseServiceClient(...args)
}));

import { fetchStoredTranscript } from "@/lib/zoom/stored-transcript";

/**
 * Reading back the original VTT. Every failure answers with an empty
 * transcript rather than throwing: the caller is correcting a document, and
 * losing the speaker labels costs it a better guess at the wrong name, not
 * the correction itself.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const PATH = `${BIZ}/doc/zoom-meeting-1.vtt`;

function storage(result: Record<string, unknown>) {
  return {
    storage: {
      from: () => ({ download: async () => result })
    }
  };
}

beforeEach(() => {
  createSupabaseServiceClient.mockReset();
});

describe("fetchStoredTranscript", () => {
  it("returns the stored file's text", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      storage({ data: { text: async () => "WEBVTT\n" }, error: null }) as never
    );
    await expect(fetchStoredTranscript(BIZ, PATH)).resolves.toBe("WEBVTT\n");
  });

  it("skips the round trip entirely for a document with no stored file", async () => {
    await expect(fetchStoredTranscript(BIZ, "  ")).resolves.toBe("");
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("answers empty when the object is gone", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      storage({ data: null, error: { message: "not found" } }) as never
    );
    await expect(fetchStoredTranscript(BIZ, PATH)).resolves.toBe("");
  });

  it("answers empty when the download returns nothing without an error", async () => {
    createSupabaseServiceClient.mockResolvedValue(
      storage({ data: null, error: null }) as never
    );
    await expect(fetchStoredTranscript(BIZ, PATH)).resolves.toBe("");
  });

  it("answers empty when the client itself cannot be built", async () => {
    createSupabaseServiceClient.mockRejectedValue(new Error("no env"));
    await expect(fetchStoredTranscript(BIZ, PATH)).resolves.toBe("");
  });

  it("answers empty when the thrown value is not an Error", async () => {
    createSupabaseServiceClient.mockRejectedValue("raw string");
    await expect(fetchStoredTranscript(BIZ, PATH)).resolves.toBe("");
  });
});

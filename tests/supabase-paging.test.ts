import { describe, expect, it } from "vitest";
import { fetchAllPaged, SUPABASE_PAGE_SIZE } from "@/lib/supabase/paging";

/**
 * `fetchAllPaged` exists because PostgREST caps a response at 1000 rows
 * silently. Its whole value is the distinction between "this is everything"
 * and "this is a floor", so that distinction is what these tests pin: a short
 * page ends paging, a full run keeps going, and `truncated` is set only when
 * rows really do exist past the ceiling.
 */

/** A fake table of `total` rows, served through the inclusive [from, to] contract. */
function pagedSource(total: number) {
  const calls: Array<[number, number]> = [];
  const fetchPage = (from: number, to: number) => {
    calls.push([from, to]);
    const count = Math.max(0, Math.min(to, total - 1) - from + 1);
    return Promise.resolve({ data: Array.from({ length: count }, (_, i) => ({ n: from + i })), error: null });
  };
  return { calls, fetchPage };
}

describe("fetchAllPaged", () => {
  it("returns a single short page without asking for a second", async () => {
    const { calls, fetchPage } = pagedSource(3);
    const result = await fetchAllPaged(fetchPage, { label: "t" });
    expect(result.rows).toHaveLength(3);
    expect(result.truncated).toBe(false);
    expect(calls).toEqual([[0, SUPABASE_PAGE_SIZE - 1]]);
  });

  it("keeps paging past the row cap that would otherwise silently truncate", async () => {
    const { calls, fetchPage } = pagedSource(SUPABASE_PAGE_SIZE + 5);
    const result = await fetchAllPaged(fetchPage, { label: "t" });
    expect(result.rows).toHaveLength(SUPABASE_PAGE_SIZE + 5);
    expect(result.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[1][0]).toBe(SUPABASE_PAGE_SIZE);
  });

  it("reports truncated when rows really do exist past the ceiling", async () => {
    const { fetchPage } = pagedSource(10_000);
    const result = await fetchAllPaged(fetchPage, { label: "t", maxRows: SUPABASE_PAGE_SIZE * 2 });
    expect(result.rows).toHaveLength(SUPABASE_PAGE_SIZE * 2);
    expect(result.truncated).toBe(true);
  });

  it("does NOT report truncated for a source holding exactly maxRows", async () => {
    // The edge case worth naming: filling every page is not evidence of more
    // rows. Warning here would tell the caller a complete count is a floor.
    const { fetchPage } = pagedSource(SUPABASE_PAGE_SIZE * 2);
    const result = await fetchAllPaged(fetchPage, { label: "t", maxRows: SUPABASE_PAGE_SIZE * 2 });
    expect(result.rows).toHaveLength(SUPABASE_PAGE_SIZE * 2);
    expect(result.truncated).toBe(false);
  });

  it("treats a null data page as the end of the source", async () => {
    const result = await fetchAllPaged<{ n: number }>(() => Promise.resolve({ data: null, error: null }), {
      label: "t"
    });
    expect(result).toEqual({ rows: [], truncated: false });
  });

  it("surfaces a page error with its label instead of returning partial rows", async () => {
    await expect(
      fetchAllPaged(() => Promise.resolve({ data: null, error: { message: "boom" } }), { label: "some_table" })
    ).rejects.toThrow("some_table: boom");
  });

  it("treats a null probe response as no rows past the ceiling", async () => {
    let call = 0;
    const fetchPage = (from: number, to: number) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          data: Array.from({ length: to - from + 1 }, (_, i) => ({ n: from + i })),
          error: null
        });
      }
      return Promise.resolve({ data: null, error: null });
    };
    const result = await fetchAllPaged(fetchPage, { label: "t", maxRows: SUPABASE_PAGE_SIZE });
    expect(result.rows).toHaveLength(SUPABASE_PAGE_SIZE);
    expect(result.truncated).toBe(false);
  });

  it("surfaces an error raised by the past-the-end probe", async () => {
    let call = 0;
    const fetchPage = (from: number, to: number) => {
      call += 1;
      if (call === 1) {
        return Promise.resolve({
          data: Array.from({ length: to - from + 1 }, (_, i) => ({ n: from + i })),
          error: null
        });
      }
      return Promise.resolve({ data: null, error: { message: "probe failed" } });
    };
    await expect(fetchAllPaged(fetchPage, { label: "t", maxRows: SUPABASE_PAGE_SIZE })).rejects.toThrow(
      "t: probe failed"
    );
  });
});

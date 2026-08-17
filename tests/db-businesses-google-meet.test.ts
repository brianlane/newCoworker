import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { isGoogleMeetEnabled, updateGoogleMeetEnabled } from "@/lib/db/businesses";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

const BIZ = "11111111-1111-4111-8111-111111111111";

/** Read chain: from().select().eq().maybeSingle() */
function readDb(result: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn().mockResolvedValue(result);
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  return { db: { from } as never, from, select, eq, maybeSingle };
}

/** Write chain: from().update().eq() */
function writeDb(error: unknown = null) {
  const eq = vi.fn().mockResolvedValue({ error });
  const update = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ update }));
  return { db: { from } as never, from, update, eq };
}

describe("isGoogleMeetEnabled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("reads only the one column it needs, for the right business", async () => {
    const m = readDb({ data: { google_meet_enabled: true }, error: null });
    await expect(isGoogleMeetEnabled(BIZ, m.db)).resolves.toBe(true);
    expect(m.from).toHaveBeenCalledWith("businesses");
    expect(m.select).toHaveBeenCalledWith("google_meet_enabled");
    expect(m.eq).toHaveBeenCalledWith("id", BIZ);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("is false when the owner has not opted in", async () => {
    const m = readDb({ data: { google_meet_enabled: false }, error: null });
    await expect(isGoogleMeetEnabled(BIZ, m.db)).resolves.toBe(false);
  });

  it("fails CLOSED on a read error, a missing row, and a null column", async () => {
    // A DB hiccup must degrade to "book without a video link", never to
    // sending a conference request on behalf of a tenant who never asked.
    const errored = readDb({ data: null, error: { message: "boom" } });
    await expect(isGoogleMeetEnabled(BIZ, errored.db)).resolves.toBe(false);

    const missing = readDb({ data: null, error: null });
    await expect(isGoogleMeetEnabled(BIZ, missing.db)).resolves.toBe(false);

    const nulled = readDb({ data: { google_meet_enabled: null }, error: null });
    await expect(isGoogleMeetEnabled(BIZ, nulled.db)).resolves.toBe(false);
  });

  it("falls back to the service client when no client is passed", async () => {
    const m = readDb({ data: { google_meet_enabled: true }, error: null });
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(m.db);
    await expect(isGoogleMeetEnabled(BIZ)).resolves.toBe(true);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("updateGoogleMeetEnabled", () => {
  beforeEach(() => vi.clearAllMocks());

  it("writes the flag for the right business", async () => {
    const m = writeDb();
    await updateGoogleMeetEnabled(BIZ, true, m.db);
    expect(m.from).toHaveBeenCalledWith("businesses");
    expect(m.update).toHaveBeenCalledWith({ google_meet_enabled: true });
    expect(m.eq).toHaveBeenCalledWith("id", BIZ);
  });

  it("throws on a write error, so the toggle can roll back", async () => {
    const m = writeDb({ message: "denied" });
    await expect(updateGoogleMeetEnabled(BIZ, false, m.db)).rejects.toThrow(
      "updateGoogleMeetEnabled: denied"
    );
  });

  it("falls back to the service client when no client is passed", async () => {
    const m = writeDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(m.db);
    await updateGoogleMeetEnabled(BIZ, true);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

import { describe, expect, it, vi } from "vitest";
import { terminateOtherSessions } from "@/lib/auth/terminate-other-sessions";

describe("terminateOtherSessions", () => {
  it("signs out other sessions and keeps the current one", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: null });
    await terminateOtherSessions({ auth: { signOut } });
    expect(signOut).toHaveBeenCalledWith({ scope: "others" });
  });

  it("throws when Supabase returns an error", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: { message: "boom" } });
    await expect(terminateOtherSessions({ auth: { signOut } })).rejects.toThrow("boom");
  });

  it("uses a fallback message when Supabase omits one", async () => {
    const signOut = vi.fn().mockResolvedValue({ error: {} });
    await expect(terminateOtherSessions({ auth: { signOut } })).rejects.toThrow(
      "Failed to terminate other sessions"
    );
  });
});

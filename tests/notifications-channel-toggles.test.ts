import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  CHANNEL_TOGGLE_KEYS,
  allChannelTogglesOff
} from "@/lib/notifications/channel-toggles";
import {
  NOTIFICATION_TOGGLE_KEYS,
  type NotificationToggleKey
} from "@/lib/notifications/preferences-tool";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));

import { updateNotificationPreferences } from "@/lib/db/notification-preferences";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Toggles that narrow what an already-on channel delivers. They are the ONLY
 * members of NOTIFICATION_TOGGLE_KEYS that "unsubscribe from all" leaves
 * alone, so listing them here is what makes the partition test below a real
 * guard rather than a restatement.
 */
const NARROWING_TOGGLE_KEYS: readonly NotificationToggleKey[] = [
  "digest_customer_facing_only",
  "category_leads",
  "category_team",
  "category_system"
];

describe("the channel-toggle list is the whole channel-toggle list", () => {
  it("covers every notification toggle except the narrowing ones", () => {
    // The bug this closes, three times over: whatsapp_urgent, then
    // push_urgent (#1717), then the five chat channels of #1718-#1724, each
    // added to the dashboard's toggle list and to NOTIFICATION_TOGGLE_KEYS
    // but not to the payload that clears them. Nothing broke in delivery
    // (dispatch suppresses on unsubscribed_at alone), so the only symptom
    // was a toggle rendering ON under the "you unsubscribed" banner.
    const expected = NOTIFICATION_TOGGLE_KEYS.filter(
      (key) => !NARROWING_TOGGLE_KEYS.includes(key)
    );
    expect([...CHANNEL_TOGGLE_KEYS].sort()).toEqual([...expected].sort());
  });

  it("keeps the narrowing toggles OUT, so re-subscribing does not widen alerts", () => {
    // Forcing these false would not quiet anything today, and would silently
    // switch a filter off for the owner the moment they came back.
    for (const key of NARROWING_TOGGLE_KEYS) {
      expect(CHANNEL_TOGGLE_KEYS).not.toContain(key);
    }
  });

  it("allChannelTogglesOff sets every one of them to false", () => {
    const off = allChannelTogglesOff();
    expect(Object.keys(off).sort()).toEqual([...CHANNEL_TOGGLE_KEYS].sort());
    expect(Object.values(off).every((v) => v === false)).toBe(true);
  });

  it("returns a fresh object each call, so one caller cannot poison another", () => {
    const first = allChannelTogglesOff();
    const second = allChannelTogglesOff();
    expect(first).not.toBe(second);
    expect(first).toEqual(second);
  });
});

describe("every channel toggle re-subscribes when switched back on", () => {
  beforeEach(() => vi.clearAllMocks());

  /**
   * The mirror image of the payload bug: `updateNotificationPreferences`
   * keeps its own hand-written list of the toggles whose re-enabling clears
   * `unsubscribed_at`. A channel missing from THAT list leaves the owner
   * looking at the unsubscribed banner after switching their channel back
   * on. Driving the shared list through the real function catches a new
   * channel that reaches one list and not the other.
   */
  it.each([...CHANNEL_TOGGLE_KEYS])("%s clears unsubscribed_at", async (key) => {
    const starting = {
      business_id: "biz-1",
      unsubscribed_at: "2026-05-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z"
    };
    const selectChain = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      maybeSingle: vi.fn().mockResolvedValue({ data: starting, error: null })
    };
    const updateChain = {
      update: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      single: vi.fn().mockResolvedValue({
        data: { ...starting, [key]: true, unsubscribed_at: null },
        error: null
      })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue({
      from: vi.fn().mockReturnValueOnce(selectChain).mockReturnValueOnce(updateChain)
    } as never);

    await updateNotificationPreferences("biz-1", { [key]: true });

    expect(updateChain.update).toHaveBeenCalledWith(
      expect.objectContaining({ [key]: true, unsubscribed_at: null })
    );
  });
});

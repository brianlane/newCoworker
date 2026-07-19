import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient: vi.fn()
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));

import {
  filterSidebarItemsForBusiness,
  SIDEBAR_ITEMS
} from "@/lib/dashboard/sidebar-items";
import {
  deleteSidebarLayout,
  getSidebarLayout,
  mergeSidebarLayout,
  saveSidebarLayout
} from "@/lib/dashboard/sidebar-prefs";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { logger } from "@/lib/logger";

const USER = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SIDEBAR_ITEMS catalog", () => {
  it("has unique keys and locked Settings/Notifications entries", () => {
    const keys = SIDEBAR_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(SIDEBAR_ITEMS.find((i) => i.key === "settings")?.locked).toBe(true);
    expect(SIDEBAR_ITEMS.find((i) => i.key === "notifications")?.locked).toBe(true);
  });

  it("marks the Messenger inbox as Meta-connection-conditional", () => {
    expect(
      SIDEBAR_ITEMS.find((i) => i.key === "messenger")?.requiresMetaConnection
    ).toBe(true);
  });

  it("places Documents directly below Memory", () => {
    const keys = SIDEBAR_ITEMS.map((i) => i.key);
    expect(keys.indexOf("documents")).toBe(keys.indexOf("memory") + 1);
    expect(SIDEBAR_ITEMS.find((i) => i.key === "documents")?.href).toBe(
      "/dashboard/documents"
    );
  });
});

describe("filterSidebarItemsForBusiness", () => {
  it("drops conditional items without a Meta connection and keeps them with one", () => {
    const without = filterSidebarItemsForBusiness(SIDEBAR_ITEMS, {
      metaConnected: false
    });
    expect(without.some((i) => i.key === "messenger")).toBe(false);
    // The WhatsApp item is likewise conditional (dropped when its flag is
    // absent/false); nothing else is affected.
    expect(without.some((i) => i.key === "whatsapp")).toBe(false);
    expect(without).toHaveLength(SIDEBAR_ITEMS.length - 2);

    const withMeta = filterSidebarItemsForBusiness(SIDEBAR_ITEMS, {
      metaConnected: true,
      whatsappConnected: true
    });
    expect(withMeta.some((i) => i.key === "messenger")).toBe(true);
    expect(withMeta.some((i) => i.key === "whatsapp")).toBe(true);
    expect(withMeta).toHaveLength(SIDEBAR_ITEMS.length);
  });

  it("passes merged layouts through, preserving extra fields", () => {
    const layout = mergeSidebarLayout([]);
    const filtered = filterSidebarItemsForBusiness(layout, { metaConnected: false });
    expect(filtered.every((i) => "visible" in i)).toBe(true);
    expect(filtered.some((i) => i.key === "messenger")).toBe(false);
  });
});

describe("mergeSidebarLayout", () => {
  it("returns the default catalog (all visible) with no stored rows", () => {
    const layout = mergeSidebarLayout([]);
    expect(layout.map((i) => i.key)).toEqual(SIDEBAR_ITEMS.map((i) => i.key));
    expect(layout.every((i) => i.visible)).toBe(true);
  });

  it("orders by stored position and applies visibility", () => {
    const layout = mergeSidebarLayout([
      { item_key: "chat", position: 0, visible: true },
      { item_key: "dashboard", position: 1, visible: true },
      { item_key: "analytics", position: 2, visible: false }
    ]);
    expect(layout[0].key).toBe("chat");
    expect(layout[1].key).toBe("dashboard");
    expect(layout[2]).toMatchObject({ key: "analytics", visible: false });
  });

  it("appends newly shipped items missing from the saved layout (visible)", () => {
    const layout = mergeSidebarLayout([{ item_key: "chat", position: 0, visible: true }]);
    expect(layout[0].key).toBe("chat");
    // Everything else follows in default order, visible.
    expect(layout).toHaveLength(SIDEBAR_ITEMS.length);
    expect(layout.slice(1).every((i) => i.visible)).toBe(true);
    expect(layout.slice(1).map((i) => i.key)).toEqual(
      SIDEBAR_ITEMS.filter((i) => i.key !== "chat").map((i) => i.key)
    );
  });

  it("drops unknown keys (removed nav items) and duplicate rows", () => {
    const layout = mergeSidebarLayout([
      { item_key: "retired-page", position: 0, visible: true },
      { item_key: "chat", position: 1, visible: true },
      { item_key: "chat", position: 2, visible: false }
    ]);
    expect(layout.filter((i) => i.key === "chat")).toHaveLength(1);
    expect(layout[0]).toMatchObject({ key: "chat", visible: true });
    expect(layout.some((i) => i.key === "retired-page")).toBe(false);
  });

  it("forces locked items visible even when a stale row hid them", () => {
    const layout = mergeSidebarLayout([{ item_key: "settings", position: 0, visible: false }]);
    expect(layout[0]).toMatchObject({ key: "settings", visible: true });
  });
});

describe("getSidebarLayout", () => {
  it("reads the user's rows and merges them", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({
        data: [{ item_key: "billing", position: 0, visible: true }],
        error: null
      })
    };
    const layout = await getSidebarLayout(USER, db as never);
    expect(layout[0].key).toBe("billing");
    expect(db.from).toHaveBeenCalledWith("user_sidebar_items");
    expect(db.eq).toHaveBeenCalledWith("user_id", USER);
  });

  it("degrades to the default catalog (warn-logged) on read errors — nav must never break", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: null, error: { message: "rls" } })
    };
    const layout = await getSidebarLayout(USER, db as never);
    expect(layout.map((i) => i.key)).toEqual(SIDEBAR_ITEMS.map((i) => i.key));
    expect(logger.warn).toHaveBeenCalledWith(
      "getSidebarLayout failed; serving default nav",
      expect.objectContaining({ userId: USER })
    );
  });

  it("handles a null data payload and non-Error throws, and falls back to the service client", async () => {
    const db = {
      from: vi.fn().mockReturnThis(),
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ data: null, error: null })
    };
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    const layout = await getSidebarLayout(USER);
    expect(layout).toHaveLength(SIDEBAR_ITEMS.length);
    expect(createSupabaseServiceClient).toHaveBeenCalled();

    vi.mocked(createSupabaseServiceClient).mockRejectedValueOnce("raw failure" as never);
    const fallback = await getSidebarLayout(USER);
    expect(fallback).toHaveLength(SIDEBAR_ITEMS.length);
    expect(logger.warn).toHaveBeenCalledWith(
      "getSidebarLayout failed; serving default nav",
      expect.objectContaining({ error: "raw failure" })
    );
  });
});

describe("saveSidebarLayout", () => {
  function upsertDb(error: { message: string } | null = null) {
    return {
      from: vi.fn().mockReturnThis(),
      upsert: vi.fn().mockResolvedValue({ error })
    };
  }

  it("upserts rows with positions from array order and forces locked items visible", async () => {
    const db = upsertDb();
    await saveSidebarLayout(
      USER,
      [
        { key: "chat", visible: true },
        { key: "settings", visible: false },
        { key: "analytics", visible: false }
      ],
      db as never
    );
    expect(db.from).toHaveBeenCalledWith("user_sidebar_items");
    const rows = db.upsert.mock.calls[0][0] as Array<Record<string, unknown>>;
    expect(rows.map((r) => [r.item_key, r.position, r.visible])).toEqual([
      ["chat", 0, true],
      ["settings", 1, true],
      ["analytics", 2, false]
    ]);
    expect(rows.every((r) => r.user_id === USER)).toBe(true);
    expect(db.upsert.mock.calls[0][1]).toEqual({ onConflict: "user_id,item_key" });
  });

  it("rejects unknown and duplicate keys", async () => {
    const db = upsertDb();
    await expect(
      saveSidebarLayout(USER, [{ key: "not-a-page", visible: true }], db as never)
    ).rejects.toThrow('unknown item key "not-a-page"');
    await expect(
      saveSidebarLayout(
        USER,
        [
          { key: "chat", visible: true },
          { key: "chat", visible: false }
        ],
        db as never
      )
    ).rejects.toThrow('duplicate item key "chat"');
    expect(db.upsert).not.toHaveBeenCalled();
  });

  it("is a no-op for an empty list and throws on upsert errors", async () => {
    const db = upsertDb();
    await saveSidebarLayout(USER, [], db as never);
    expect(db.upsert).not.toHaveBeenCalled();

    const failing = upsertDb({ message: "denied" });
    await expect(
      saveSidebarLayout(USER, [{ key: "chat", visible: true }], failing as never)
    ).rejects.toThrow("saveSidebarLayout: denied");
  });

  it("falls back to the service client when none is provided", async () => {
    const db = upsertDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await saveSidebarLayout(USER, [{ key: "chat", visible: true }]);
    expect(createSupabaseServiceClient).toHaveBeenCalled();
  });
});

describe("deleteSidebarLayout", () => {
  function deleteDb(error: { message: string } | null = null) {
    return {
      from: vi.fn().mockReturnThis(),
      delete: vi.fn().mockReturnThis(),
      eq: vi.fn().mockResolvedValue({ error })
    };
  }

  it("deletes the user's rows (reset to default catalog)", async () => {
    const db = deleteDb();
    await deleteSidebarLayout(USER, db as never);
    expect(db.from).toHaveBeenCalledWith("user_sidebar_items");
    expect(db.delete).toHaveBeenCalled();
    expect(db.eq).toHaveBeenCalledWith("user_id", USER);
    expect(createSupabaseServiceClient).not.toHaveBeenCalled();
  });

  it("falls back to the service client and throws on delete errors", async () => {
    const db = deleteDb();
    vi.mocked(createSupabaseServiceClient).mockResolvedValue(db as never);
    await deleteSidebarLayout(USER);
    expect(createSupabaseServiceClient).toHaveBeenCalled();

    const failing = deleteDb({ message: "denied" });
    await expect(deleteSidebarLayout(USER, failing as never)).rejects.toThrow(
      "deleteSidebarLayout: denied"
    );
  });
});

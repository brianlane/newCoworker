/**
 * Per-user sidebar customization (order + visibility), modeled on BizBlasts'
 * UserSidebarItem: rows in `user_sidebar_items` keyed by (auth user id,
 * item key) with a position and a visible flag. Merge semantics:
 *
 *   - Stored rows order the nav (by position); unknown keys (removed nav
 *     items) are dropped silently.
 *   - Catalog items MISSING from the stored set are appended in default
 *     order, visible — so newly shipped pages show up for users with saved
 *     layouts instead of being invisible forever.
 *   - Locked items (Settings, Notifications) are always visible regardless
 *     of what a stale row says, so a user can never hide the page that
 *     hosts the customizer.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { SIDEBAR_ITEMS, type SidebarItemDef } from "@/lib/dashboard/sidebar-items";
import { logger } from "@/lib/logger";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

export type StoredSidebarItem = {
  item_key: string;
  position: number;
  visible: boolean;
};

export type SidebarLayoutItem = SidebarItemDef & { visible: boolean };

/** Pure merge of stored rows over the catalog — see module doc. */
export function mergeSidebarLayout(stored: StoredSidebarItem[]): SidebarLayoutItem[] {
  const byKey = new Map(SIDEBAR_ITEMS.map((item) => [item.key, item]));
  const out: SidebarLayoutItem[] = [];
  const seen = new Set<string>();
  for (const row of [...stored].sort((a, b) => a.position - b.position)) {
    const def = byKey.get(row.item_key);
    if (!def || seen.has(row.item_key)) continue;
    seen.add(row.item_key);
    out.push({ ...def, visible: def.locked ? true : row.visible });
  }
  for (const def of SIDEBAR_ITEMS) {
    if (!seen.has(def.key)) out.push({ ...def, visible: true });
  }
  return out;
}

/**
 * The user's resolved sidebar layout. Read failures degrade to the default
 * catalog (warn-logged) — nav must never break over a prefs table hiccup.
 */
export async function getSidebarLayout(
  userId: string,
  client?: SupabaseClient
): Promise<SidebarLayoutItem[]> {
  try {
    const db = client ?? (await createSupabaseServiceClient());
    const { data, error } = await db
      .from("user_sidebar_items")
      .select("item_key, position, visible")
      .eq("user_id", userId);
    if (error) throw new Error(error.message);
    return mergeSidebarLayout((data ?? []) as StoredSidebarItem[]);
  } catch (err) {
    logger.warn("getSidebarLayout failed; serving default nav", {
      userId,
      error: err instanceof Error ? err.message : String(err)
    });
    return mergeSidebarLayout([]);
  }
}

/**
 * Persist a full layout (ordered array of key + visible). Unknown keys are
 * rejected (the editor only submits catalog keys); positions come from the
 * array order. Locked items are stored as visible regardless of input.
 */
export async function saveSidebarLayout(
  userId: string,
  items: Array<{ key: string; visible: boolean }>,
  client?: SupabaseClient
): Promise<void> {
  const catalog = new Map(SIDEBAR_ITEMS.map((item) => [item.key, item]));
  const seen = new Set<string>();
  const rows: Array<{
    user_id: string;
    item_key: string;
    position: number;
    visible: boolean;
    updated_at: string;
  }> = [];
  const now = new Date().toISOString();
  for (const item of items) {
    const def = catalog.get(item.key);
    if (!def) throw new Error(`saveSidebarLayout: unknown item key "${item.key}"`);
    if (seen.has(item.key)) throw new Error(`saveSidebarLayout: duplicate item key "${item.key}"`);
    seen.add(item.key);
    rows.push({
      user_id: userId,
      item_key: item.key,
      position: rows.length,
      visible: def.locked ? true : item.visible,
      updated_at: now
    });
  }
  if (rows.length === 0) return;
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("user_sidebar_items")
    .upsert(rows, { onConflict: "user_id,item_key" });
  if (error) throw new Error(`saveSidebarLayout: ${error.message}`);
}

/**
 * Reset the user's sidebar to the default catalog by deleting their stored
 * rows — a true reset: with no rows, future catalog additions render in
 * default position instead of being appended after a stale saved order.
 */
export async function deleteSidebarLayout(userId: string, client?: SupabaseClient): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db.from("user_sidebar_items").delete().eq("user_id", userId);
  if (error) throw new Error(`deleteSidebarLayout: ${error.message}`);
}

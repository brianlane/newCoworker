"use client";

/**
 * Admin "Deleted items" card for one business.
 *
 * Owner delete actions on the dashboard are SOFT (deleted_at stamp) but
 * look hard to the tenant; this panel is the only place the stamped rows
 * surface — newest deletion first, with a one-click Restore that clears the
 * stamp (central + tenant box for residency tenants) and puts the item
 * straight back in the owner's dashboard. Restores are audit-logged
 * server-side. Rows disappear from here for good once the retention sweep
 * or a privacy erasure hard-deletes them.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import type { DeletedItem } from "@/lib/admin/deleted-items";

const TYPE_LABEL: Record<DeletedItem["type"], string> = {
  notification: "Notification",
  email: "Email",
  call: "Call",
  sms_conversation: "SMS conversation",
  chat_thread: "Chat thread"
};

export function DeletedItemsPanel({ businessId }: { businessId: string }) {
  const [items, setItems] = useState<DeletedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [restoringKey, setRestoringKey] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/deleted-items?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      );
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "Couldn't load deleted items");
        setItems(null);
        return;
      }
      setItems(json.data.items as DeletedItem[]);
    } catch {
      setError("Network error");
      setItems(null);
    }
  }, [businessId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function restore(item: DeletedItem) {
    const key = `${item.type}:${item.id}`;
    setRestoringKey(key);
    setError(null);
    setMessage(null);
    try {
      const res = await fetch("/api/admin/deleted-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, action: "restore", type: item.type, id: item.id })
      });
      const json = await res.json();
      if (!res.ok || !json.ok) {
        setError(json.error?.message ?? "Restore failed");
        return;
      }
      setMessage(
        `Restored ${TYPE_LABEL[item.type].toLowerCase()} (${json.data?.restored ?? 0} row${
          (json.data?.restored ?? 0) === 1 ? "" : "s"
        }) — it's back in the owner's dashboard.`
      );
      await load();
    } catch {
      setError("Network error");
    } finally {
      setRestoringKey(null);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-parchment/50">
        Items the owner deleted from their dashboard (soft-deleted, admin-restorable). Restoring
        puts the item straight back; rows vanish from this list permanently once retention or a
        privacy erasure hard-deletes them.
      </p>
      {items === null && !error && <p className="text-xs text-parchment/40">Loading…</p>}
      {error && <p className="text-xs text-spark-orange">{error}</p>}
      {message && <p className="text-xs text-signal-teal">{message}</p>}
      {items !== null && items.length === 0 && (
        <p className="text-xs text-parchment/40">Nothing deleted.</p>
      )}
      {items !== null && items.length > 0 && (
        <ul className="divide-y divide-parchment/10">
          {items.map((item) => {
            const key = `${item.type}:${item.id}`;
            return (
              <li key={key} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm text-parchment/90">
                    <span className="mr-2 rounded bg-parchment/10 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-parchment/60">
                      {TYPE_LABEL[item.type]}
                    </span>
                    {item.summary}
                  </p>
                  <p className="mt-0.5 text-[11px] text-parchment/40">
                    deleted {new Date(item.deletedAt).toLocaleString()}
                    {item.deletedBy ? ` · by ${item.deletedBy.slice(0, 8)}…` : ""}
                  </p>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void restore(item)}
                  loading={restoringKey === key}
                >
                  Restore
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

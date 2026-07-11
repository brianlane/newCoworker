"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { SidebarLayoutItem } from "@/lib/dashboard/sidebar-prefs";

type Status = { kind: "idle" | "saving" | "success" | "error"; message?: string };

/**
 * Settings → sidebar customization (BizBlasts-style): reorder nav entries
 * with up/down controls and hide pages you never use. Locked entries
 * (Settings, Notifications) can move but not hide.
 */
export function SidebarCustomizer({ initialLayout }: { initialLayout: SidebarLayoutItem[] }) {
  const router = useRouter();
  const [items, setItems] = useState(initialLayout);
  const [status, setStatus] = useState<Status>({ kind: "idle" });

  function move(index: number, delta: -1 | 1) {
    setItems((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function setVisible(index: number, visible: boolean) {
    setItems((prev) => prev.map((item, i) => (i === index ? { ...item, visible } : item)));
  }

  async function save() {
    setStatus({ kind: "saving" });
    try {
      const res = await fetch("/api/dashboard/sidebar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          items: items.map((item) => ({ key: item.key, visible: item.visible }))
        })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setStatus({ kind: "error", message: json?.error?.message ?? "Save failed." });
        return;
      }
      setStatus({ kind: "success", message: "Sidebar updated." });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Sidebar</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Reorder the navigation and hide pages you don&apos;t use. Settings and Notifications
        always stay visible.
      </p>
      <ul className="space-y-1 mb-4" data-testid="sidebar-customizer-list">
        {items.map((item, index) => (
          <li
            key={item.key}
            className="flex items-center gap-2 rounded-lg border border-parchment/10 px-3 py-1.5"
          >
            <div className="flex flex-col">
              <button
                type="button"
                aria-label={`Move ${item.label} up`}
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="text-parchment/40 hover:text-parchment disabled:opacity-20"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${item.label} down`}
                onClick={() => move(index, 1)}
                disabled={index === items.length - 1}
                className="text-parchment/40 hover:text-parchment disabled:opacity-20"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <span
              className={`flex-1 text-sm ${item.visible ? "text-parchment" : "text-parchment/35 line-through"}`}
            >
              {item.label}
            </span>
            {item.locked ? (
              <span className="text-[10px] uppercase tracking-wider text-parchment/30">
                always shown
              </span>
            ) : (
              <label className="flex items-center gap-1.5 text-xs text-parchment/50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={item.visible}
                  onChange={(e) => setVisible(index, e.target.checked)}
                  className="accent-signal-teal"
                />
                Show
              </label>
            )}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" onClick={() => void save()} loading={status.kind === "saving"}>
          Save sidebar
        </Button>
        {status.kind === "success" && <p className="text-xs text-claw-green">{status.message}</p>}
        {status.kind === "error" && <p className="text-xs text-spark-orange">{status.message}</p>}
      </div>
    </Card>
  );
}

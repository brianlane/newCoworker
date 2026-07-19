"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowDown, ArrowUp, GripVertical } from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";
import type { SidebarLayoutItem } from "@/lib/dashboard/sidebar-prefs";

type Status = { kind: "idle" | "saving" | "resetting" | "success" | "error"; message?: string };

/**
 * Settings → Sidebar (BizBlasts-style): drag rows to reorder the nav and
 * hide pages you never use. The up/down buttons stay as the keyboard- and
 * touch-accessible fallback (HTML5 drag-and-drop doesn't fire on most
 * touch devices). Locked entries (Settings, Notifications) can move but
 * not hide. "Reset to default" deletes the saved layout server-side and
 * restores the untouched catalog order.
 */
export function SidebarCustomizer({
  initialLayout,
  defaultLayout
}: {
  initialLayout: SidebarLayoutItem[];
  defaultLayout: SidebarLayoutItem[];
}) {
  const tNav = useTranslations("dashboard.nav");
  const tSettings = useTranslations("dashboard.settings");
  const router = useRouter();
  const [items, setItems] = useState(initialLayout);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  // Index of the row being dragged; ref (not state) for the drop math so a
  // re-render mid-drag can't stale it, plus state for the visual treatment.
  const dragIndexRef = useRef<number | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [overIndex, setOverIndex] = useState<number | null>(null);

  function move(index: number, delta: -1 | 1) {
    setItems((prev) => {
      const target = index + delta;
      if (target < 0 || target >= prev.length) return prev;
      const next = [...prev];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function moveTo(from: number, to: number) {
    setItems((prev) => {
      if (from === to || from < 0 || from >= prev.length || to < 0 || to >= prev.length) {
        return prev;
      }
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  }

  function handleDragStart(index: number, e: React.DragEvent<HTMLLIElement>) {
    dragIndexRef.current = index;
    setDraggingIndex(index);
    // Firefox requires data for a drag to start; the value is unused.
    e.dataTransfer.setData("text/plain", items[index].key);
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(index: number, e: React.DragEvent<HTMLLIElement>) {
    // Ignore foreign drags (files, text selections, other widgets): without
    // an active sidebar drag there is nothing to drop, so don't
    // preventDefault (no drop cursor) and don't highlight a target row.
    if (dragIndexRef.current === null) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overIndex !== index) setOverIndex(index);
  }

  function handleListDragLeave(e: React.DragEvent<HTMLUListElement>) {
    // Clear the target highlight when the pointer leaves the list entirely
    // mid-drag — otherwise the last hovered row keeps its highlight until
    // the next dragover/drag-end. Moves between rows fire dragleave too, but
    // with relatedTarget still inside the list, so those are ignored.
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setOverIndex(null);
  }

  function handleDrop(index: number, e: React.DragEvent<HTMLLIElement>) {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from !== null) moveTo(from, index);
    resetDrag();
  }

  function resetDrag() {
    dragIndexRef.current = null;
    setDraggingIndex(null);
    setOverIndex(null);
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

  async function resetToDefault() {
    setStatus({ kind: "resetting" });
    try {
      const res = await fetch("/api/dashboard/sidebar", { method: "DELETE" });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string };
      } | null;
      if (!res.ok || !json?.ok) {
        setStatus({ kind: "error", message: json?.error?.message ?? "Reset failed." });
        return;
      }
      setItems(defaultLayout);
      setStatus({ kind: "success", message: tSettings("sidebarResetSuccess") });
      router.refresh();
    } catch {
      setStatus({ kind: "error", message: "Network error. Please try again." });
    }
  }

  return (
    <Card>
      <h2 className="text-sm font-semibold text-parchment mb-1">Sidebar</h2>
      <p className="text-xs text-parchment/40 mb-4">
        Drag to reorder the navigation (or use the arrows) and hide pages you don&apos;t use.
        Settings and Notifications always stay visible.
      </p>
      <ul
        className="space-y-1 mb-4"
        data-testid="sidebar-customizer-list"
        onDragLeave={handleListDragLeave}
      >
        {items.map((item, index) => {
          const label = tNav(item.labelKey);
          return (
          <li
            key={item.key}
            draggable
            onDragStart={(e) => handleDragStart(index, e)}
            onDragOver={(e) => handleDragOver(index, e)}
            onDrop={(e) => handleDrop(index, e)}
            onDragEnd={resetDrag}
            className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 transition-colors ${
              draggingIndex === index
                ? "border-signal-teal/60 opacity-50"
                : overIndex === index && draggingIndex !== null
                  ? "border-signal-teal/60 bg-signal-teal/5"
                  : "border-parchment/10"
            }`}
          >
            <span
              className="cursor-grab active:cursor-grabbing text-parchment/30 hover:text-parchment/60"
              aria-hidden="true"
              title="Drag to reorder"
            >
              <GripVertical className="h-4 w-4" />
            </span>
            <div className="flex flex-col">
              <button
                type="button"
                aria-label={`Move ${label} up`}
                onClick={() => move(index, -1)}
                disabled={index === 0}
                className="text-parchment/40 hover:text-parchment disabled:opacity-20"
              >
                <ArrowUp className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                aria-label={`Move ${label} down`}
                onClick={() => move(index, 1)}
                disabled={index === items.length - 1}
                className="text-parchment/40 hover:text-parchment disabled:opacity-20"
              >
                <ArrowDown className="h-3.5 w-3.5" />
              </button>
            </div>
            <span
              className={`flex-1 text-sm select-none ${item.visible ? "text-parchment" : "text-parchment/35 line-through"}`}
            >
              {label}
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
          );
        })}
      </ul>
      <div className="flex items-center gap-3">
        <Button
          type="button"
          size="sm"
          onClick={() => void save()}
          loading={status.kind === "saving"}
          disabled={status.kind === "resetting"}
        >
          Save sidebar
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          onClick={() => void resetToDefault()}
          loading={status.kind === "resetting"}
          disabled={status.kind === "saving"}
        >
          {tSettings("sidebarResetButton")}
        </Button>
        {status.kind === "success" && <p className="text-xs text-claw-green">{status.message}</p>}
        {status.kind === "error" && <p className="text-xs text-spark-orange">{status.message}</p>}
      </div>
    </Card>
  );
}

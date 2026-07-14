"use client";

/**
 * Tasks page shell: the Board | List view toggle.
 *
 * Board (default) is the GoHighLevel-style pipeline view (PipelineBoard);
 * List is the original detailed Task Center. The choice persists per
 * browser in localStorage (a personal layout preference, like GHL's kanban
 * controls), read after mount so SSR and the first client paint agree.
 */
import { useEffect, useState } from "react";
import { Columns3, List } from "lucide-react";
import { TaskCenter } from "@/components/dashboard/TaskCenter";
import { PipelineBoard } from "@/components/dashboard/PipelineBoard";

type View = "board" | "list";
const VIEW_STORAGE_KEY = "nc-tasks-view";

export function TasksWorkspace({
  businessId,
  defaultScope,
  hasLinkedEmployee,
  canManagePipelines,
  highlightLead
}: {
  businessId: string;
  defaultScope: "mine" | "all";
  hasLinkedEmployee: boolean;
  canManagePipelines: boolean;
  /** E.164 from ?lead= — the board scrolls to + highlights this lead's card. */
  highlightLead: string | null;
}) {
  // Hydration starts on the default and the effect applies the stored
  // preference (a brief flash beats an SSR/client mismatch) — same pattern
  // as the AiFlows Visual|Classic toggle.
  const [view, setView] = useState<View>("board");

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(VIEW_STORAGE_KEY);
      // One-shot post-mount sync from external storage (the documented
      // exception to the rule): reading localStorage during render would
      // desync SSR markup from the first client paint.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (stored === "list" || stored === "board") setView(stored);
    } catch {
      /* storage unavailable — keep the default */
    }
  }, []);

  const pick = (v: View) => {
    setView(v);
    try {
      window.localStorage.setItem(VIEW_STORAGE_KEY, v);
    } catch {
      /* preference just won't persist */
    }
  };

  return (
    <div className="space-y-4">
      <div className="inline-flex overflow-hidden rounded-md border border-parchment/15">
        {(
          [
            { id: "board" as const, label: "Board", Icon: Columns3 },
            { id: "list" as const, label: "List", Icon: List }
          ] as const
        ).map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => pick(id)}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium transition-colors ${
              view === id
                ? "bg-signal-teal/15 text-signal-teal"
                : "text-parchment/50 hover:text-parchment/80"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
          </button>
        ))}
      </div>

      {view === "board" ? (
        <PipelineBoard
          businessId={businessId}
          defaultScope={defaultScope}
          hasLinkedEmployee={hasLinkedEmployee}
          canManage={canManagePipelines}
          highlightLead={highlightLead}
        />
      ) : (
        <TaskCenter
          businessId={businessId}
          defaultScope={defaultScope}
          hasLinkedEmployee={hasLinkedEmployee}
        />
      )}
    </div>
  );
}

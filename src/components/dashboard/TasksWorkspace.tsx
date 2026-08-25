"use client";

/**
 * Tasks page shell: the Board | List | Data | Deals | To-dos view toggle.
 *
 * Board (default) is the GoHighLevel-style pipeline view (PipelineBoard);
 * List is the original detailed Task Center; Data is the Airtable-style
 * lead grid (LeadDataGrid); Deals is the money view (DealsBoard, fixed
 * status columns); To-dos is the assignable work list (TodosPanel). The
 * choice persists per browser in localStorage (a personal layout
 * preference, like GHL's kanban controls), read after mount so SSR and the
 * first client paint agree.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Columns3, DollarSign, List, ListTodo, Table2 } from "lucide-react";
import { TaskCenter } from "@/components/dashboard/TaskCenter";
import { PipelineBoard } from "@/components/dashboard/PipelineBoard";
import { LeadDataGrid } from "@/components/dashboard/LeadDataGrid";
import { DealsBoard } from "@/components/dashboard/DealsBoard";
import { TodosPanel } from "@/components/dashboard/TodosPanel";

type View = "board" | "list" | "data" | "deals" | "todos";
const VIEW_STORAGE_KEY = "nc-tasks-view";

export function TasksWorkspace({
  businessId,
  defaultScope,
  hasLinkedEmployee,
  canManagePipelines,
  canDismissRuns,
  highlightLead
}: {
  businessId: string;
  defaultScope: "mine" | "all";
  hasLinkedEmployee: boolean;
  canManagePipelines: boolean;
  /** Manager+ (manage_aiflows), gates the list view's Dismiss-task action. */
  canDismissRuns: boolean;
  /** E.164 from ?lead=, the board scrolls to + highlights this lead's card. */
  highlightLead: string | null;
}) {
  const t = useTranslations("dashboard.tasksData");
  const tDeals = useTranslations("dashboard.deals");
  const tTodos = useTranslations("dashboard.todos");
  // Hydration starts on the default and the effect applies the stored
  // preference (a brief flash beats an SSR/client mismatch), same pattern
  // as the AiFlows Visual|Classic toggle.
  const [view, setView] = useState<View>("board");
  // `?view=` wins over the stored preference, so the Tables directory can
  // deep-link straight at the Leads, Deals, or To-dos view instead of
  // dropping the visitor on whichever tab they last used.
  const searchParams = useSearchParams();
  const requestedView = searchParams.get("view");

  useEffect(() => {
    try {
      const stored = requestedView ?? window.localStorage.getItem(VIEW_STORAGE_KEY);
      // One-shot post-mount sync from external storage (the documented
      // exception to the rule): reading localStorage during render would
      // desync SSR markup from the first client paint.
      if (
        stored === "list" ||
        stored === "board" ||
        stored === "data" ||
        stored === "deals" ||
        stored === "todos"
      ) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setView(stored);
        // A deep link is also a choice worth remembering, same as a click.
        if (requestedView) window.localStorage.setItem(VIEW_STORAGE_KEY, stored);
      }
    } catch {
      /* storage unavailable, keep the default */
    }
  }, [requestedView]);

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
            { id: "board" as const, label: t("viewBoard"), Icon: Columns3 },
            { id: "list" as const, label: t("viewList"), Icon: List },
            { id: "data" as const, label: t("viewData"), Icon: Table2 },
            { id: "deals" as const, label: tDeals("tab"), Icon: DollarSign },
            { id: "todos" as const, label: tTodos("tab"), Icon: ListTodo }
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
      ) : view === "data" ? (
        <LeadDataGrid
          businessId={businessId}
          defaultScope={defaultScope}
          hasLinkedEmployee={hasLinkedEmployee}
          canManage={canManagePipelines}
        />
      ) : view === "deals" ? (
        <DealsBoard businessId={businessId} canManage={canManagePipelines} />
      ) : view === "todos" ? (
        <TodosPanel businessId={businessId} canManage={canManagePipelines} />
      ) : (
        <TaskCenter
          businessId={businessId}
          defaultScope={defaultScope}
          hasLinkedEmployee={hasLinkedEmployee}
          canDismissRuns={canDismissRuns}
        />
      )}
    </div>
  );
}

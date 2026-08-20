"use client";

/**
 * To-dos list (/dashboard/tasks, To-dos view).
 *
 * A flat work list over the business's to-dos: newest due date first, with
 * open / overdue / done filter chips and an assignee filter (the same roster
 * the lead card editor's Owner dropdown offers). Overdue is derived
 * client-side from the shared predicate (due in the past, not completed) and
 * flagged on the row; nothing is stored for it.
 *
 * Managers (manage_settings) get a quick-add row (title + optional due,
 * assignee, linked contact/deal), the completion checkbox, and a small modal
 * editor; staff see the list read-only, same split as the deals board.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Briefcase, Pencil, Plus, RefreshCw, User, X } from "lucide-react";
import { Card } from "@/components/ui/Card";
import {
  MAX_TODO_DETAILS_LENGTH,
  MAX_TODO_TITLE_LENGTH,
  applyTodoCompletion,
  isTodoOverdue,
  type Todo,
  type TodoListView,
  type TodoStatusFilter
} from "@/lib/todos/core";
import type { TodoWithRefs } from "@/lib/todos/db";

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

async function readEnvelope<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error?.message ?? "Request failed");
  }
  return json.data;
}

type RosterOption = { id: string; name: string };
type DealOption = { id: string; title: string };

/** ISO instant → the viewer-local "Tue, Aug 25, 2:00 PM" (year only when
 * it isn't the current one), for row labels and the editor summary. */
function dueLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(sameYear ? {} : { year: "numeric" })
  });
}

/** ISO instant → the value a datetime-local input holds (viewer-local). */
function isoToLocalInput(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

/** datetime-local value → ISO instant (null for empty/unparseable). */
function localInputToIso(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function TodosPanel({
  businessId,
  canManage
}: {
  businessId: string;
  canManage: boolean;
}) {
  const t = useTranslations("dashboard.todos");
  /** The loaded rows AND the chip they were loaded under, kept together so a
   * late completion response is judged against the list actually on screen. */
  const [list, setList] = useState<TodoListView<TodoWithRefs> | null>(null);
  const [employees, setEmployees] = useState<RosterOption[]>([]);
  const [dealOptions, setDealOptions] = useState<DealOption[]>([]);
  const [status, setStatus] = useState<TodoStatusFilter>("open");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<TodoWithRefs | null>(null);
  /** Monotonic fetch counter: only the LATEST load may write state, so a
   * slow earlier response can never overwrite a newer filter's list. */
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ businessId, status });
      if (assigneeFilter) params.set("assigneeEmployeeId", assigneeFilter);
      const data = await fetch(`/api/dashboard/todos?${params.toString()}`, {
        cache: "no-store"
      }).then((r) => readEnvelope<{ todos: TodoWithRefs[]; employees: RosterOption[] }>(r));
      if (seq !== loadSeq.current) return;
      // Stamped with the chip THIS fetch asked for, not whatever the chip
      // reads at the moment the rows land.
      setList({ status, rows: data.todos });
      setEmployees(data.employees);
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setError(e instanceof Error ? e.message : t("loadFailed"));
      setList(null);
    } finally {
      if (seq === loadSeq.current) setLoading(false);
    }
  }, [businessId, status, assigneeFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Deal titles for the link dropdowns; a blip just leaves the list empty
  // (the to-dos themselves still render their linked deal's title).
  useEffect(() => {
    void fetch(`/api/dashboard/deals?businessId=${encodeURIComponent(businessId)}`, {
      cache: "no-store"
    })
      .then((r) => readEnvelope<{ deals: DealOption[] }>(r))
      .then((data) => setDealOptions(data.deals.map((d) => ({ id: d.id, title: d.title }))))
      .catch(() => setDealOptions([]));
  }, [businessId]);

  const toggleComplete = useCallback(
    async (todo: TodoWithRefs) => {
      setActionError(null);
      setBusyId(todo.id);
      try {
        const data = await fetch(
          `/api/dashboard/todos/${encodeURIComponent(todo.id)}?businessId=${encodeURIComponent(businessId)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ completed: todo.completedAt === null })
          }
        ).then((r) => readEnvelope<{ todo: Todo }>(r));
        // Merge the authoritative row (the PATCH response carries no resolved
        // refs, keep the row's), then drop it when it no longer belongs under
        // the chip. Read out of the updater, so the chip is the one the list
        // on screen belongs to at the moment this response lands: the user
        // can switch chips mid-request, and judging membership by the chip
        // captured when the request went out hid rows the newer list had
        // just legitimately loaded. A row that list does not hold is left
        // alone, so this can never write over a newer fetch either.
        setList((cur) => (cur ? applyTodoCompletion(cur, data.todo) : cur));
      } catch (e) {
        setActionError(e instanceof Error ? e.message : t("updateFailed"));
      } finally {
        setBusyId(null);
      }
    },
    [businessId, t]
  );

  const chips: { id: TodoStatusFilter; label: string }[] = [
    { id: "open", label: t("filterOpen") },
    { id: "overdue", label: t("filterOverdue") },
    { id: "done", label: t("filterDone") }
  ];

  if (error) {
    // The retry control lives right on the error card: without it a failed
    // first load stranded the panel until the user left and came back.
    return (
      <Card>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm text-spark-orange">{error}</p>
          <button
            onClick={() => void load()}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </button>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex overflow-hidden rounded-md border border-parchment/15">
          {chips.map((chip) => (
            <button
              key={chip.id}
              onClick={() => setStatus(chip.id)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                status === chip.id
                  ? "bg-signal-teal/15 text-signal-teal"
                  : "text-parchment/50 hover:text-parchment/80"
              }`}
            >
              {chip.label}
            </button>
          ))}
        </div>
        <select
          value={assigneeFilter}
          onChange={(e) => setAssigneeFilter(e.target.value)}
          aria-label={t("filterAssignee")}
          className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment/80"
        >
          <option value="">{t("assigneeAll")}</option>
          {employees.map((m) => (
            <option key={m.id} value={m.id}>
              {m.name}
            </option>
          ))}
        </select>
        <div className="ml-auto">
          <button
            onClick={() => void load()}
            className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment"
            aria-label={t("refresh")}
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} />
            {t("refresh")}
          </button>
        </div>
      </div>

      {canManage && (
        <QuickAddRow
          businessId={businessId}
          employees={employees}
          dealOptions={dealOptions}
          onAdded={() => void load()}
        />
      )}

      {actionError && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-spark-orange">{actionError}</p>
            <button
              onClick={() => setActionError(null)}
              className="text-parchment/40 hover:text-parchment"
              aria-label={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      {list !== null && list.rows.length === 0 && (
        <Card>
          <div className="space-y-3 py-4 text-center">
            <p className="text-sm text-parchment/60">{t("empty")}</p>
            {!canManage && <p className="text-xs text-parchment/40">{t("askManager")}</p>}
          </div>
        </Card>
      )}

      {list !== null && list.rows.length > 0 && (
        <div className="divide-y divide-parchment/10 overflow-hidden rounded-lg border border-parchment/10 bg-parchment/5">
          {list.rows.map((todo) => {
            const overdue = isTodoOverdue(todo);
            const assignee = todo.assigneeEmployeeId
              ? employees.find((m) => m.id === todo.assigneeEmployeeId)?.name ?? null
              : null;
            return (
              <div
                key={todo.id}
                className={`flex items-start gap-3 px-3 py-2.5 ${
                  overdue ? "border-l-2 border-l-spark-orange bg-spark-orange/5" : ""
                }`}
              >
                <input
                  type="checkbox"
                  checked={todo.completedAt !== null}
                  disabled={!canManage || busyId === todo.id}
                  onChange={() => void toggleComplete(todo)}
                  aria-label={todo.completedAt === null ? t("markDone") : t("markOpen")}
                  className="mt-0.5 h-4 w-4 shrink-0 accent-claw-green disabled:opacity-40"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span
                      className={`truncate text-sm font-medium ${
                        todo.completedAt !== null
                          ? "text-parchment/40 line-through"
                          : "text-parchment"
                      }`}
                      title={todo.title}
                    >
                      {todo.title}
                    </span>
                    {overdue && (
                      <span className="shrink-0 rounded-full bg-spark-orange/15 px-1.5 py-0.5 text-[10px] font-semibold text-spark-orange">
                        {t("overdueBadge")}
                      </span>
                    )}
                    {canManage && (
                      <button
                        type="button"
                        data-testid="todo-row-edit"
                        onClick={() => setEditing(todo)}
                        className="ml-auto shrink-0 text-parchment/30 hover:text-signal-teal"
                        aria-label={t("editTodo")}
                        title={t("editTodo")}
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  {todo.details && (
                    <p className="mt-0.5 truncate text-[11px] text-parchment/50" title={todo.details}>
                      {todo.details}
                    </p>
                  )}
                  <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[11px] text-parchment/50">
                    {todo.dueAt ? (
                      <span className={overdue ? "font-medium text-spark-orange" : ""}>
                        {t("due", { date: dueLabel(todo.dueAt) })}
                      </span>
                    ) : (
                      <span className="text-parchment/30">{t("noDueDate")}</span>
                    )}
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {assignee ?? t("unassigned")}
                    </span>
                    {todo.contactE164 && (
                      <Link
                        href={`/dashboard/customers/${encodeURIComponent(todo.contactE164)}`}
                        className="hover:text-signal-teal hover:underline"
                        title={todo.contactName ?? todo.contactE164}
                      >
                        {todo.contactName ?? todo.contactE164}
                      </Link>
                    )}
                    {todo.dealTitle && (
                      <span className="inline-flex items-center gap-1" title={todo.dealTitle}>
                        <Briefcase className="h-3 w-3" />
                        {todo.dealTitle}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <TodoEditorModal
          businessId={businessId}
          todo={editing}
          employees={employees}
          dealOptions={dealOptions}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </div>
  );
}

type ContactHit = { id: string; customerE164: string; displayName: string | null };

/** Compact contact typeahead over /api/dashboard/customers, shared by the
 * quick-add row and the editor modal (same endpoint the deals editor uses). */
function ContactPicker({
  businessId,
  contactId,
  contactLabel,
  onPick,
  onClear,
  inputClass
}: {
  businessId: string;
  contactId: string | null;
  contactLabel: string | null;
  onPick: (id: string, label: string) => void;
  onClear: () => void;
  inputClass: string;
}) {
  const t = useTranslations("dashboard.todos");
  const [search, setSearch] = useState("");
  const [hits, setHits] = useState<ContactHit[]>([]);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    const q = search.trim();
    // Everything (including clearing on an emptied box) runs inside the
    // debounce callback, never synchronously in the effect body, so the
    // set-state-in-effect rule's cascading-render concern does not apply.
    searchTimer.current = setTimeout(() => {
      if (!q) {
        setHits([]);
        return;
      }
      void fetch(
        `/api/dashboard/customers?businessId=${encodeURIComponent(businessId)}&search=${encodeURIComponent(q)}&limit=8`,
        { cache: "no-store" }
      )
        .then((r) => readEnvelope<{ customers: ContactHit[] }>(r))
        .then((data) => setHits(data.customers))
        .catch(() => setHits([]));
    }, 250);
    return () => {
      if (searchTimer.current) clearTimeout(searchTimer.current);
    };
  }, [search, businessId]);

  if (contactId) {
    return (
      <div className="flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-full bg-parchment/10 px-2 py-1 text-xs text-parchment/80">
          <User className="h-3 w-3" />
          {contactLabel}
        </span>
        <button
          type="button"
          onClick={onClear}
          className="text-parchment/40 hover:text-parchment"
          aria-label={t("clearContact")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    );
  }
  return (
    <div className="relative">
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder={t("contactSearchPlaceholder")}
        className={inputClass}
        aria-label={t("editContact")}
      />
      {hits.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-40 w-full overflow-y-auto rounded-md border border-parchment/15 bg-deep-ink">
          {hits.map((hit) => (
            <button
              key={hit.id}
              type="button"
              onClick={() => {
                onPick(hit.id, hit.displayName ?? hit.customerE164);
                setSearch("");
                setHits([]);
              }}
              className="block w-full truncate px-2 py-1.5 text-left text-xs text-parchment/80 hover:bg-parchment/10"
            >
              {hit.displayName ?? hit.customerE164}
              {hit.displayName ? (
                <span className="text-parchment/40"> · {hit.customerE164}</span>
              ) : null}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The one-line create form: title + optional due / assignee / links. */
function QuickAddRow({
  businessId,
  employees,
  dealOptions,
  onAdded
}: {
  businessId: string;
  employees: RosterOption[];
  dealOptions: DealOption[];
  onAdded: () => void;
}) {
  const t = useTranslations("dashboard.todos");
  const [title, setTitle] = useState("");
  const [dueLocal, setDueLocal] = useState("");
  const [assigneeId, setAssigneeId] = useState("");
  const [dealId, setDealId] = useState("");
  const [contactId, setContactId] = useState<string | null>(null);
  const [contactLabel, setContactLabel] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const inputClass =
    "rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30";

  const add = async () => {
    // Guarded here, not just on the button: the title input's Enter key
    // reaches this too, and a double Enter must not double-create.
    if (busy) return;
    const trimmed = title.trim();
    if (!trimmed) {
      setFormError(t("titleRequired"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await fetch(`/api/dashboard/todos?businessId=${encodeURIComponent(businessId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: trimmed,
          ...(dueLocal ? { dueAt: localInputToIso(dueLocal) } : {}),
          ...(assigneeId ? { assigneeEmployeeId: assigneeId } : {}),
          ...(contactId ? { contactId } : {}),
          ...(dealId ? { dealId } : {})
        })
      }).then((r) => readEnvelope<unknown>(r));
      setTitle("");
      setDueLocal("");
      setAssigneeId("");
      setDealId("");
      setContactId(null);
      setContactLabel(null);
      onAdded();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("addFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="space-y-2">
        {formError && <p className="text-xs text-spark-orange">{formError}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void add();
            }}
            maxLength={MAX_TODO_TITLE_LENGTH}
            placeholder={t("quickAddPlaceholder")}
            aria-label={t("editTitle")}
            className={`${inputClass} min-w-48 flex-1`}
          />
          <input
            type="datetime-local"
            value={dueLocal}
            onChange={(e) => setDueLocal(e.target.value)}
            aria-label={t("editDue")}
            className={inputClass}
          />
          <select
            value={assigneeId}
            onChange={(e) => setAssigneeId(e.target.value)}
            aria-label={t("editAssignee")}
            className={inputClass}
          >
            <option value="">{t("unassigned")}</option>
            {employees.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <ContactPicker
            businessId={businessId}
            contactId={contactId}
            contactLabel={contactLabel}
            onPick={(id, label) => {
              setContactId(id);
              setContactLabel(label);
            }}
            onClear={() => {
              setContactId(null);
              setContactLabel(null);
            }}
            inputClass={`${inputClass} w-44`}
          />
          <select
            value={dealId}
            onChange={(e) => setDealId(e.target.value)}
            aria-label={t("editDeal")}
            className={`${inputClass} max-w-40`}
          >
            <option value="">{t("noDeal")}</option>
            {dealOptions.map((d) => (
              <option key={d.id} value={d.id}>
                {d.title}
              </option>
            ))}
          </select>
          <button
            onClick={() => void add()}
            disabled={busy || !title.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
          >
            <Plus className="h-3.5 w-3.5" />
            {busy ? t("quickAddAdding") : t("quickAddAdd")}
          </button>
        </div>
      </div>
    </Card>
  );
}

/** Edit one to-do in a modal, the same overlay treatment as the deals
 * editor: full fields plus delete. */
function TodoEditorModal({
  businessId,
  todo,
  employees,
  dealOptions,
  onClose,
  onSaved
}: {
  businessId: string;
  todo: TodoWithRefs;
  employees: RosterOption[];
  dealOptions: DealOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const t = useTranslations("dashboard.todos");
  const [title, setTitle] = useState(todo.title);
  const [details, setDetails] = useState(todo.details ?? "");
  const [dueLocal, setDueLocal] = useState(isoToLocalInput(todo.dueAt));
  const [assigneeId, setAssigneeId] = useState(todo.assigneeEmployeeId ?? "");
  const [dealId, setDealId] = useState(todo.dealId ?? "");
  const [contactId, setContactId] = useState<string | null>(todo.contactId);
  const [contactLabel, setContactLabel] = useState<string | null>(
    todo.contactId ? todo.contactName ?? todo.contactE164 : null
  );
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const inputClass =
    "w-full rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-sm text-parchment placeholder:text-parchment/30";

  const save = async () => {
    const trimmed = title.trim();
    if (!trimmed) {
      setFormError(t("titleRequired"));
      return;
    }
    setBusy(true);
    setFormError(null);
    try {
      await fetch(
        `/api/dashboard/todos/${encodeURIComponent(todo.id)}?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: trimmed,
            details: details.trim() ? details : null,
            dueAt: localInputToIso(dueLocal),
            assigneeEmployeeId: assigneeId || null,
            contactId,
            dealId: dealId || null
          })
        }
      ).then((r) => readEnvelope<unknown>(r));
      onSaved();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("updateFailed"));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(t("deleteConfirm", { title: todo.title }))) return;
    setBusy(true);
    setFormError(null);
    try {
      await fetch(
        `/api/dashboard/todos/${encodeURIComponent(todo.id)}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE", headers: { "Content-Type": "application/json" } }
      ).then((r) => readEnvelope<unknown>(r));
      onSaved();
    } catch (e) {
      setFormError(e instanceof Error ? e.message : t("deleteFailed"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-label={t("editTodo")}
    >
      <div
        className="w-full max-w-lg rounded-xl border border-parchment/15 bg-deep-ink p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-parchment">{t("editTodo")}</h3>
          <button
            onClick={onClose}
            className="text-parchment/40 hover:text-parchment"
            aria-label={t("editCancel")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3">
          {formError && <p className="text-sm text-spark-orange">{formError}</p>}

          <div>
            <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="todo-title">
              {t("editTitle")}
            </label>
            <input
              id="todo-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              maxLength={MAX_TODO_TITLE_LENGTH}
              className={inputClass}
            />
          </div>

          <div>
            <label
              className="mb-1 block text-xs font-medium text-parchment/60"
              htmlFor="todo-details"
            >
              {t("editDetails")}
            </label>
            <textarea
              id="todo-details"
              value={details}
              onChange={(e) => setDetails(e.target.value)}
              maxLength={MAX_TODO_DETAILS_LENGTH}
              rows={3}
              placeholder={t("detailsPlaceholder")}
              className={inputClass}
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="todo-due">
                {t("editDue")}
              </label>
              <input
                id="todo-due"
                type="datetime-local"
                value={dueLocal}
                onChange={(e) => setDueLocal(e.target.value)}
                className={inputClass}
              />
            </div>
            <div>
              <label
                className="mb-1 block text-xs font-medium text-parchment/60"
                htmlFor="todo-assignee"
              >
                {t("editAssignee")}
              </label>
              <select
                id="todo-assignee"
                value={assigneeId}
                onChange={(e) => setAssigneeId(e.target.value)}
                className={inputClass}
              >
                <option value="">{t("unassigned")}</option>
                {employees.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <span className="mb-1 block text-xs font-medium text-parchment/60">
              {t("editContact")}
            </span>
            <ContactPicker
              businessId={businessId}
              contactId={contactId}
              contactLabel={contactLabel}
              onPick={(id, label) => {
                setContactId(id);
                setContactLabel(label);
              }}
              onClear={() => {
                setContactId(null);
                setContactLabel(null);
              }}
              inputClass={inputClass}
            />
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-parchment/60" htmlFor="todo-deal">
              {t("editDeal")}
            </label>
            <select
              id="todo-deal"
              value={dealId}
              onChange={(e) => setDealId(e.target.value)}
              className={inputClass}
            >
              <option value="">{t("noDeal")}</option>
              {/* A linked deal missing from the open list (e.g. beyond the
                  list cap) stays selectable so saving never silently unlinks. */}
              {todo.dealId && !dealOptions.some((d) => d.id === todo.dealId) && (
                <option value={todo.dealId}>{todo.dealTitle ?? t("editDeal")}</option>
              )}
              {dealOptions.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.title}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center justify-between gap-2 pt-1">
            <button
              onClick={() => void remove()}
              disabled={busy}
              className="rounded-md border border-spark-orange/40 px-2.5 py-1.5 text-xs text-spark-orange hover:bg-spark-orange/10 disabled:opacity-40"
            >
              {t("editDelete")}
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                disabled={busy}
                className="rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment disabled:opacity-40"
              >
                {t("editCancel")}
              </button>
              <button
                onClick={() => void save()}
                disabled={busy || !title.trim()}
                className="rounded-lg bg-claw-green px-4 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:opacity-50"
              >
                {busy ? t("editSaving") : t("editSave")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

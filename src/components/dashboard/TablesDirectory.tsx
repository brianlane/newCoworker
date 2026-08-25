"use client";

/**
 * The Tables index: every dataset the business has, in two groups.
 *
 * "Tables you made" open here. "Tables you already have" (Leads, Contacts,
 * Deals, To-dos, Documents, Employees, Bookings) are listed here and open at
 * their OWN page, with a footer that says so rather than pretending to open
 * in place. One dataset, one canonical URL.
 *
 * The built-in group is not a nav duplicate: its cards carry live row counts,
 * which is the thing no existing page shows you side by side.
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  ArrowUpRight,
  CalendarClock,
  ClipboardList,
  DollarSign,
  FileText,
  Home,
  ListTodo,
  Package,
  Plus,
  RotateCcw,
  Shield,
  Table2,
  Tag,
  Truck,
  Users,
  UserCog,
  Wrench,
  X,
  type LucideIcon
} from "lucide-react";
import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import {
  CUSTOM_TABLE_TRASH_RETENTION_DAYS,
  MAX_TABLES_PER_BUSINESS,
  type CustomTable,
  type CustomTableIcon
} from "@/lib/custom-tables/types";

type Props = { businessId: string; canManage: boolean };

type ApiEnvelope<T> = { ok: boolean; data?: T; error?: { message?: string } };

async function readEnvelope<T>(res: Response): Promise<T> {
  const json = (await res.json()) as ApiEnvelope<T>;
  if (!res.ok || !json.ok || !json.data) {
    throw new Error(json.error?.message ?? "Request failed");
  }
  return json.data;
}

/** Static map, never a computed key: the i18n key-usage test only sees
 * literals, and a template key would silently render MISSING_MESSAGE. */
const TABLE_ICONS: Record<CustomTableIcon, LucideIcon> = {
  table: Table2,
  home: Home,
  truck: Truck,
  wrench: Wrench,
  package: Package,
  shield: Shield,
  clipboard: ClipboardList,
  tag: Tag
};

/**
 * The datasets the platform already keeps. `where` is the destination's own
 * name, so the footer reads "Open in Tasks" rather than implying this page
 * owns the data.
 */
const BUILT_IN = [
  { key: "leads", href: "/dashboard/tasks?view=data", Icon: Table2, where: "Tasks" },
  { key: "contacts", href: "/dashboard/customers", Icon: Users, where: "Contacts" },
  { key: "deals", href: "/dashboard/tasks?view=deals", Icon: DollarSign, where: "Tasks" },
  { key: "todos", href: "/dashboard/tasks?view=todos", Icon: ListTodo, where: "Tasks" },
  { key: "documents", href: "/dashboard/documents", Icon: FileText, where: "Documents" },
  { key: "employees", href: "/dashboard/employees", Icon: UserCog, where: "Employees" },
  { key: "bookings", href: "/dashboard/bookings", Icon: CalendarClock, where: "Bookings" }
] as const;

const BUILT_IN_NAME_KEY = {
  leads: "builtInLeadsName",
  contacts: "builtInContactsName",
  deals: "builtInDealsName",
  todos: "builtInTodosName",
  documents: "builtInDocumentsName",
  employees: "builtInEmployeesName",
  bookings: "builtInBookingsName"
} as const;

const BUILT_IN_BLURB_KEY = {
  leads: "builtInLeadsBlurb",
  contacts: "builtInContactsBlurb",
  deals: "builtInDealsBlurb",
  todos: "builtInTodosBlurb",
  documents: "builtInDocumentsBlurb",
  employees: "builtInEmployeesBlurb",
  bookings: "builtInBookingsBlurb"
} as const;

export function TablesDirectory({ businessId, canManage }: Props) {
  const t = useTranslations("dashboard.tables");
  const [tables, setTables] = useState<CustomTable[] | null>(null);
  const [deleted, setDeleted] = useState<CustomTable[]>([]);
  const [rowCounts, setRowCounts] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const data = await fetch(
        `/api/dashboard/custom-tables?businessId=${encodeURIComponent(businessId)}`,
        { cache: "no-store" }
      ).then((r) =>
        readEnvelope<{
          tables: CustomTable[];
          rowCounts: Record<string, number>;
          deleted: CustomTable[];
        }>(r)
      );
      setTables(data.tables);
      setRowCounts(data.rowCounts ?? {});
      setDeleted(data.deleted ?? []);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("loadFailed"));
      setTables(null);
    }
  }, [businessId, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const restore = async (tableId: string) => {
    setRestoringId(tableId);
    setError(null);
    try {
      await fetch(
        `/api/dashboard/custom-tables/${encodeURIComponent(tableId)}?businessId=${encodeURIComponent(businessId)}`,
        { method: "POST" }
      ).then((r) => readEnvelope<unknown>(r));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("restoreFailed"));
    } finally {
      setRestoringId(null);
    }
  };

  const atCap = (tables?.length ?? 0) >= MAX_TABLES_PER_BUSINESS;

  return (
    <div className="space-y-8">
      {error && (
        <Card>
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-spark-orange">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-parchment/40 hover:text-parchment"
              aria-label={t("dismiss")}
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </Card>
      )}

      <section className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-parchment/40">
            {t("directoryCustomHeading")}
          </h2>
          {canManage && !atCap && (
            <Link
              href="/dashboard/tables/new"
              className="inline-flex items-center gap-1.5 rounded-lg bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              {t("createTable")}
            </Link>
          )}
          {canManage && atCap && (
            <span className="text-[11px] text-parchment/40">
              {t("limitReached", { max: MAX_TABLES_PER_BUSINESS })}
            </span>
          )}
        </div>

        {tables === null && <p className="text-sm text-parchment/50">{t("loading")}</p>}

        {tables !== null && tables.length === 0 && (
          <Card>
            <div className="space-y-2 py-6 text-center">
              <p className="text-sm text-parchment/70">{t("emptyTitle")}</p>
              <p className="mx-auto max-w-xl text-sm text-parchment/50">{t("emptyBody")}</p>
              {!canManage && (
                <p className="text-xs text-parchment/40">{t("askManager")}</p>
              )}
            </div>
          </Card>
        )}

        {tables !== null && tables.length > 0 && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tables.map((table) => {
              const Icon = TABLE_ICONS[table.icon];
              const columns = table.fields.filter((f) => f.enabled).length;
              return (
                <Link
                  key={table.id}
                  href={`/dashboard/tables/${table.id}`}
                  className="rounded-xl border border-parchment/10 bg-deep-ink/75 p-4 transition-colors hover:border-signal-teal/40"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <Icon className="h-4 w-4 text-signal-teal" />
                      <span className="text-sm font-semibold text-parchment">{table.name}</span>
                    </div>
                    <Badge variant={table.rowLink === "contact" ? "info" : "neutral"}>
                      {table.rowLink === "contact" ? t("badgeContactLinked") : t("badgeStandalone")}
                    </Badge>
                  </div>
                  {table.description && (
                    <p className="mt-1.5 line-clamp-2 text-xs text-parchment/50">
                      {table.description}
                    </p>
                  )}
                  <p className="mt-3 text-[11px] text-parchment/40">
                    {t("columnCount", { count: columns })} · {t("rowCount", { count: rowCounts[table.id] ?? 0 })}
                  </p>
                </Link>
              );
            })}
          </div>
        )}
      </section>

      {deleted.length > 0 && canManage && (
        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-parchment/40">
              {t("trashHeading")}
            </h2>
            <p className="mt-1 text-xs text-parchment/40">
              {t("trashBlurb", { days: CUSTOM_TABLE_TRASH_RETENTION_DAYS })}
            </p>
          </div>
          <Card padding="sm">
            <ul className="divide-y divide-parchment/10">
              {deleted.map((table) => (
                <li key={table.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-parchment/70">{table.name}</p>
                    {table.deletedAt && (
                      <p className="text-[11px] text-parchment/40">
                        <LocalDateTime iso={table.deletedAt} />
                      </p>
                    )}
                  </div>
                  <button
                    onClick={() => void restore(table.id)}
                    disabled={restoringId === table.id}
                    className="inline-flex items-center gap-1.5 rounded-md border border-parchment/15 px-2.5 py-1 text-xs text-parchment/70 hover:text-parchment disabled:opacity-40"
                  >
                    <RotateCcw className="h-3 w-3" />
                    {restoringId === table.id ? t("restoring") : t("restore")}
                  </button>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className="space-y-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-parchment/40">
            {t("directoryBuiltInHeading")}
          </h2>
          <p className="mt-1 max-w-2xl text-xs text-parchment/40">{t("directoryBuiltInBlurb")}</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {BUILT_IN.map(({ key, href, Icon, where }) => (
            <Link
              key={key}
              href={href}
              className="flex flex-col rounded-xl border border-parchment/10 bg-deep-ink/50 p-4 transition-colors hover:border-parchment/25"
            >
              <div className="flex items-center gap-2">
                <Icon className="h-4 w-4 text-parchment/50" />
                <span className="text-sm font-semibold text-parchment/80">
                  {t(BUILT_IN_NAME_KEY[key])}
                </span>
              </div>
              <p className="mt-1.5 flex-1 text-xs text-parchment/50">{t(BUILT_IN_BLURB_KEY[key])}</p>
              <span className="mt-3 inline-flex items-center gap-1 text-[11px] text-parchment/40">
                {t("openIn", { where })}
                <ArrowUpRight className="h-3 w-3" />
              </span>
            </Link>
          ))}
        </div>
      </section>
    </div>
  );
}

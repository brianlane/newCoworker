"use client";

import { useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { SearchControl } from "@/components/dashboard/SearchControl";
import { ConversationScroll } from "@/components/dashboard/ConversationScroll";
import { sortRows } from "@/lib/dashboard/sort";
import { usePersistentSort } from "@/components/dashboard/usePersistentSort";
import { matchesQuery } from "@/lib/dashboard/search";
import {
  describeSegmentFilters,
  matchesSegment,
  MAX_SEGMENT_NAME_LENGTH,
  type ContactSegment,
  type SegmentFilters
} from "@/lib/segments/core";

/**
 * One contact row, pre-resolved on the server: `name`/`type` already account for
 * owner/employee/manual-label overrides so the client can sort by display name
 * or type without re-resolving anything. `type` is the unified classification
 * (owner/employee/customer/tester/company/other).
 */
export type CustomerListRow = {
  e164: string;
  name: string;
  type: string;
  lastChannel: string | null;
  pinned: boolean;
  summary: string | null;
  totalInteractions: number;
  lastInteractionAt: string | null;
  /** Free-form owner-defined labels on this contact. */
  tags: string[];
  /** Owning roster member's id (for Smart List matching); null = unowned. */
  ownerEmployeeId: string | null;
  /** Owning roster member's name (resolved server-side); null = unowned. */
  ownerName: string | null;
  createdAt: string;
  updatedAt: string;
};

const CUSTOMER_SORT_OPTIONS: SortOption[] = [
  { key: "lastInteractionAt", label: "Last interaction" },
  { key: "name", label: "Name" },
  { key: "type", label: "Type" },
  { key: "createdAt", label: "Created" },
  { key: "updatedAt", label: "Updated" }
];

// Owner/employee read as identity badges; the rest are plain classifications.
const TYPE_BADGE_CLASS: Record<string, string> = {
  owner: "text-signal-teal/90 bg-signal-teal/10",
  employee: "text-amber-300/80 bg-amber-300/10",
  customer: "text-parchment/60 bg-parchment/10",
  tester: "text-fuchsia-300/80 bg-fuchsia-300/10",
  company: "text-sky-300/80 bg-sky-300/10",
  other: "text-parchment/60 bg-parchment/10"
};

function sortValue(row: CustomerListRow, field: string): string | number | null | undefined {
  if (field === "name") return row.name;
  if (field === "type") return row.type;
  if (field === "createdAt") return row.createdAt;
  if (field === "updatedAt") return row.updatedAt;
  return row.lastInteractionAt;
}

/** The activity choices the Smart List creator offers. */
type ActivityChoice = "any" | "within" | "overdue" | "never";

/** Compose the saved filter object from the creator form's fields. */
function buildSegmentFilters(form: {
  tags: string;
  type: string;
  owner: string;
  activity: ActivityChoice;
  activityDays: number;
  createdDays: string;
}): SegmentFilters {
  const tags = form.tags
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 10);
  const createdDays = Number(form.createdDays);
  return {
    ...(tags.length > 0 ? { tagsAny: tags } : {}),
    ...(form.type ? { type: form.type as NonNullable<SegmentFilters["type"]> } : {}),
    ...(form.owner ? { ownerEmployeeId: form.owner } : {}),
    ...(form.activity === "within"
      ? { lastInteractionWithinDays: form.activityDays }
      : form.activity === "overdue"
        ? { lastInteractionOlderThanDays: form.activityDays }
        : form.activity === "never"
          ? { neverContacted: true }
          : {}),
    ...(form.createdDays.trim() && Number.isFinite(createdDays) && createdDays >= 1
      ? { createdWithinDays: Math.min(365, Math.round(createdDays)) }
      : {})
  };
}

/**
 * Client wrapper for the cross-channel customers index. Sorts the already-
 * loaded page of rows in the browser (default: most-recent interaction first,
 * matching the server query) via the shared SortControl. Smart Lists (saved
 * segments) filter the same loaded rows via the shared pure matcher, with
 * live counts on every chip.
 */
export function CustomersList({
  rows,
  businessId,
  segments: initialSegments = [],
  owners = [],
  canManageSegments = false,
  clipped = false
}: {
  rows: CustomerListRow[];
  businessId?: string;
  segments?: ContactSegment[];
  owners?: Array<{ id: string; name: string }>;
  canManageSegments?: boolean;
  /** True when the directory scan hit its cap — counts are partial. */
  clipped?: boolean;
}) {
  const [sort, setSort] = usePersistentSort(
    "dashboard.contacts.sort",
    { field: "lastInteractionAt", dir: "desc" },
    CUSTOMER_SORT_OPTIONS.map((o) => o.key)
  );
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [ownerFilter, setOwnerFilter] = useState("");
  const [segments, setSegments] = useState<ContactSegment[]>(initialSegments);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const [segmentBusy, setSegmentBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: "",
    tags: "",
    type: "",
    owner: "",
    activity: "any" as ActivityChoice,
    activityDays: 5,
    createdDays: ""
  });

  const saveSegment = async () => {
    if (!businessId) return;
    setSegmentBusy(true);
    setSegmentError(null);
    try {
      const res = await fetch(
        `/api/dashboard/segments?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: createForm.name.trim(),
            filters: buildSegmentFilters(createForm)
          })
        }
      );
      const json = (await res.json()) as {
        ok: boolean;
        data?: { segment: ContactSegment };
        error?: { message: string };
      };
      if (!json.ok || !json.data) {
        setSegmentError(json.error?.message ?? "Could not save the list.");
        return;
      }
      setSegments((prev) => [...prev, json.data!.segment]);
      setSelectedSegmentId(json.data.segment.id);
      setShowCreate(false);
      setCreateForm({
        name: "",
        tags: "",
        type: "",
        owner: "",
        activity: "any",
        activityDays: 5,
        createdDays: ""
      });
    } finally {
      setSegmentBusy(false);
    }
  };

  const deleteSegment = async (segment: ContactSegment) => {
    if (!businessId) return;
    if (!window.confirm(`Delete the "${segment.name}" list? Contacts are untouched.`)) return;
    setSegmentBusy(true);
    setSegmentError(null);
    try {
      const res = await fetch(
        `/api/dashboard/segments/${segment.id}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json()) as { ok: boolean; error?: { message: string } };
      if (!json.ok) {
        setSegmentError(json.error?.message ?? "Could not delete the list.");
        return;
      }
      setSegments((prev) => prev.filter((s) => s.id !== segment.id));
      setSelectedSegmentId((prev) => (prev === segment.id ? null : prev));
    } finally {
      setSegmentBusy(false);
    }
  };

  // Filter option lists come from the loaded rows themselves, so they always
  // reflect labels/owners that actually exist (case-insensitive tag identity).
  const allTags = Array.from(
    new Map(rows.flatMap((r) => r.tags).map((t) => [t.toLowerCase(), t])).values()
  ).sort((a, b) => a.localeCompare(b));
  const allOwners = Array.from(
    new Set(rows.map((r) => r.ownerName).filter((n): n is string => Boolean(n)))
  ).sort((a, b) => a.localeCompare(b));

  const selectedSegment = segments.find((s) => s.id === selectedSegmentId) ?? null;
  const nowMs = Date.now();
  const segmentCount = (s: ContactSegment) =>
    rows.filter((r) => matchesSegment(r, s.filters, nowMs)).length;

  const filtered = rows.filter(
    (r) =>
      (!selectedSegment || matchesSegment(r, selectedSegment.filters, nowMs)) &&
      matchesQuery(query, [r.name, r.e164, r.type, r.summary, r.tags.join(" ")]) &&
      (!tagFilter || r.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) &&
      (!ownerFilter || r.ownerName === ownerFilter)
  );
  const sorted = sortRows(filtered, (r) => sortValue(r, sort.field), sort.dir);

  const chipBase =
    "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs transition-colors";

  return (
    <div className="space-y-2">
      {(segments.length > 0 || canManageSegments) && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={() => setSelectedSegmentId(null)}
            className={`${chipBase} ${
              selectedSegmentId === null
                ? "border-signal-teal bg-signal-teal/10 text-signal-teal"
                : "border-parchment/15 text-parchment/60 hover:border-parchment/40"
            }`}
          >
            All <span className="text-parchment/40">{rows.length}</span>
          </button>
          {segments.map((s) => (
            <span key={s.id} className="inline-flex items-center">
              <button
                onClick={() =>
                  setSelectedSegmentId((prev) => (prev === s.id ? null : s.id))
                }
                title={describeSegmentFilters(s.filters)}
                className={`${chipBase} ${
                  selectedSegmentId === s.id
                    ? "border-signal-teal bg-signal-teal/10 text-signal-teal"
                    : "border-parchment/15 text-parchment/60 hover:border-parchment/40"
                }`}
              >
                {s.name} <span className="text-parchment/40">{segmentCount(s)}</span>
              </button>
              {canManageSegments && (
                <button
                  onClick={() => deleteSegment(s)}
                  disabled={segmentBusy}
                  aria-label={`Delete list ${s.name}`}
                  title="Delete this list"
                  className="ml-0.5 rounded-full px-1 text-xs text-parchment/30 hover:text-rose-300"
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {canManageSegments && (
            <button
              onClick={() => setShowCreate((v) => !v)}
              className={`${chipBase} border-dashed border-parchment/25 text-parchment/50 hover:border-signal-teal hover:text-signal-teal`}
            >
              {showCreate ? "Cancel" : "+ New list"}
            </button>
          )}
        </div>
      )}
      {segmentError && <p className="text-xs text-rose-300/90">{segmentError}</p>}
      {clipped && (
        <p className="text-[11px] text-amber-300/80">
          Large directory — the list and Smart List counts cover the {rows.length.toLocaleString()}{" "}
          most recently active contacts.
        </p>
      )}
      {showCreate && canManageSegments && (
        <Card padding="sm">
          <div className="flex flex-wrap items-end gap-3 text-xs text-parchment/70">
            <label className="flex flex-col gap-1">
              Name
              <input
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                value={createForm.name}
                maxLength={MAX_SEGMENT_NAME_LENGTH}
                placeholder="Hot leads"
                onChange={(ev) => setCreateForm({ ...createForm, name: ev.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              Tags (any of, comma-separated)
              <input
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                value={createForm.tags}
                placeholder="New Lead, Engaged"
                onChange={(ev) => setCreateForm({ ...createForm, tags: ev.target.value })}
              />
            </label>
            <label className="flex flex-col gap-1">
              Type
              <select
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                value={createForm.type}
                onChange={(ev) => setCreateForm({ ...createForm, type: ev.target.value })}
              >
                <option value="">Any type</option>
                {["customer", "tester", "company", "other"].map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Owned by
              <select
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                value={createForm.owner}
                onChange={(ev) => setCreateForm({ ...createForm, owner: ev.target.value })}
              >
                <option value="">Anyone</option>
                <option value="none">No owner</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              Activity
              <select
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                value={createForm.activity}
                onChange={(ev) =>
                  setCreateForm({
                    ...createForm,
                    activity: ev.target.value as ActivityChoice
                  })
                }
              >
                <option value="any">Any</option>
                <option value="within">Active in last N days</option>
                <option value="overdue">No contact in N days</option>
                <option value="never">Never contacted</option>
              </select>
            </label>
            {(createForm.activity === "within" || createForm.activity === "overdue") && (
              <label className="flex flex-col gap-1">
                N days
                <input
                  type="number"
                  min={1}
                  max={365}
                  className="w-20 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                  value={createForm.activityDays}
                  onChange={(ev) =>
                    setCreateForm({
                      ...createForm,
                      activityDays: Math.min(365, Math.max(1, Number(ev.target.value) || 1))
                    })
                  }
                />
              </label>
            )}
            <label className="flex flex-col gap-1">
              Created within days (optional)
              <input
                type="number"
                min={1}
                max={365}
                className="w-24 rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
                value={createForm.createdDays}
                placeholder="7"
                onChange={(ev) =>
                  setCreateForm({ ...createForm, createdDays: ev.target.value })
                }
              />
            </label>
            <button
              onClick={saveSegment}
              disabled={segmentBusy || !createForm.name.trim()}
              className="rounded-md bg-signal-teal px-3 py-1.5 text-xs font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
            >
              Save list
            </button>
          </div>
        </Card>
      )}
      {rows.length === 0 ? (
        <Card>
          <div className="text-center py-8">
            <p className="text-parchment/60">No contacts yet.</p>
            <p className="text-xs text-parchment/40 mt-2">
              Once someone texts or calls (or you add a contact), they&apos;ll appear here.
            </p>
          </div>
        </Card>
      ) : (
        <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SearchControl
          value={query}
          onChange={setQuery}
          placeholder="Search by name or number…"
          idPrefix="customer-search"
        />
        <div className="flex flex-wrap items-center gap-2">
          {allTags.length > 0 && (
            <select
              className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
              value={tagFilter}
              onChange={(ev) => setTagFilter(ev.target.value)}
              aria-label="Filter by tag"
            >
              <option value="">All tags</option>
              {allTags.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          )}
          {allOwners.length > 0 && (
            <select
              className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
              value={ownerFilter}
              onChange={(ev) => setOwnerFilter(ev.target.value)}
              aria-label="Filter by owning employee"
            >
              <option value="">Owned by anyone</option>
              {allOwners.map((n) => (
                <option key={n} value={n}>
                  Owned by {n}
                </option>
              ))}
            </select>
          )}
          <SortControl
            options={CUSTOMER_SORT_OPTIONS}
            field={sort.field}
            dir={sort.dir}
            onChange={setSort}
            idPrefix="customer-sort"
          />
        </div>
      </div>
      <Card padding="sm">
        {sorted.length === 0 && (
          <div className="py-6 text-center text-sm text-parchment/50">
            No contacts match “{query}”.
          </div>
        )}
        {/* Same bounded scroll window as the Emails page inbox list: the
            page stops growing with the contact count and the list scrolls
            in place. Newest-first, so no bottom anchoring. */}
        <ConversationScroll maxHeightClass="max-h-[70vh]" className="pr-1">
        <ul className="divide-y divide-parchment/10">
          {sorted.map((c) => (
            <li key={c.e164}>
              <Link
                href={`/dashboard/customers/${encodeURIComponent(c.e164)}`}
                className="flex items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-parchment truncate">
                      {c.name}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-wide rounded px-1.5 py-0.5 ${
                        TYPE_BADGE_CLASS[c.type] ?? "text-parchment/60 bg-parchment/10"
                      }`}
                    >
                      {c.type}
                    </span>
                    {c.name !== c.e164 && (
                      <span className="text-xs text-parchment/50 font-mono">{c.e164}</span>
                    )}
                    {c.lastChannel && (
                      <span className="text-[10px] uppercase tracking-wide text-parchment/60 bg-parchment/10 rounded px-1.5 py-0.5">
                        {c.lastChannel}
                      </span>
                    )}
                    {c.pinned && (
                      <span
                        className="text-[10px] uppercase tracking-wide text-claw-green/90 bg-claw-green/10 rounded px-1.5 py-0.5"
                        title="Has pinned notes"
                      >
                        pinned
                      </span>
                    )}
                    {c.ownerName && (
                      <span
                        className="text-[10px] tracking-wide text-amber-300/80 bg-amber-300/10 rounded px-1.5 py-0.5"
                        title="Owning employee"
                      >
                        {c.ownerName}&apos;s
                      </span>
                    )}
                    {c.tags.map((t) => (
                      <span
                        key={t}
                        className="text-[10px] tracking-wide text-signal-teal/80 bg-signal-teal/10 rounded px-1.5 py-0.5"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                  {c.summary?.trim() && (
                    <p className="text-xs text-parchment/60 mt-0.5 line-clamp-2">
                      {c.summary.trim()}
                    </p>
                  )}
                  <p className="text-[10px] text-parchment/40 mt-0.5">
                    {c.totalInteractions} interaction
                    {c.totalInteractions === 1 ? "" : "s"}
                    {c.lastInteractionAt && (
                      <>
                        {" • last "}
                        <LocalDateTime iso={c.lastInteractionAt} />
                      </>
                    )}
                  </p>
                </div>
                <span className="text-parchment/40 text-sm shrink-0">View →</span>
              </Link>
            </li>
          ))}
        </ul>
        </ConversationScroll>
      </Card>
        </>
      )}
    </div>
  );
}

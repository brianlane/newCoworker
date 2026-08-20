"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { SortControl, type SortOption } from "@/components/dashboard/SortControl";
import { SearchControl } from "@/components/dashboard/SearchControl";
import { ConversationScroll } from "@/components/dashboard/ConversationScroll";
import { sortRows } from "@/lib/dashboard/sort";
import { usePersistentSort } from "@/components/dashboard/usePersistentSort";
import { matchesQuery } from "@/lib/dashboard/search";
import { contactChannelLabel } from "@/lib/customer-memory/channel-label";
import {
  describeSegmentFilters,
  matchesSegment,
  MAX_SEGMENT_NAME_LENGTH,
  type ContactSegment,
  type SegmentFilters
} from "@/lib/segments/core";
import { BULK_MAX_CONTACTS } from "@/lib/contacts/bulk-constants";
import { selectedContactsCsv } from "@/lib/csv/contacts-export-shape";
import { MAX_CONTACT_TAG_LENGTH } from "@/lib/customer-memory/types";

/**
 * One contact row, pre-resolved on the server: `name`/`type` already account for
 * owner/employee/manual-label overrides so the client can sort by display name
 * or type without re-resolving anything. `type` is the unified classification
 * (owner/employee/customer/tester/company/other).
 */
export type CustomerListRow = {
  e164: string;
  /** The key rendered for a human: an address for email-keyed contacts. */
  label: string;
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
  clipped = false,
  implicitOwner = null,
  canClaim = false
}: {
  rows: CustomerListRow[];
  businessId?: string;
  segments?: ContactSegment[];
  owners?: Array<{ id: string; name: string }>;
  canManageSegments?: boolean;
  /** True when the directory scan hit its cap, counts are partial. */
  clipped?: boolean;
  /**
   * Set when the roster is exactly one ACTIVE member who is provably the
   * business owner (the #1500 implicit-owner rule). Since then every
   * unclaimed row RESOLVES to that person, so a Smart List "No owner"
   * filter can never match anything here; the dead choice is hidden. The
   * "Anyone" default already matches everything, so nothing else changes.
   */
  implicitOwner?: { id: string; name: string } | null;
  /**
   * True when the viewer's login maps to a roster member (the same mapping
   * the claim endpoint applies server-side): unowned rows then show a Claim
   * button. False hides the buttons rather than offering a claim that can
   * only 403.
   */
  canClaim?: boolean;
}) {
  const tBulk = useTranslations("dashboard.bulk");
  const tClaim = useTranslations("dashboard.leadClaim");
  const router = useRouter();
  /** The row key mid-claim ("Claiming…" on exactly that button). */
  const [claimingKey, setClaimingKey] = useState<string | null>(null);
  /** Claim outcome worth telling: lost race ("already claimed by…"), failure. */
  const [claimNotice, setClaimNotice] = useState<string | null>(null);
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
  // Multi-select + bulk action bar. Selection is keyed by the contact key
  // and survives filter changes; the count and every action cover ALL
  // selected rows, visible or not, so "12 selected" always acts on 12.
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [bulkMode, setBulkMode] = useState<null | "add_tag" | "remove_tag" | "assign_owner">(
    null
  );
  const [bulkTag, setBulkTag] = useState("");
  const [bulkRemoveTag, setBulkRemoveTag] = useState("");
  const [bulkOwnerId, setBulkOwnerId] = useState("");
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkOutcome, setBulkOutcome] = useState<null | {
    updated: number;
    failed: number;
    /** The first few failures, for the honesty line under the summary. */
    failures: Array<{ key: string; error: string }>;
  }>(null);

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

  /**
   * Claim an unowned contact for the signed-in teammate. The server does the
   * race-safe null-owner compare-and-swap; a 409 names whoever got there
   * first. router.refresh() re-renders the server-built rows, so the row
   * flips to owned-by-me (or to the race winner) without a manual reload.
   */
  const claimContact = async (contactKey: string) => {
    if (!businessId) return;
    setClaimingKey(contactKey);
    setClaimNotice(null);
    try {
      const res = await fetch(`/api/dashboard/leads/claim`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, contactKey })
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        error?: { message?: string; ownerName?: string | null };
      } | null;
      if (res.status === 409) {
        const name = json?.error?.ownerName;
        setClaimNotice(
          name ? tClaim("alreadyClaimed", { name }) : tClaim("alreadyClaimedUnknown")
        );
        router.refresh();
        return;
      }
      if (!res.ok || !json?.ok) {
        setClaimNotice(json?.error?.message ?? tClaim("claimFailed"));
        return;
      }
      router.refresh();
    } catch {
      setClaimNotice(tClaim("claimFailed"));
    } finally {
      setClaimingKey(null);
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
      matchesQuery(query, [r.name, r.label, r.e164, r.type, r.summary, r.tags.join(" ")]) &&
      (!tagFilter || r.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) &&
      (!ownerFilter || r.ownerName === ownerFilter)
  );
  const sorted = sortRows(filtered, (r) => sortValue(r, sort.field), sort.dir);

  // Bulk selection needs a businessId to post against; the customers page
  // always passes one, so this only hides the checkboxes on a mount that
  // could not act on them anyway.
  const bulkEnabled = Boolean(businessId);
  const selectedRows = rows.filter((r) => selectedKeys.has(r.e164));
  const selectedCount = selectedRows.length;
  const allVisibleSelected = sorted.length > 0 && sorted.every((r) => selectedKeys.has(r.e164));
  const nameByKey = new Map(rows.map((r) => [r.e164, r.name]));
  // The remove-tag picker offers only tags that actually exist on the
  // selected rows (case-insensitive identity, first spelling wins).
  const selectedRowTags = Array.from(
    new Map(
      selectedRows.flatMap((r) => r.tags).map((tag) => [tag.toLowerCase(), tag])
    ).values()
  ).sort((a, b) => a.localeCompare(b));

  const toggleSelected = (key: string) => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAllVisible = () => {
    setSelectedKeys((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const r of sorted) next.delete(r.e164);
      else for (const r of sorted) next.add(r.e164);
      return next;
    });
  };

  const clearSelection = () => {
    setSelectedKeys(new Set());
    setBulkMode(null);
  };

  /**
   * Run one bulk action over every selected contact, after a plain-words
   * confirm. Adding a tag can start automations (AiFlows) for each contact,
   * so that confirm says so; remove/assign get the simple count confirm.
   * Requests go up in server-cap-sized chunks, sequentially, and the
   * outcome reports totals plus the first few failures. Failed contacts
   * stay selected so a retry is one click away.
   */
  const runBulkAction = async (
    body:
      | { action: "add_tag"; tag: string }
      | { action: "remove_tag"; tag: string }
      | { action: "assign_owner"; employeeId: string }
  ) => {
    if (!businessId || selectedRows.length === 0) return;
    const count = selectedRows.length;
    let confirmText: string;
    if (body.action === "add_tag") {
      confirmText = tBulk("confirmAddTag", { tag: body.tag, count });
    } else if (body.action === "remove_tag") {
      confirmText = tBulk("confirmRemoveTag", { tag: body.tag, count });
    } else {
      const ownerName = owners.find((o) => o.id === body.employeeId)?.name ?? "";
      confirmText = tBulk("confirmAssignOwner", { name: ownerName, count });
    }
    if (!window.confirm(confirmText)) return;
    setBulkBusy(true);
    setBulkOutcome(null);
    try {
      const keys = selectedRows.map((r) => r.e164);
      let updated = 0;
      const failures: Array<{ key: string; error: string }> = [];
      for (let i = 0; i < keys.length; i += BULK_MAX_CONTACTS) {
        const chunk = keys.slice(i, i + BULK_MAX_CONTACTS);
        try {
          const res = await fetch(
            `/api/dashboard/contacts/bulk?businessId=${encodeURIComponent(businessId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ ...body, contactKeys: chunk })
            }
          );
          const json = (await res.json().catch(() => null)) as {
            ok?: boolean;
            data?: {
              results: Array<{ key: string; ok: boolean; error?: string }>;
              updated: number;
            };
            error?: { message?: string };
          } | null;
          if (!res.ok || !json?.ok || !json.data) {
            const message = json?.error?.message ?? tBulk("requestFailed");
            for (const key of chunk) failures.push({ key, error: message });
            continue;
          }
          updated += json.data.updated;
          for (const r of json.data.results) {
            if (!r.ok) failures.push({ key: r.key, error: r.error ?? tBulk("requestFailed") });
          }
        } catch {
          for (const key of chunk) failures.push({ key, error: tBulk("requestFailed") });
        }
      }
      setBulkOutcome({ updated, failed: failures.length, failures: failures.slice(0, 3) });
      setSelectedKeys(new Set(failures.map((f) => f.key)));
      setBulkMode(null);
      setBulkTag("");
      setBulkRemoveTag("");
      setBulkOwnerId("");
      router.refresh();
    } finally {
      setBulkBusy(false);
    }
  };

  /** Client-side CSV of the selected rows, in the full export's columns. */
  const exportSelectedCsv = () => {
    if (selectedRows.length === 0) return;
    const csv = selectedContactsCsv(selectedRows);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "contacts-selected.csv";
    a.click();
    URL.revokeObjectURL(a.href);
  };

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
      {claimNotice && (
        <p data-testid="claim-notice" className="text-xs text-rose-300/90">
          {claimNotice}
        </p>
      )}
      {clipped && (
        <p className="text-[11px] text-amber-300/80">
          Large directory, the list and Smart List counts cover the {rows.length.toLocaleString()}{" "}
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
                {!implicitOwner && <option value="none">No owner</option>}
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
        <div className="flex flex-wrap items-center gap-3">
          {bulkEnabled && (
            <label className="flex items-center gap-1.5 text-xs text-parchment/60">
              <input
                type="checkbox"
                checked={allVisibleSelected}
                onChange={toggleAllVisible}
                disabled={bulkBusy}
                className="h-4 w-4 accent-signal-teal"
              />
              {tBulk("selectAllVisible", { count: sorted.length })}
            </label>
          )}
          <SearchControl
            value={query}
            onChange={setQuery}
            placeholder="Search by name or number…"
            idPrefix="customer-search"
          />
        </div>
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
      {bulkEnabled && selectedCount > 0 && (
        <div className="space-y-2 rounded-lg border border-signal-teal/30 bg-signal-teal/5 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="font-semibold text-signal-teal">
              {tBulk("selectedCount", { count: selectedCount })}
            </span>
            <button
              type="button"
              onClick={() => setBulkMode((m) => (m === "add_tag" ? null : "add_tag"))}
              disabled={bulkBusy}
              className={`${chipBase} ${
                bulkMode === "add_tag"
                  ? "border-signal-teal bg-signal-teal/10 text-signal-teal"
                  : "border-parchment/15 text-parchment/70 hover:border-parchment/40"
              }`}
            >
              {tBulk("addTag")}
            </button>
            <button
              type="button"
              onClick={() => setBulkMode((m) => (m === "remove_tag" ? null : "remove_tag"))}
              disabled={bulkBusy}
              className={`${chipBase} ${
                bulkMode === "remove_tag"
                  ? "border-signal-teal bg-signal-teal/10 text-signal-teal"
                  : "border-parchment/15 text-parchment/70 hover:border-parchment/40"
              }`}
            >
              {tBulk("removeTag")}
            </button>
            {owners.length > 0 && (
              <button
                type="button"
                onClick={() =>
                  setBulkMode((m) => (m === "assign_owner" ? null : "assign_owner"))
                }
                disabled={bulkBusy}
                className={`${chipBase} ${
                  bulkMode === "assign_owner"
                    ? "border-signal-teal bg-signal-teal/10 text-signal-teal"
                    : "border-parchment/15 text-parchment/70 hover:border-parchment/40"
                }`}
              >
                {tBulk("assignOwner")}
              </button>
            )}
            <button
              type="button"
              onClick={exportSelectedCsv}
              disabled={bulkBusy}
              className={`${chipBase} border-parchment/15 text-parchment/70 hover:border-parchment/40`}
            >
              {tBulk("exportCsv")}
            </button>
            <button
              type="button"
              onClick={clearSelection}
              disabled={bulkBusy}
              className={`${chipBase} border-parchment/15 text-parchment/50 hover:border-parchment/40`}
            >
              {tBulk("clearSelection")}
            </button>
          </div>
          {bulkMode === "add_tag" && (
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={bulkTag}
                maxLength={MAX_CONTACT_TAG_LENGTH}
                onChange={(ev) => setBulkTag(ev.target.value)}
                placeholder={tBulk("tagPlaceholder")}
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30"
              />
              <button
                type="button"
                onClick={() => void runBulkAction({ action: "add_tag", tag: bulkTag.trim() })}
                disabled={bulkBusy || !bulkTag.trim()}
                className="rounded-md bg-signal-teal px-3 py-1.5 text-xs font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
              >
                {bulkBusy ? tBulk("applying") : tBulk("apply")}
              </button>
              <span className="text-[11px] text-parchment/50">{tBulk("addTagHint")}</span>
            </div>
          )}
          {bulkMode === "remove_tag" && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={bulkRemoveTag}
                onChange={(ev) => setBulkRemoveTag(ev.target.value)}
                aria-label={tBulk("chooseTag")}
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
              >
                <option value="">{tBulk("chooseTag")}</option>
                {selectedRowTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  void runBulkAction({ action: "remove_tag", tag: bulkRemoveTag })
                }
                disabled={bulkBusy || !bulkRemoveTag}
                className="rounded-md bg-signal-teal px-3 py-1.5 text-xs font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
              >
                {bulkBusy ? tBulk("applying") : tBulk("apply")}
              </button>
            </div>
          )}
          {bulkMode === "assign_owner" && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={bulkOwnerId}
                onChange={(ev) => setBulkOwnerId(ev.target.value)}
                aria-label={tBulk("chooseOwner")}
                className="rounded-md border border-parchment/15 bg-deep-ink/40 px-2 py-1.5 text-xs text-parchment"
              >
                <option value="">{tBulk("chooseOwner")}</option>
                {owners.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() =>
                  void runBulkAction({ action: "assign_owner", employeeId: bulkOwnerId })
                }
                disabled={bulkBusy || !bulkOwnerId}
                className="rounded-md bg-signal-teal px-3 py-1.5 text-xs font-semibold text-deep-ink hover:bg-signal-teal/90 disabled:opacity-50"
              >
                {bulkBusy ? tBulk("applying") : tBulk("apply")}
              </button>
            </div>
          )}
        </div>
      )}
      {bulkOutcome && (
        <div className="space-y-0.5 text-xs">
          <p
            className={
              bulkOutcome.failed > 0 ? "text-amber-300/90" : "text-claw-green/90"
            }
          >
            {tBulk("resultSummary", {
              updated: bulkOutcome.updated,
              failed: bulkOutcome.failed
            })}
          </p>
          {bulkOutcome.failures.map((f) => (
            <p key={f.key} className="text-rose-300/90">
              {nameByKey.get(f.key) ?? f.key}: {f.error}
            </p>
          ))}
          {bulkOutcome.failed > bulkOutcome.failures.length && (
            <p className="text-rose-300/90">
              {tBulk("moreFailures", {
                count: bulkOutcome.failed - bulkOutcome.failures.length
              })}
            </p>
          )}
        </div>
      )}
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
          {sorted.map((c) => {
            const channelLabel = contactChannelLabel(c.lastChannel);
            return (
              <li key={c.e164} className="flex items-center gap-1">
                {bulkEnabled && (
                  <input
                    type="checkbox"
                    checked={selectedKeys.has(c.e164)}
                    onChange={() => toggleSelected(c.e164)}
                    disabled={bulkBusy}
                    className="ml-1 h-4 w-4 shrink-0 accent-signal-teal"
                    aria-label={tBulk("selectContact", { name: c.name })}
                  />
                )}
                <Link
                  href={`/dashboard/customers/${encodeURIComponent(c.e164)}`}
                  className="flex min-w-0 flex-1 items-center justify-between gap-4 px-3 py-3 rounded-lg hover:bg-parchment/5 transition-colors"
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
                      {c.name !== c.label && (
                        <span className="text-xs text-parchment/50 font-mono">{c.label}</span>
                      )}
                      {channelLabel && (
                        <span className="text-[10px] uppercase tracking-wide text-parchment/60 bg-parchment/10 rounded px-1.5 py-0.5">
                          {channelLabel}
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
                  {/* Unowned rows (the same rows the Smart List "No owner"
                      filter matches; hidden under an implicit owner because
                      those rows already resolve to somebody, and for roster
                      members' own cards, which are identities, not leads). */}
                  {canClaim &&
                    businessId &&
                    !c.ownerEmployeeId &&
                    c.type !== "owner" &&
                    c.type !== "employee" && (
                      <button
                        type="button"
                        data-testid="customer-claim"
                        // The row is one big profile link; the button must
                        // not navigate it.
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          void claimContact(c.e164);
                        }}
                        disabled={claimingKey === c.e164}
                        className="shrink-0 rounded-md bg-claw-green px-2.5 py-1 text-xs font-semibold text-deep-ink transition-colors hover:bg-opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {claimingKey === c.e164 ? tClaim("claiming") : tClaim("claim")}
                      </button>
                    )}
                  <span className="text-parchment/40 text-sm shrink-0">View →</span>
                </Link>
              </li>
            );
          })}
        </ul>
        </ConversationScroll>
      </Card>
        </>
      )}
    </div>
  );
}

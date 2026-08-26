"use client";

/**
 * Quick editor for one lead, shared by the Tasks page views (inline on a
 * List card, in a modal from a Board card).
 *
 * Edits the fields a working view needs at hand: name, tags, owner, plus
 * delete. Saves go through the same contacts PATCH the profile page uses,
 * so tag automation (tag_changed triggers, goal events) and owner_assigned
 * flows fire identically, and delete is the profile page's delete (texts
 * and calls stay in the per-channel history). Only fields the user actually
 * changed are sent (buildContactPatch), so a derived card name is never
 * stamped into a stored manual label.
 */
import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleMinus, Tag, Trash2 } from "lucide-react";
import { addTagToDraft, buildContactPatch } from "@/lib/contacts/quick-edit";
import { MAX_CONTACT_TAG_LENGTH } from "@/lib/customer-memory/types";

export type RosterOption = { id: string; name: string };

export function LeadQuickEditor({
  businessId,
  contactKey,
  resolvedName,
  initialDisplayName,
  initialTags,
  initialOwnerEmployeeId,
  employees,
  implicitOwnerEmployeeId,
  hasActiveRuns,
  onSaved,
  onDeleted,
  onClose
}: {
  businessId: string;
  /** The contact's key (E.164, short code, or `email:` key). */
  contactKey: string;
  /** The name the card shows (for the delete confirmation text). */
  resolvedName: string;
  /** The RAW stored label; empty when the card's name is derived. */
  initialDisplayName: string | null;
  initialTags: string[];
  /** The owner the card shows (explicit stamp, or the implicit one). */
  initialOwnerEmployeeId: string | null;
  employees: RosterOption[];
  /**
   * Set on a one-person team whose only member is the owner: the editor
   * then drops "Unassigned", which would resolve straight back to them.
   */
  implicitOwnerEmployeeId: string | null;
  /**
   * Whether a workflow is mid-run for this lead: "Remove from tasks" then
   * warns that the card stays in motion until the run ends or is dismissed.
   */
  hasActiveRuns: boolean;
  onSaved: () => void;
  onDeleted: () => void;
  onClose: () => void;
}) {
  const t = useTranslations("dashboard.tasksData");
  const [name, setName] = useState(initialDisplayName ?? "");
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagDraft, setTagDraft] = useState("");
  const [ownerId, setOwnerId] = useState(initialOwnerEmployeeId ?? "");
  const [busy, setBusy] = useState<"saving" | "removing" | "deleting" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const patch = useMemo(
    () =>
      buildContactPatch(
        {
          displayName: initialDisplayName,
          tags: initialTags,
          ownerEmployeeId: initialOwnerEmployeeId
        },
        { displayName: name, tags, ownerEmployeeId: ownerId }
      ),
    [initialDisplayName, initialTags, initialOwnerEmployeeId, name, tags, ownerId]
  );

  function addTag() {
    setTags((prev) => addTagToDraft(prev, tagDraft));
    setTagDraft("");
  }

  async function save() {
    if (!patch) return;
    setBusy("saving");
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(contactKey)}?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch)
        }
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !json?.ok) {
        setError(t("editSaveFailed"));
        setBusy(null);
        return;
      }
      onSaved();
    } catch {
      setError(t("editSaveFailed"));
      setBusy(null);
    }
  }

  /**
   * The soft removal: clear the tags so the lead leaves the tasks views,
   * keeping the contact and every bit of history. Runs are untouched (they
   * are the AI mid-conversation; the per-run Dismiss is the tool for that),
   * so when one is active the confirm says the card stays in motion.
   */
  async function removeFromTasks() {
    const warning = hasActiveRuns ? ` ${t("editRemoveFromTasksRuns")}` : "";
    if (
      !window.confirm(
        `${t("editRemoveFromTasksConfirm", { name: resolvedName })}${warning}`
      )
    ) {
      return;
    }
    setBusy("removing");
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(contactKey)}?businessId=${encodeURIComponent(businessId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ tags: [] })
        }
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !json?.ok) {
        setError(t("editRemoveFailed"));
        setBusy(null);
        return;
      }
      onSaved();
    } catch {
      setError(t("editRemoveFailed"));
      setBusy(null);
    }
  }

  async function remove() {
    // Deleting the contact does not stop a mid-run workflow either, so the
    // same stays-in-motion warning applies here.
    const warning = hasActiveRuns ? ` ${t("editRemoveFromTasksRuns")}` : "";
    if (
      !window.confirm(`${t("editDeleteConfirm", { name: resolvedName })}${warning}`)
    ) {
      return;
    }
    setBusy("deleting");
    setError(null);
    try {
      const res = await fetch(
        `/api/dashboard/customers/${encodeURIComponent(contactKey)}?businessId=${encodeURIComponent(businessId)}`,
        { method: "DELETE" }
      );
      const json = (await res.json().catch(() => null)) as { ok?: boolean } | null;
      if (!res.ok || !json?.ok) {
        setError(t("editDeleteFailed"));
        setBusy(null);
        return;
      }
      onDeleted();
    } catch {
      setError(t("editDeleteFailed"));
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3 rounded-md border border-parchment/10 bg-deep-ink/40 p-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <label className="block text-[11px] text-parchment/60">
          {t("editName")}
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value.slice(0, 120))}
            placeholder={t("editNamePlaceholder")}
            maxLength={120}
            className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none"
          />
        </label>
        <label className="block text-[11px] text-parchment/60">
          {t("colOwner")}
          <select
            value={ownerId}
            onChange={(e) => setOwnerId(e.target.value)}
            className="mt-1 w-full rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1.5 text-xs text-parchment focus:border-claw-green/60 focus:outline-none"
          >
            {implicitOwnerEmployeeId === null && (
              <option value="">{t("editUnassigned")}</option>
            )}
            {employees.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="text-[11px] text-parchment/60">
        {t("editTags")}
        <div className="mt-1 flex flex-wrap items-center gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-full bg-signal-teal/10 px-2 py-0.5 text-[10px] font-medium text-signal-teal"
            >
              <Tag className="h-2.5 w-2.5" />
              {tag}
              <button
                type="button"
                onClick={() => setTags(tags.filter((x) => x !== tag))}
                className="text-signal-teal/60 hover:text-spark-orange"
                aria-label={t("editRemoveTag", { tag })}
              >
                ×
              </button>
            </span>
          ))}
          <input
            type="text"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value.slice(0, MAX_CONTACT_TAG_LENGTH))}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === ",") {
                e.preventDefault();
                addTag();
              }
            }}
            onBlur={addTag}
            placeholder={t("editTagPlaceholder")}
            className="w-28 rounded-md border border-parchment/15 bg-deep-ink/60 px-2 py-1 text-[11px] text-parchment placeholder:text-parchment/30 focus:border-claw-green/60 focus:outline-none"
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          data-testid="lead-edit-save"
          onClick={() => void save()}
          disabled={!patch || busy !== null}
          className="rounded-md bg-claw-green px-3 py-1.5 text-xs font-semibold text-deep-ink transition-colors hover:bg-claw-green/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {busy === "saving" ? t("editSaving") : t("editSave")}
        </button>
        <button
          type="button"
          onClick={onClose}
          disabled={busy !== null}
          className="rounded-md border border-parchment/15 px-3 py-1.5 text-xs text-parchment/60 hover:text-parchment disabled:opacity-40"
        >
          {t("editCancel")}
        </button>
        <Link
          href={`/dashboard/customers/${encodeURIComponent(contactKey)}`}
          className="text-[11px] text-signal-teal hover:underline"
        >
          {t("editFullProfile")}
        </Link>
        {initialTags.length > 0 && (
          <button
            type="button"
            data-testid="lead-edit-remove"
            onClick={() => void removeFromTasks()}
            disabled={busy !== null}
            className="ml-auto inline-flex items-center gap-1 rounded-md border border-parchment/20 px-2.5 py-1.5 text-xs text-parchment/70 hover:bg-parchment/10 hover:text-parchment disabled:opacity-40"
            title={t("editRemoveFromTasksTitle")}
          >
            <CircleMinus className="h-3 w-3" />
            {busy === "removing" ? t("editRemoving") : t("editRemoveFromTasks")}
          </button>
        )}
        <button
          type="button"
          data-testid="lead-edit-delete"
          onClick={() => void remove()}
          disabled={busy !== null}
          className={`inline-flex items-center gap-1 rounded-md border border-spark-orange/40 px-2.5 py-1.5 text-xs text-spark-orange hover:bg-spark-orange/10 disabled:opacity-40 ${
            initialTags.length > 0 ? "" : "ml-auto"
          }`}
        >
          <Trash2 className="h-3 w-3" />
          {busy === "deleting" ? t("editDeleting") : t("editDelete")}
        </button>
      </div>
      {error && <p className="text-xs text-spark-orange">{error}</p>}
    </div>
  );
}

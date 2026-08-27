"use client";

import { useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/Card";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { NOTE_BODY_MAX, noteRelativeTime } from "@/lib/notes/core";

export type ContactNoteView = {
  id: string;
  authorUserId: string | null;
  authorLabel: string;
  body: string;
  createdAt: string;
  updatedAt: string;
};

type Props = {
  businessId: string;
  /** The contact KEY the API route addresses (E.164 / short code / email: key). */
  customerE164: string;
  /** Newest-first, server-fetched. */
  notes: ContactNoteView[];
  /** The signed-in user's auth id; edit/delete show on their own notes. */
  currentUserId: string;
  /** Business owner / platform admin: may delete anyone's note (not edit). */
  canDeleteAny: boolean;
};

const emptySubscribe = () => () => {};

/** False during SSR/hydration, true after (LocalDateTime's pattern). */
function useHydrated(): boolean {
  return useSyncExternalStore(
    emptySubscribe,
    () => true,
    () => false
  );
}

/**
 * Module-level (not inline in the component) so the wall-clock read stays
 * out of the component render path, matching the contactDocBadges helper on
 * the contact page.
 */
function relativeNow(iso: string) {
  return noteRelativeTime(iso, Date.now());
}

/**
 * Relative "5m ago" stamp, absolute date once it is old. The relative text
 * renders only after hydration ("now" needs the viewer's clock); the
 * pre-hydration pass shows the absolute UTC date via LocalDateTime so the
 * server and first client paint agree, exactly like every other timestamp
 * on the page.
 */
function NoteTime({ iso }: { iso: string }) {
  const t = useTranslations("dashboard.notes");
  const hydrated = useHydrated();
  const rel = hydrated ? relativeNow(iso) : { kind: "date" as const };
  if (rel.kind === "date") return <LocalDateTime iso={iso} />;
  const text =
    rel.kind === "justNow"
      ? t("justNow")
      : rel.kind === "minutes"
        ? t("minutesAgo", { count: rel.count })
        : rel.kind === "hours"
          ? t("hoursAgo", { count: rel.count })
          : t("daysAgo", { count: rel.count });
  return (
    <time dateTime={iso} suppressHydrationWarning>
      {text}
    </time>
  );
}

/**
 * Notes section for the contact detail page: quick add on top, then the
 * newest-first authored list. Editing and deleting are offered on the
 * caller's own notes (the owner also gets delete on everyone's); the API
 * enforces the same rules authoritatively. Deliberately separate from the
 * pinned-notes blob in the profile editor: pinned feeds the AI preamble,
 * these are the team's running log.
 */
export function ContactNotesPanel(props: Props) {
  const t = useTranslations("dashboard.notes");
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const apiBase = `/api/dashboard/customers/${encodeURIComponent(
    props.customerE164
  )}/notes`;
  const query = `businessId=${encodeURIComponent(props.businessId)}`;

  async function request(path: string, init: RequestInit): Promise<boolean> {
    setErrorMsg(null);
    try {
      const res = await fetch(path, init);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || `HTTP ${res.status}`);
      }
      // Re-render the server component so the list (and the activity feed
      // below it) reflects the write.
      router.refresh();
      return true;
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      return false;
    }
  }

  async function addNote() {
    if (draft.trim().length === 0) return;
    setAdding(true);
    const ok = await request(`${apiBase}?${query}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: draft })
    });
    if (ok) setDraft("");
    setAdding(false);
  }

  async function saveEdit(noteId: string) {
    if (editDraft.trim().length === 0) return;
    setBusyId(noteId);
    const ok = await request(`${apiBase}/${encodeURIComponent(noteId)}?${query}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: editDraft })
    });
    if (ok) setEditingId(null);
    setBusyId(null);
  }

  async function deleteNote(noteId: string) {
    if (!window.confirm(t("deleteConfirm"))) return;
    setBusyId(noteId);
    await request(`${apiBase}/${encodeURIComponent(noteId)}?${query}`, {
      method: "DELETE"
    });
    setBusyId(null);
  }

  return (
    <Card>
      <div className="mb-3">
        <h2 className="text-sm font-semibold text-parchment">{t("title")}</h2>
        <p className="text-xs text-parchment/40 mt-0.5">{t("subtitle")}</p>
      </div>

      <label className="sr-only" htmlFor="contact-note-draft">
        {t("addLabel")}
      </label>
      <textarea
        id="contact-note-draft"
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, NOTE_BODY_MAX))}
        placeholder={t("addPlaceholder")}
        rows={2}
        maxLength={NOTE_BODY_MAX}
        className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment placeholder:text-parchment/30 focus:outline-none focus:border-claw-green/60"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          type="button"
          onClick={addNote}
          disabled={adding || draft.trim().length === 0}
          className="rounded-lg bg-claw-green text-deep-ink px-3 py-1.5 text-xs font-semibold hover:bg-claw-green/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {adding ? t("adding") : t("add")}
        </button>
        <span className="text-[10px] text-parchment/40">
          {t("charCount", { count: draft.length, max: NOTE_BODY_MAX })}
        </span>
        {errorMsg && <span className="text-xs text-red-300">{errorMsg}</span>}
      </div>

      {props.notes.length === 0 ? (
        <p className="text-xs text-parchment/50 mt-4">{t("empty")}</p>
      ) : (
        <ul className="mt-4 divide-y divide-parchment/10">
          {props.notes.map((note) => {
            const own = note.authorUserId === props.currentUserId;
            const editing = editingId === note.id;
            const busy = busyId === note.id;
            return (
              <li key={note.id} className="py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 text-xs text-parchment/60">
                    <span className="font-semibold text-parchment/80">
                      {note.authorLabel}
                    </span>
                    <span className="mx-1.5 text-parchment/30">·</span>
                    <span className="uppercase tracking-wide text-[10px] text-parchment/40">
                      <NoteTime iso={note.createdAt} />
                      {note.updatedAt !== note.createdAt && (
                        <span className="ml-1.5 normal-case">({t("edited")})</span>
                      )}
                    </span>
                  </p>
                  {!editing && (own || props.canDeleteAny) && (
                    <span className="flex shrink-0 items-center gap-2 text-[11px]">
                      {own && (
                        <button
                          type="button"
                          onClick={() => {
                            setEditingId(note.id);
                            setEditDraft(note.body);
                          }}
                          disabled={busy}
                          className="text-parchment/50 hover:text-signal-teal transition-colors disabled:opacity-40"
                        >
                          {t("edit")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => deleteNote(note.id)}
                        disabled={busy}
                        className="text-parchment/50 hover:text-red-300 transition-colors disabled:opacity-40"
                      >
                        {t("delete")}
                      </button>
                    </span>
                  )}
                </div>
                {editing ? (
                  <div className="mt-1.5">
                    <textarea
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value.slice(0, NOTE_BODY_MAX))}
                      rows={3}
                      maxLength={NOTE_BODY_MAX}
                      className="w-full bg-deep-ink/60 border border-parchment/15 rounded-lg px-3 py-2 text-sm text-parchment focus:outline-none focus:border-claw-green/60"
                    />
                    <div className="mt-1.5 flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => saveEdit(note.id)}
                        disabled={busy || editDraft.trim().length === 0}
                        className="rounded-lg bg-claw-green text-deep-ink px-3 py-1 text-xs font-semibold hover:bg-claw-green/90 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {busy ? t("saving") : t("save")}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingId(null)}
                        disabled={busy}
                        className="rounded-lg border border-parchment/20 px-3 py-1 text-xs text-parchment/70 hover:border-parchment/40 transition-colors disabled:opacity-40"
                      >
                        {t("cancel")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <p className="mt-1 text-sm text-parchment/90 whitespace-pre-wrap leading-relaxed">
                    {note.body}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

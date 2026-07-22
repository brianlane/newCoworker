"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
  BLOG_CATEGORIES,
  blogImagePublicUrl,
  type BlogCategory,
  type BlogPostRow
} from "@/lib/blog/shared";
import { renderMarkdown } from "@/lib/blog/markdown";

type Fields = {
  title: string;
  slug: string;
  category: BlogCategory;
  author_name: string;
  excerpt: string;
  content: string;
  title_es: string;
  excerpt_es: string;
  content_es: string;
  featured_image_path: string | null;
  featured_image_alt: string;
};

function fieldsFromPost(post: BlogPostRow | null): Fields {
  return {
    title: post?.title ?? "",
    slug: post?.slug ?? "",
    category: post?.category ?? "announcement",
    author_name: post?.author_name ?? "New Coworker Team",
    excerpt: post?.excerpt ?? "",
    content: post?.content ?? "",
    title_es: post?.title_es ?? "",
    excerpt_es: post?.excerpt_es ?? "",
    content_es: post?.content_es ?? "",
    featured_image_path: post?.featured_image_path ?? null,
    featured_image_alt: post?.featured_image_alt ?? ""
  };
}

/**
 * Stored UTC ISO → the local-time string `datetime-local` expects. The
 * control has local semantics, so slicing the ISO string directly would
 * show UTC digits as if they were local time.
 */
function toLocalDatetimeInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;
}

function payloadFromFields(fields: Fields) {
  return {
    title: fields.title,
    ...(fields.slug ? { slug: fields.slug } : {}),
    category: fields.category,
    author_name: fields.author_name,
    excerpt: fields.excerpt,
    content: fields.content,
    title_es: fields.title_es || null,
    excerpt_es: fields.excerpt_es || null,
    content_es: fields.content_es || null,
    featured_image_path: fields.featured_image_path,
    featured_image_alt: fields.featured_image_alt || null
  };
}

const inputClass =
  "w-full rounded-lg border border-parchment/15 bg-transparent px-3 py-2 text-sm text-parchment placeholder:text-parchment/25 focus:border-claw-green focus:outline-none";
const buttonClass =
  "rounded-lg border border-parchment/15 px-4 py-2 text-sm text-parchment/70 transition-colors hover:bg-parchment/5 disabled:opacity-50";
const primaryButtonClass =
  "rounded-lg bg-claw-green px-4 py-2 text-sm font-medium text-deep-ink hover:opacity-90 disabled:opacity-50";

/** The admin blog editor: fields, markdown preview, AI assist, lifecycle. */
export function BlogPostEditor({ initialPost }: { initialPost: BlogPostRow | null }) {
  const t = useTranslations("admin.blogPage");
  const router = useRouter();
  const [postId, setPostId] = useState<string | null>(initialPost?.id ?? null);
  const [status, setStatus] = useState(initialPost?.status ?? "draft");
  const [fields, setFields] = useState<Fields>(() => fieldsFromPost(initialPost));
  const [scheduleAt, setScheduleAt] = useState(() =>
    initialPost?.scheduled_for ? toLocalDatetimeInput(initialPost.scheduled_for) : ""
  );
  const [preview, setPreview] = useState(false);
  const [aiTopic, setAiTopic] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

  const set = <K extends keyof Fields>(key: K, value: Fields[K]) =>
    setFields((f) => ({ ...f, [key]: value }));

  const imageUrl = blogImagePublicUrl(fields.featured_image_path);
  const previewHtml = useMemo(
    () => (preview ? renderMarkdown(fields.content) : ""),
    [preview, fields.content]
  );

  const api = async (path: string, init: RequestInit): Promise<Record<string, unknown> | null> => {
    const response = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...init
    });
    const body = (await response.json().catch(() => null)) as {
      data?: Record<string, unknown>;
      error?: { message?: string };
    } | null;
    if (!response.ok) {
      throw new Error(body?.error?.message ?? t("error"));
    }
    return body?.data ?? null;
  };

  /** Create-or-update, returning the post id. */
  const persist = async (): Promise<string> => {
    const payload = payloadFromFields(fields);
    if (postId) {
      const data = await api(`/api/admin/blog/${postId}`, {
        method: "PATCH",
        body: JSON.stringify(payload)
      });
      const post = data?.post as BlogPostRow;
      setFields(fieldsFromPost(post));
      return postId;
    }
    const data = await api("/api/admin/blog", { method: "POST", body: JSON.stringify(payload) });
    const post = data?.post as BlogPostRow;
    setPostId(post.id);
    setFields(fieldsFromPost(post));
    window.history.replaceState(null, "", `/admin/blog/${post.id}`);
    return post.id;
  };

  const run = async (name: string, action: () => Promise<void>) => {
    setBusy(name);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setNotice({ kind: "error", text: err instanceof Error ? err.message : t("error") });
    } finally {
      setBusy(null);
    }
  };

  const saveDraft = () =>
    run("save", async () => {
      await persist();
      setNotice({ kind: "ok", text: t("saved") });
    });

  const publishNow = () =>
    run("publish", async () => {
      const id = await persist();
      await api(`/api/admin/blog/${id}/publish`, { method: "POST" });
      setStatus("published");
      setNotice({ kind: "ok", text: t("published") });
    });

  const schedule = () =>
    run("schedule", async () => {
      const id = await persist();
      await api(`/api/admin/blog/${id}`, {
        method: "PATCH",
        body: JSON.stringify({
          status: "scheduled",
          scheduled_for: new Date(scheduleAt).toISOString()
        })
      });
      setStatus("scheduled");
      setNotice({ kind: "ok", text: t("scheduled") });
    });

  const unschedule = () =>
    run("unschedule", async () => {
      const id = await persist();
      await api(`/api/admin/blog/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "draft" })
      });
      setStatus("draft");
      setScheduleAt("");
      setNotice({ kind: "ok", text: t("saved") });
    });

  const duplicate = () =>
    run("duplicate", async () => {
      const payload = { ...payloadFromFields(fields), title: `${fields.title} (copy)` };
      delete (payload as { slug?: string }).slug;
      const data = await api("/api/admin/blog", {
        method: "POST",
        body: JSON.stringify(payload)
      });
      const post = data?.post as BlogPostRow;
      router.push(`/admin/blog/${post.id}`);
    });

  const remove = () =>
    run("delete", async () => {
      if (!postId) return;
      if (!window.confirm(t("deleteConfirm"))) return;
      await api(`/api/admin/blog/${postId}`, { method: "DELETE" });
      router.push("/admin/blog");
    });

  const aiDraft = () =>
    run("aiDraft", async () => {
      const data = await api("/api/admin/blog/ai", {
        method: "POST",
        body: JSON.stringify({ action: "draft", topic: aiTopic })
      });
      const draft = data?.draft as {
        title: string;
        excerpt: string;
        content: string;
        category: BlogCategory;
      };
      setFields((f) => ({ ...f, ...draft }));
    });

  const aiTranslate = () =>
    run("aiTranslate", async () => {
      const data = await api("/api/admin/blog/ai", {
        method: "POST",
        body: JSON.stringify({
          action: "translate",
          title: fields.title,
          excerpt: fields.excerpt,
          content: fields.content
        })
      });
      const translation = data?.translation as {
        title_es: string;
        excerpt_es: string;
        content_es: string;
      };
      setFields((f) => ({ ...f, ...translation }));
    });

  const aiImage = () =>
    run("aiImage", async () => {
      const data = await api("/api/admin/blog/ai", {
        method: "POST",
        body: JSON.stringify({ action: "image", title: fields.title, excerpt: fields.excerpt })
      });
      set("featured_image_path", (data?.path as string) ?? null);
    });

  const uploadImage = (file: File) =>
    run("upload", async () => {
      const form = new FormData();
      form.append("file", file);
      const response = await fetch("/api/admin/blog/image", { method: "POST", body: form });
      const body = (await response.json().catch(() => null)) as {
        data?: { path: string };
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(body?.error?.message ?? t("error"));
      set("featured_image_path", body?.data?.path ?? null);
    });

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <Link href="/admin/blog" className="text-sm text-signal-teal hover:underline">
            ← {t("title")}
          </Link>
          <h1 className="mt-1 text-2xl font-bold text-parchment">
            {postId ? t("editorTitleEdit") : t("editorTitleNew")}
          </h1>
        </div>
        <span className="rounded-full bg-parchment/10 px-3 py-1 text-xs text-parchment/60">
          {status === "published"
            ? t("statusPublished")
            : status === "scheduled"
              ? t("statusScheduled")
              : t("statusDraft")}
        </span>
      </div>

      {/* AI draft strip */}
      <div className="flex flex-col gap-3 rounded-xl border border-parchment/10 bg-parchment/[0.02] p-4 sm:flex-row">
        <input
          type="text"
          value={aiTopic}
          onChange={(e) => setAiTopic(e.target.value)}
          placeholder={t("aiDraftPrompt")}
          className={inputClass}
        />
        <button
          type="button"
          onClick={aiDraft}
          disabled={busy !== null || aiTopic.trim().length < 3}
          className={`${primaryButtonClass} whitespace-nowrap`}
        >
          {busy === "aiDraft" ? t("aiWorking") : t("aiDraft")}
        </button>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label className="mb-1 block text-sm font-medium text-parchment">{t("fieldTitle")}</label>
          <input
            type="text"
            value={fields.title}
            onChange={(e) => set("title", e.target.value)}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-parchment">{t("fieldSlug")}</label>
          <input
            type="text"
            value={fields.slug}
            onChange={(e) => set("slug", e.target.value)}
            placeholder={t("fieldSlugHelp")}
            className={inputClass}
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-parchment">
            {t("fieldCategory")}
          </label>
          <select
            value={fields.category}
            onChange={(e) => set("category", e.target.value as BlogCategory)}
            className={`${inputClass} bg-deep-ink`}
          >
            {BLOG_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`categories.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-parchment">
            {t("fieldAuthor")}
          </label>
          <input
            type="text"
            value={fields.author_name}
            onChange={(e) => set("author_name", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      <div>
        <label className="mb-1 block text-sm font-medium text-parchment">{t("fieldExcerpt")}</label>
        <p className="mb-2 text-xs text-parchment/45">{t("fieldExcerptHelp")}</p>
        <textarea
          value={fields.excerpt}
          onChange={(e) => set("excerpt", e.target.value)}
          rows={3}
          maxLength={2200}
          className={inputClass}
        />
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <label className="block text-sm font-medium text-parchment">{t("fieldContent")}</label>
          <button type="button" onClick={() => setPreview((p) => !p)} className={buttonClass}>
            {preview ? t("editMarkdown") : t("preview")}
          </button>
        </div>
        {preview ? (
          <div
            className="min-h-64 rounded-lg border border-parchment/15 p-4 text-sm leading-relaxed text-parchment/75 [&_a]:text-signal-teal [&_blockquote]:border-l-4 [&_blockquote]:border-claw-green/50 [&_blockquote]:pl-3 [&_code]:rounded [&_code]:bg-black/40 [&_code]:px-1 [&_h1]:text-2xl [&_h1]:font-bold [&_h2]:mt-4 [&_h2]:text-xl [&_h2]:font-semibold [&_h3]:mt-3 [&_h3]:font-semibold [&_li]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-2 [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-black/40 [&_pre]:p-3 [&_ul]:list-disc [&_ul]:pl-5"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        ) : (
          <textarea
            value={fields.content}
            onChange={(e) => set("content", e.target.value)}
            rows={18}
            className={`${inputClass} font-mono`}
          />
        )}
      </div>

      {/* Featured image */}
      <div className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-4">
        <label className="block text-sm font-medium text-parchment">{t("fieldImage")}</label>
        {imageUrl && (
          /* eslint-disable-next-line @next/next/no-img-element -- remote Supabase storage image */
          <img src={imageUrl} alt="" className="mt-3 aspect-video w-full max-w-md rounded-lg object-cover" />
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className={`${buttonClass} cursor-pointer`}>
            {busy === "upload" ? t("aiWorking") : t("uploadImage")}
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadImage(file);
                e.target.value = "";
              }}
            />
          </label>
          <button
            type="button"
            onClick={aiImage}
            disabled={busy !== null || !fields.title}
            className={buttonClass}
          >
            {busy === "aiImage" ? t("aiWorking") : t("aiImage")}
          </button>
          {fields.featured_image_path && (
            <button
              type="button"
              onClick={() => set("featured_image_path", null)}
              className={buttonClass}
            >
              {t("removeImage")}
            </button>
          )}
        </div>
        <div className="mt-3">
          <label className="mb-1 block text-sm font-medium text-parchment">
            {t("fieldImageAlt")}
          </label>
          <input
            type="text"
            value={fields.featured_image_alt}
            onChange={(e) => set("featured_image_alt", e.target.value)}
            className={inputClass}
          />
        </div>
      </div>

      {/* Spanish translation */}
      <details className="rounded-xl border border-parchment/10 bg-parchment/[0.02] p-4">
        <summary className="cursor-pointer text-sm font-medium text-parchment">
          {t("spanishSection")}
        </summary>
        <div className="mt-4 space-y-4">
          <button
            type="button"
            onClick={aiTranslate}
            disabled={busy !== null || !fields.title || !fields.content}
            className={buttonClass}
          >
            {busy === "aiTranslate" ? t("aiWorking") : t("aiTranslate")}
          </button>
          <div>
            <label className="mb-1 block text-sm font-medium text-parchment">
              {t("fieldTitleEs")}
            </label>
            <input
              type="text"
              value={fields.title_es}
              onChange={(e) => set("title_es", e.target.value)}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-parchment">
              {t("fieldExcerptEs")}
            </label>
            <textarea
              value={fields.excerpt_es}
              onChange={(e) => set("excerpt_es", e.target.value)}
              rows={3}
              maxLength={2200}
              className={inputClass}
            />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-parchment">
              {t("fieldContentEs")}
            </label>
            <textarea
              value={fields.content_es}
              onChange={(e) => set("content_es", e.target.value)}
              rows={12}
              className={`${inputClass} font-mono`}
            />
          </div>
        </div>
      </details>

      {/* Lifecycle actions */}
      <div className="flex flex-wrap items-center gap-3 border-t border-parchment/10 pt-6">
        <button
          type="button"
          onClick={saveDraft}
          disabled={busy !== null || !fields.title}
          className={buttonClass}
        >
          {busy === "save" ? t("aiWorking") : t("saveDraft")}
        </button>
        {status !== "published" && (
          <>
            <button
              type="button"
              onClick={publishNow}
              disabled={busy !== null || !fields.title}
              className={primaryButtonClass}
            >
              {busy === "publish" ? t("aiWorking") : t("publishNow")}
            </button>
            <div className="flex items-center gap-2">
              <label className="text-sm text-parchment/60">{t("scheduleFor")}</label>
              <input
                type="datetime-local"
                value={scheduleAt}
                onChange={(e) => setScheduleAt(e.target.value)}
                className={`${inputClass} w-auto`}
              />
              <button
                type="button"
                onClick={schedule}
                disabled={busy !== null || !fields.title || !scheduleAt}
                className={buttonClass}
              >
                {busy === "schedule" ? t("aiWorking") : t("schedule")}
              </button>
            </div>
            {status === "scheduled" && (
              <button
                type="button"
                onClick={unschedule}
                disabled={busy !== null}
                className={buttonClass}
              >
                {t("unschedule")}
              </button>
            )}
          </>
        )}
        {postId && (
          <>
            <button
              type="button"
              onClick={duplicate}
              disabled={busy !== null}
              className={buttonClass}
            >
              {busy === "duplicate" ? t("aiWorking") : t("duplicate")}
            </button>
            <button
              type="button"
              onClick={remove}
              disabled={busy !== null}
              className={`${buttonClass} text-red-400`}
            >
              {t("delete")}
            </button>
          </>
        )}
        {notice && (
          <span className={notice.kind === "ok" ? "text-sm text-claw-green" : "text-sm text-red-400"}>
            {notice.text}
          </span>
        )}
      </div>
    </div>
  );
}

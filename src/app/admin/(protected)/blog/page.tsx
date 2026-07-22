import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { listPostsAdmin, getBlogSettings } from "@/lib/blog/db";
import { BlogSettingsCard } from "@/components/admin/BlogSettingsCard";

export const dynamic = "force-dynamic";

/** Admin blog console: post list + automation settings. */
export default async function AdminBlogPage() {
  const t = await getTranslations("admin.blogPage");
  const [posts, settings] = await Promise.all([listPostsAdmin(), getBlogSettings()]);

  const statusLabel = (status: string) =>
    status === "published"
      ? t("statusPublished")
      : status === "scheduled"
        ? t("statusScheduled")
        : t("statusDraft");

  const statusClass = (status: string) =>
    status === "published"
      ? "bg-claw-green/15 text-claw-green"
      : status === "scheduled"
        ? "bg-signal-teal/15 text-signal-teal"
        : "bg-parchment/10 text-parchment/60";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-parchment">{t("title")}</h1>
          <p className="mt-1 text-sm text-parchment/50">{t("subtitle")}</p>
        </div>
        <Link
          href="/admin/blog/new"
          className="rounded-lg bg-claw-green px-4 py-2 text-sm font-medium text-deep-ink hover:opacity-90"
        >
          {t("newPost")}
        </Link>
      </div>

      <div className="overflow-x-auto rounded-xl border border-parchment/10">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-parchment/10 text-xs uppercase tracking-wide text-parchment/40">
            <tr>
              <th className="px-4 py-3">{t("colTitle")}</th>
              <th className="px-4 py-3">{t("colCategory")}</th>
              <th className="px-4 py-3">{t("colStatus")}</th>
              <th className="px-4 py-3">{t("colDate")}</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {posts.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-parchment/45">
                  {t("empty")}
                </td>
              </tr>
            )}
            {posts.map((post) => {
              const when = post.published_at ?? post.scheduled_for;
              return (
                <tr key={post.id} className="border-b border-parchment/5 last:border-0">
                  <td className="px-4 py-3">
                    <Link
                      href={`/admin/blog/${post.id}`}
                      className="font-medium text-parchment hover:text-claw-green"
                    >
                      {post.title}
                    </Link>
                    {post.source === "weekly_digest" && (
                      <span className="ml-2 rounded-full bg-parchment/10 px-2 py-0.5 text-xs text-parchment/50">
                        {t("sourceDigest")}
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-parchment/60">
                    {t(`categories.${post.category}`)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2.5 py-0.5 text-xs ${statusClass(post.status)}`}>
                      {statusLabel(post.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-parchment/50">
                    {when ? new Date(when).toLocaleString() : "—"}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {post.status === "published" && (
                      <a
                        href={`/blog/${post.slug}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-signal-teal hover:underline"
                      >
                        {t("view")}
                      </a>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <BlogSettingsCard initialSettings={settings} />
    </div>
  );
}

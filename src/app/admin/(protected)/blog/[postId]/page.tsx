import { notFound } from "next/navigation";
import { getBlogPost } from "@/lib/blog/db";
import { BlogPostEditor } from "@/components/admin/BlogPostEditor";

export const dynamic = "force-dynamic";

/** Admin blog editor — `/admin/blog/new` creates, `/admin/blog/<id>` edits. */
export default async function AdminBlogEditorPage({
  params
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  if (postId === "new") {
    return <BlogPostEditor initialPost={null} />;
  }
  const post = await getBlogPost(postId);
  if (!post) notFound();
  return <BlogPostEditor initialPost={post} />;
}

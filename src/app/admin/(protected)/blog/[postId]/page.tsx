import { notFound } from "next/navigation";
import { getBlogPost } from "@/lib/blog/db";
import { BlogPostEditor } from "@/components/admin/BlogPostEditor";

export const dynamic = "force-dynamic";

/** Admin blog editor, `/admin/blog/new` creates, `/admin/blog/<id>` edits. */
export default async function AdminBlogEditorPage({
  params
}: {
  params: Promise<{ postId: string }>;
}) {
  const { postId } = await params;
  if (postId === "new") {
    return <BlogPostEditor initialPost={null} />;
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(postId)) {
    // Junk in the segment must 404, not crash on the uuid cast.
    notFound();
  }
  const post = await getBlogPost(postId);
  if (!post) notFound();
  return <BlogPostEditor initialPost={post} />;
}

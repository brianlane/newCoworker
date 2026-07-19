import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { ChevronRight } from "lucide-react";
import { resolveActiveBusinessId } from "@/lib/dashboard/active-business";
import { getAuthUser } from "@/lib/auth";
import { getBusinessDocument } from "@/lib/documents/db";
import { DocumentDetail } from "@/components/dashboard/DocumentDetail";
import type { DocumentItem } from "@/components/dashboard/documents-shared";

export const dynamic = "force-dynamic";

export default async function DocumentViewPage({
  params
}: {
  params: Promise<{ documentId: string }>;
}) {
  const user = await getAuthUser();
  if (!user) redirect("/login");

  const businessId = await resolveActiveBusinessId(user);
  if (!businessId) redirect("/dashboard/documents");

  const { documentId } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(documentId)) {
    notFound();
  }
  // Business-scoped read: a cross-tenant id comes back null and 404s.
  const document = await getBusinessDocument(businessId, documentId);
  if (!document) notFound();

  const folder = document.category.trim() || "general";

  return (
    <div className="space-y-4 max-w-3xl">
      <nav className="flex items-center gap-1 text-sm text-parchment/50" aria-label="Breadcrumb">
        <Link href="/dashboard/documents" className="hover:text-parchment">
          Documents
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-parchment/30" />
        <Link
          href={`/dashboard/documents?folder=${encodeURIComponent(folder)}`}
          className="hover:text-parchment"
        >
          {folder}
        </Link>
        <ChevronRight className="h-3.5 w-3.5 text-parchment/30" />
        <span className="truncate text-parchment/80">{document.title}</span>
      </nav>

      <DocumentDetail businessId={businessId} initialDocument={document as DocumentItem} />
    </div>
  );
}

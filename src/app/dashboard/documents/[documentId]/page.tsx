import { notFound, redirect } from "next/navigation";
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

  return (
    <div className="space-y-4 max-w-3xl">
      {/* Breadcrumb lives inside DocumentDetail: it tracks live renames and
          folder moves, which this server render can't see. */}
      <DocumentDetail businessId={businessId} initialDocument={document as DocumentItem} />
    </div>
  );
}

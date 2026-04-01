import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { AdminSidebar } from "@/components/admin/AdminSidebar";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/admin/login?next=/admin/dashboard");
  if (!user.isAdmin) redirect("/admin/login?next=/admin/dashboard");

  return (
    <div className="flex h-screen bg-deep-ink">
      <AdminSidebar userEmail={user.email} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}

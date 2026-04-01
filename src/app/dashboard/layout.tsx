import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { DashboardSidebar } from "@/components/dashboard/DashboardSidebar";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/dashboard");

  return (
    <div className="flex h-screen bg-deep-ink">
      <DashboardSidebar userEmail={user.email} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}

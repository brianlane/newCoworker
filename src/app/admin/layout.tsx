import { redirect } from "next/navigation";
import { getAuthUser } from "@/lib/auth";
import { Sidebar } from "@/components/ui/Sidebar";
import { LayoutDashboard, Users, Server, Settings } from "lucide-react";

const adminNavItems = [
  { label: "All Clients", href: "/admin", icon: Users },
  { label: "Provisioning", href: "/admin/provision", icon: Server },
  { label: "System", href: "/admin/system", icon: Settings },
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard }
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getAuthUser();
  if (!user) redirect("/login?redirectTo=/admin");
  if (!user.isAdmin) redirect("/dashboard");

  return (
    <div className="flex h-screen bg-deep-ink">
      <Sidebar items={adminNavItems} userEmail={user.email} />
      <main className="flex-1 overflow-y-auto p-6">{children}</main>
    </div>
  );
}

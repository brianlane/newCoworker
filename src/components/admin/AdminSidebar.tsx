"use client";

import { Sidebar } from "@/components/ui/Sidebar";
import { LayoutDashboard, Users, Server, Settings } from "lucide-react";

const adminNavItems = [
  { label: "Dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { label: "All Clients", href: "/admin/clients", icon: Users },
  { label: "Provisioning", href: "/admin/provision", icon: Server },
  { label: "System", href: "/admin/system", icon: Settings }
];

export function AdminSidebar({ userEmail }: { userEmail?: string | null }) {
  return <Sidebar items={adminNavItems} userEmail={userEmail} />;
}

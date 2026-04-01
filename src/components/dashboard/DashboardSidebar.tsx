"use client";

import { Sidebar } from "@/components/ui/Sidebar";
import { LayoutDashboard, Brain, Settings, Bell } from "lucide-react";

const ownerNavItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Memory", href: "/dashboard/memory", icon: Brain },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
  { label: "Notifications", href: "/dashboard/notifications", icon: Bell }
];

export function DashboardSidebar({ userEmail }: { userEmail?: string | null }) {
  return <Sidebar items={ownerNavItems} userEmail={userEmail} />;
}

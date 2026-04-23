"use client";

import { Sidebar } from "@/components/ui/Sidebar";
import { LayoutDashboard, MessageSquare, Brain, Plug, Settings, Bell } from "lucide-react";

const ownerNavItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Chat", href: "/dashboard/chat", icon: MessageSquare },
  { label: "Memory", href: "/dashboard/memory", icon: Brain },
  { label: "Integrations", href: "/dashboard/integrations", icon: Plug },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
  { label: "Notifications", href: "/dashboard/notifications", icon: Bell }
];

export function DashboardSidebar({ userEmail }: { userEmail?: string | null }) {
  return <Sidebar items={ownerNavItems} userEmail={userEmail} />;
}

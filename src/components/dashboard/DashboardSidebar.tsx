"use client";

import { Sidebar } from "@/components/ui/Sidebar";
import {
  LayoutDashboard,
  MessageSquare,
  Phone,
  MessageCircle,
  Brain,
  Plug,
  Settings,
  Bell,
  Users
} from "lucide-react";

const ownerNavItems = [
  { label: "Dashboard", href: "/dashboard", icon: LayoutDashboard },
  { label: "Chat", href: "/dashboard/chat", icon: MessageSquare },
  { label: "Calls", href: "/dashboard/calls", icon: Phone },
  { label: "Texts", href: "/dashboard/messages", icon: MessageCircle },
  // Cross-channel customers view (Phase 4 of the customer memory plan):
  // unified per-customer profile across SMS + voice. Sits between the
  // channel-specific dashboards and the business-level Memory page so
  // owners can find a person without remembering which channel they
  // came in on.
  { label: "Customers", href: "/dashboard/customers", icon: Users },
  { label: "Memory", href: "/dashboard/memory", icon: Brain },
  { label: "Integrations", href: "/dashboard/integrations", icon: Plug },
  { label: "Settings", href: "/dashboard/settings", icon: Settings },
  { label: "Notifications", href: "/dashboard/notifications", icon: Bell }
];

export function DashboardSidebar({ userEmail }: { userEmail?: string | null }) {
  return <Sidebar items={ownerNavItems} userEmail={userEmail} />;
}

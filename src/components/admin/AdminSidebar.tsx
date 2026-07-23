"use client";

import { useTranslations } from "next-intl";
import { Sidebar } from "@/components/ui/Sidebar";
import {
  LayoutDashboard,
  Users,
  Server,
  Settings,
  DollarSign,
  Receipt,
  Gauge,
  Activity,
  MessageSquare,
  Newspaper,
  Sparkles,
  Network
} from "lucide-react";

const adminNavItems = [
  { labelKey: "dashboard", href: "/admin/dashboard", icon: LayoutDashboard },
  { labelKey: "allClients", href: "/admin/clients", icon: Users },
  { labelKey: "webchat", href: "/admin/webchat", icon: MessageSquare },
  { labelKey: "blog", href: "/admin/blog", icon: Newspaper },
  { labelKey: "revenue", href: "/admin/revenue", icon: DollarSign },
  { labelKey: "costs", href: "/admin/costs", icon: Receipt },
  { labelKey: "usage", href: "/admin/usage", icon: Gauge },
  { labelKey: "gemini", href: "/admin/gemini", icon: Sparkles },
  { labelKey: "memoryGraph", href: "/admin/memory-graph", icon: Network },
  { labelKey: "engagement", href: "/admin/engagement", icon: Activity },
  { labelKey: "provisioning", href: "/admin/provision", icon: Server },
  { labelKey: "system", href: "/admin/system", icon: Settings }
] as const;

export function AdminSidebar({ userEmail }: { userEmail?: string | null }) {
  const t = useTranslations("admin");
  const items = adminNavItems.map(({ labelKey, href, icon }) => ({
    label: t(labelKey),
    href,
    icon
  }));
  return <Sidebar items={items} userEmail={userEmail} />;
}

"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import type { LucideIcon } from "lucide-react";

interface SidebarItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

interface SidebarProps {
  items: SidebarItem[];
  userEmail?: string | null;
}

export function Sidebar({ items, userEmail }: SidebarProps) {
  const pathname = usePathname();

  return (
    <aside className="flex h-screen w-60 flex-col border-r border-parchment/10 bg-deep-ink">
      <div className="flex items-center gap-3 px-5 py-5 border-b border-parchment/10">
        <Image src="/logo.png" alt="New Coworker" width={32} height={32} className="rounded-full" />
        <span className="font-semibold text-parchment text-sm">New Coworker</span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
        {items.map((item) => {
          const Icon = item.icon;
          const active = pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
              className={[
                "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                active
                  ? "bg-signal-teal/15 text-signal-teal"
                  : "text-parchment/60 hover:bg-parchment/8 hover:text-parchment"
              ].join(" ")}
            >
              <Icon size={16} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      {userEmail && (
        <div className="border-t border-parchment/10 px-4 py-4">
          <p className="text-xs text-parchment/40 truncate mb-2">{userEmail}</p>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="w-full rounded-lg px-3 py-2 text-xs text-parchment/50 hover:bg-parchment/10 hover:text-parchment transition-colors text-left"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </aside>
  );
}

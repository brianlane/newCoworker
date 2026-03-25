"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
}

interface NavbarProps {
  items: NavItem[];
  userEmail?: string | null;
}

export function Navbar({ items, userEmail }: NavbarProps) {
  const pathname = usePathname();

  return (
    <nav className="flex h-16 items-center justify-between border-b border-parchment/10 bg-deep-ink px-6">
      <div className="flex items-center gap-3">
        <Link href="/" className="flex items-center gap-2">
          <Image src="/logo.png" alt="New Coworker" width={32} height={32} className="rounded-full" />
          <span className="font-semibold text-parchment">New Coworker</span>
        </Link>
      </div>

      <div className="flex items-center gap-1">
        {items.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={[
              "rounded-lg px-3 py-2 text-sm transition-colors",
              pathname === item.href
                ? "bg-signal-teal/20 text-signal-teal"
                : "text-parchment/60 hover:bg-parchment/10 hover:text-parchment"
            ].join(" ")}
          >
            {item.label}
          </Link>
        ))}
      </div>

      {userEmail && (
        <div className="flex items-center gap-3">
          <span className="text-xs text-parchment/50">{userEmail}</span>
          <form action="/api/auth/signout" method="POST">
            <button
              type="submit"
              className="rounded-lg px-3 py-1.5 text-xs text-parchment/50 hover:bg-parchment/10 hover:text-parchment transition-colors"
            >
              Sign out
            </button>
          </form>
        </div>
      )}
    </nav>
  );
}

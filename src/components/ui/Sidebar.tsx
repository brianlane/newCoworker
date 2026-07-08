"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

interface SidebarItem {
  label: string;
  href: string;
  icon: LucideIcon;
}

export interface SidebarBrand {
  /** Replaces the "New Coworker" wordmark. */
  productName?: string;
  /** https logo, replaces /logo.png. Validated upstream (brandingSchema). */
  logoUrl?: string;
  /** Accent for the active nav item; #hex validated upstream. */
  accentColor?: string;
}

interface SidebarProps {
  items: SidebarItem[];
  userEmail?: string | null;
  /**
   * Optional render slot for a per-item trailing element (e.g. an unread
   * count badge for the Notifications bell). Returning null hides the slot
   * for that item.
   */
  renderTrailing?: (item: SidebarItem) => ReactNode;
  /** White-label branding (enterprise); undefined renders platform branding. */
  brand?: SidebarBrand | null;
}

export function Sidebar({ items, userEmail, renderTrailing, brand }: SidebarProps) {
  const pathname = usePathname();
  // Mobile-only off-canvas state. At lg+ the drawer is always static/visible
  // (CSS), so this flag only matters below lg.
  const [open, setOpen] = useState(false);

  // Auto-close on navigation (covers link taps, back/forward, programmatic
  // routing). We adjust state during render by comparing the current pathname
  // to the one we last rendered with — React's recommended alternative to a
  // setState-in-effect, which also avoids the cascading-render lint rule.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setOpen(false);
  }

  const activeItem = [...items]
    .sort((a, b) => b.href.length - a.href.length)
    .find((item) => pathname === item.href || pathname.startsWith(item.href + "/"));

  return (
    <>
      {/* Mobile hamburger — hidden at lg+ where the sidebar is always visible. */}
      <button
        type="button"
        aria-label="Open menu"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        data-mobile-nav-trigger
        className="fixed left-3 top-3 z-50 inline-flex h-11 w-11 items-center justify-center rounded-lg border border-parchment/10 bg-deep-ink/90 text-parchment backdrop-blur-sm lg:hidden"
      >
        <Menu size={20} />
      </button>

      {/* Mobile overlay backdrop. */}
      {open && (
        <div
          aria-hidden="true"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}

      <aside
        data-app-sidebar
        className={[
          "fixed inset-y-0 left-0 z-40 flex h-dvh w-60 flex-col border-r border-parchment/10 bg-deep-ink transition-transform duration-300 ease-in-out",
          "lg:static lg:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full lg:translate-x-0"
        ].join(" ")}
      >
        <div className="flex items-center gap-3 border-b border-parchment/10 px-5 py-5">
          {brand?.logoUrl ? (
            // Tenant-hosted logo: a plain <img> because next/image requires
            // per-domain allow-listing, which can't cover arbitrary tenant CDNs.
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={brand.logoUrl}
              alt={brand.productName ?? "Logo"}
              width={32}
              height={32}
              className="h-8 w-8 rounded-full object-cover"
            />
          ) : (
            <Image src="/logo.png" alt="New Coworker" width={32} height={32} className="rounded-full" />
          )}
          <span className="text-sm font-semibold text-parchment">
            {brand?.productName ?? "New Coworker"}
          </span>
          {/* Close button (mobile only). */}
          <button
            type="button"
            aria-label="Close menu"
            onClick={() => setOpen(false)}
            className="ml-auto inline-flex h-9 w-9 items-center justify-center rounded-lg text-parchment/60 hover:text-parchment lg:hidden"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = activeItem?.href === item.href;
            const trailing = renderTrailing ? renderTrailing(item) : null;
            // Accent override for the active item: inline style (the color is
            // schema-validated #hex) since Tailwind tokens can't be tenant-set.
            const accentStyle =
              active && brand?.accentColor
                ? { color: brand.accentColor, backgroundColor: `${brand.accentColor}26` }
                : undefined;
            return (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                style={accentStyle}
                className={[
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  active
                    ? accentStyle
                      ? ""
                      : "bg-signal-teal/15 text-signal-teal"
                    : "text-parchment/60 hover:bg-parchment/8 hover:text-parchment"
                ].join(" ")}
              >
                <Icon size={16} />
                <span className="flex-1 truncate">{item.label}</span>
                {trailing}
              </Link>
            );
          })}
        </nav>

        {userEmail && (
          <div className="border-t border-parchment/10 px-4 pt-3 pb-6">
            <p className="text-xs text-parchment/40 truncate mb-2">{userEmail}</p>
            <form action="/api/auth/signout" method="POST">
              <button
                type="submit"
                className="w-full rounded-lg px-3 py-2 text-xs font-medium text-parchment/60 bg-parchment/5 hover:bg-parchment/10 hover:text-parchment transition-colors text-left border border-parchment/10"
              >
                Sign out
              </button>
            </form>
          </div>
        )}
      </aside>
    </>
  );
}

import Link from "next/link";

/**
 * The single active announcement shown on every marketing page. Set to null
 * to hide the banner entirely; swap the object to change the announcement.
 */
export const ANNOUNCEMENT: { label: string; href: string; cta: string } | null = {
  label: "New: RCS messaging with a verified sender and read receipts",
  href: "/features",
  cta: "See what's new"
};

/**
 * Thin strip rendered above the marketing nav. Scrolls away with the page
 * (the nav below it stays sticky).
 */
export function AnnouncementBanner() {
  if (!ANNOUNCEMENT) return null;
  return (
    <div className="border-b border-claw-green/20 bg-claw-green/10">
      <div className="mx-auto flex max-w-6xl items-center justify-center gap-2 px-6 py-2 text-center">
        <p className="text-xs font-medium text-claw-green sm:text-sm">
          {ANNOUNCEMENT.label}{" "}
          <Link href={ANNOUNCEMENT.href} className="underline underline-offset-2 hover:text-parchment">
            {ANNOUNCEMENT.cta}
          </Link>
        </p>
      </div>
    </div>
  );
}

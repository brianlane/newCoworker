/**
 * Segment-level loading skeleton for every /dashboard route.
 *
 * Dashboard pages are `force-dynamic` server components whose render blocks
 * on their full query set; without a loading boundary a navigation shows
 * NOTHING until the slowest query resolves. This file gives Next a Suspense
 * fallback for the whole segment (child routes without their own
 * loading.tsx bubble up to this one), so the sidebar/shell stays put and
 * the content area paints instantly with placeholders.
 *
 * Purely presentational: neutral bars + card shells in the dashboard's own
 * palette, no data, no client JS.
 */
export default function DashboardLoading() {
  return (
    <div className="max-w-4xl space-y-6" aria-busy="true" aria-live="polite">
      <div className="space-y-2">
        <div className="h-7 w-56 animate-pulse rounded bg-parchment/10" />
        <div className="h-4 w-80 animate-pulse rounded bg-parchment/5" />
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            className="rounded-xl border border-parchment/10 bg-deep-ink/75 p-5"
          >
            <div className="mb-3 h-3 w-24 animate-pulse rounded bg-parchment/10" />
            <div className="h-5 w-32 animate-pulse rounded bg-parchment/5" />
          </div>
        ))}
      </div>

      <div className="rounded-xl border border-parchment/10 bg-deep-ink/75 p-5">
        <div className="mb-4 h-4 w-40 animate-pulse rounded bg-parchment/10" />
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center justify-between gap-3">
              <div className="h-4 w-2/3 animate-pulse rounded bg-parchment/5" />
              <div className="h-4 w-16 animate-pulse rounded bg-parchment/10" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

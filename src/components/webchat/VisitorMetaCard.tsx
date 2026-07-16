/**
 * "Visitor details" card for webchat transcript views (owner + admin):
 * every passively collected fact about the session — location, device,
 * language, source, page trail — as label/value rows. Renders nothing
 * when no metadata was captured (sessions predating collection, or
 * privacy-restrictive browsers). The visitor's IP is never among these:
 * it is never stored.
 */

import { Card } from "@/components/ui/Card";
import {
  parseVisitorMeta,
  visitorMetaDisplayRows
} from "@/lib/webchat/visitor-meta";

export function VisitorMetaCard({ visitorMeta }: { visitorMeta: unknown | null }) {
  const rows = visitorMetaDisplayRows(parseVisitorMeta(visitorMeta));
  if (rows.length === 0) return null;

  return (
    <Card>
      <h2 className="text-xs font-semibold text-parchment/40 uppercase tracking-wider mb-3">
        Visitor details
      </h2>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-2">
        {rows.map((r) => (
          <div key={r.label} className="min-w-0">
            <dt className="text-xs text-parchment/40">{r.label}</dt>
            <dd className="text-sm text-parchment/80 break-words m-0">{r.value}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}

/**
 * Dedicated support card (enterprise): SLA response targets + the
 * operator's dedicated contact channels. Server component — the settings
 * page renders it only for enterprise tenants.
 */

import { Card } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import {
  ENTERPRISE_SLA_TARGETS,
  type EnterpriseSupportContact
} from "@/lib/plans/enterprise-support";

export function DedicatedSupportCard({ contact }: { contact: EnterpriseSupportContact }) {
  const hasContact = !!(contact.email || contact.phone || contact.bookingUrl);
  return (
    <Card>
      <div className="flex items-center gap-2 mb-2">
        <h2 className="text-sm font-semibold text-parchment">Dedicated support</h2>
        <Badge variant="success">Priority — always on</Badge>
      </div>
      <p className="text-xs text-parchment/40 mb-4">
        Your Enterprise plan includes a permanent priority call &amp; video support line and
        these response commitments:
      </p>
      <dl className="space-y-2 text-sm mb-4">
        {ENTERPRISE_SLA_TARGETS.map((row) => (
          <div key={row.label} className="flex justify-between gap-4">
            <dt className="text-parchment/50">{row.label}</dt>
            <dd className="text-parchment text-right">{row.target}</dd>
          </div>
        ))}
      </dl>
      {hasContact ? (
        <div className="space-y-1 text-sm border-t border-parchment/10 pt-3">
          {contact.email && (
            <p>
              <a href={`mailto:${contact.email}`} className="text-claw-green hover:underline">
                {contact.email}
              </a>
            </p>
          )}
          {contact.phone && (
            <p>
              <a href={`tel:${contact.phone}`} className="text-claw-green hover:underline">
                {contact.phone}
              </a>
            </p>
          )}
          {contact.bookingUrl && (
            <p>
              <a
                href={contact.bookingUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-claw-green hover:underline"
              >
                Book a call with your account contact →
              </a>
            </p>
          )}
        </div>
      ) : (
        <p className="text-xs text-parchment/40 border-t border-parchment/10 pt-3">
          Reply to any email from us and it lands in the priority queue.
        </p>
      )}
    </Card>
  );
}

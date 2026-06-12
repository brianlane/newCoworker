/**
 * Single-customer SMS thread viewer. Server-rendered; mirrors the
 * dashboard-chat owner-scoped lookup (resolve business by caller email,
 * then read messages scoped by that business_id so a forged URL can't
 * surface another owner's thread).
 */

import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { getAuthUser } from "@/lib/auth";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { Card } from "@/components/ui/Card";
import { ChatMarkdown } from "@/components/ui/ChatMarkdown";
import { listMessagesForCustomer } from "@/lib/db/sms-history";
import { resolveContactNames, type ContactName } from "@/lib/db/contact-names";
import { LocalDateTime } from "@/components/dashboard/LocalDateTime";
import { ContactNameEditor } from "@/components/dashboard/ContactNameEditor";

export const dynamic = "force-dynamic";

// E.164 or a bare short code (lead sources like ReferralExchange text from
// 5-digit short codes; their threads are addressable too).
const e164Schema = z.string().regex(/^(\+[1-9]\d{6,15}|\d{3,8})$/);

export default async function SmsThreadPage({
  params
}: {
  params: Promise<{ customerE164: string }>;
}) {
  const { customerE164: rawSegment } = await params;
  // Next has already URL-decoded the segment, but defend against
  // double-encoding bugs upstream by re-decoding any residual %2B etc.
  const decoded = (() => {
    try {
      return decodeURIComponent(rawSegment);
    } catch {
      return rawSegment;
    }
  })();
  const parsed = e164Schema.safeParse(decoded);
  if (!parsed.success) notFound();
  const customerE164 = parsed.data;

  const user = await getAuthUser();
  if (!user) {
    redirect(`/login?redirectTo=/dashboard/messages/${encodeURIComponent(customerE164)}`);
  }
  if (!user.email) {
    redirect(`/login?redirectTo=/dashboard/messages/${encodeURIComponent(customerE164)}`);
  }

  const db = await createSupabaseServiceClient();
  const { data: businesses } = await db
    .from("businesses")
    .select("id, name")
    .eq("owner_email", user.email)
    .order("created_at", { ascending: false });

  const business = businesses?.[0] ?? null;
  if (!business) notFound();

  const messages = await listMessagesForCustomer(business.id, customerE164, {
    limit: 100
  });
  if (messages.length === 0) notFound();
  const contact = (
    await resolveContactNames(business.id, [customerE164]).catch(
      () => new Map<string, ContactName>()
    )
  ).get(customerE164);
  const inboundLabel = contact
    ? contact.kind === "employee"
      ? `${contact.name} (employee)`
      : contact.kind === "owner"
        ? `${contact.name} (owner)`
        : contact.name
    : customerE164.startsWith("+")
      ? "Customer"
      : customerE164;

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/dashboard/messages"
          className="text-xs text-parchment/60 hover:text-parchment transition-colors"
        >
          ← Back to text history
        </Link>
        <h1 className="text-2xl font-bold text-parchment mt-2">SMS thread</h1>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-parchment/60">
          <span className="font-semibold text-parchment">
            {contact?.name ?? customerE164}
          </span>
          {contact?.kind === "employee" && (
            <span className="text-[10px] uppercase tracking-wide text-amber-300/80 bg-amber-300/10 rounded px-1.5 py-0.5">
              employee
            </span>
          )}
          {contact?.kind === "owner" && (
            <span className="text-[10px] uppercase tracking-wide text-signal-teal/90 bg-signal-teal/10 rounded px-1.5 py-0.5">
              owner
            </span>
          )}
          {contact && <span className="font-mono text-xs">{customerE164}</span>}
          <ContactNameEditor
            key={customerE164}
            businessId={business.id}
            e164={customerE164}
            currentName={contact?.name ?? null}
            hasOverride={Boolean(contact?.override)}
          />
          <span>·</span>
          <span>
            {messages.length} message{messages.length === 1 ? "" : "s"}
          </span>
        </div>
      </div>

      <Card padding="md">
        <ul className="space-y-4">
          {messages.map((m) => {
            const isInbound = m.direction === "inbound";
            return (
              <li
                key={m.id}
                className={[
                  "flex",
                  isInbound ? "justify-start" : "justify-end"
                ].join(" ")}
              >
                <div
                  className={[
                    "max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed",
                    isInbound
                      ? "bg-parchment/10 text-parchment"
                      : "bg-claw-green/20 text-parchment"
                  ].join(" ")}
                >
                  <div className="text-[10px] uppercase tracking-wide text-parchment/50 mb-1 flex items-center gap-2">
                    <span>
                      {isInbound
                        ? inboundLabel
                        : m.source === "ai_flow"
                          ? "AiFlow"
                          : m.source === "agent_offer"
                            ? "AiFlow · team offer"
                            : m.source === "owner_notify"
                              ? "AiFlow · notification"
                              : "Assistant"}
                    </span>
                    <span className="text-parchment/30 normal-case font-normal">
                      <LocalDateTime iso={m.timestamp} />
                    </span>
                    {m.lastError ? (
                      <span className="text-[10px] uppercase tracking-wide text-amber-300/80">
                        delivery: {m.status}
                      </span>
                    ) : null}
                  </div>
                  <ChatMarkdown text={m.content} />
                  {m.lastError ? (
                    <p className="mt-1 text-[10px] text-amber-200/80">
                      Last error: {m.lastError}
                    </p>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
    </div>
  );
}

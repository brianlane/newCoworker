import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { MarketingNav } from "@/components/marketing/MarketingNav";
import { MarketingFooter } from "@/components/marketing/MarketingFooter";
import { SITE_URL } from "@/lib/marketing/site-url";

/**
 * Public REST API reference.
 *
 * Authored in English only, the same call the Terms and Privacy pages make:
 * this is a developer reference whose substance is endpoint paths, JSON, and
 * field names, none of which translate. The product surfaces a Spanish speaker
 * actually reads (dashboard, SMS, email) stay fully localized.
 *
 * Every endpoint here is one the published Zapier integration calls, so this
 * page doubles as the API documentation Zapier's app review requires. Keep it
 * in step with `src/app/api/public/v1/**` when a route changes.
 */

const API_BASE = `${SITE_URL}/api/public/v1`;

export const metadata: Metadata = {
  title: "API Documentation",
  description:
    "REST API reference for New Coworker: send texts, start AiFlows from external events, read recent activity, and subscribe to webhooks with a business API key.",
  alternates: { canonical: "/docs/api" }
};

function Code({ children }: { children: ReactNode }) {
  return (
    <code className="rounded bg-parchment/10 px-1.5 py-0.5 font-mono text-[0.85em] text-parchment/90">
      {children}
    </code>
  );
}

function Block({ children }: { children: string }) {
  return (
    <pre className="mt-3 overflow-x-auto rounded-xl border border-parchment/10 bg-deep-ink/60 p-4 font-mono text-xs leading-6 text-parchment/85">
      {children}
    </pre>
  );
}

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 space-y-3">
      <h2 className="text-2xl font-semibold tracking-tight text-parchment">{title}</h2>
      <div className="space-y-3 text-parchment/75">{children}</div>
    </section>
  );
}

function Endpoint({
  method,
  path,
  summary,
  children
}: {
  method: "GET" | "POST" | "DELETE";
  path: string;
  summary: string;
  children: ReactNode;
}) {
  const tone =
    method === "GET"
      ? "bg-signal-teal/15 text-signal-teal"
      : method === "POST"
        ? "bg-claw-green/15 text-claw-green"
        : "bg-spark-orange/15 text-spark-orange";
  return (
    <div className="rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-5">
      <div className="flex flex-wrap items-center gap-3">
        <span className={`rounded-md px-2 py-1 font-mono text-xs font-semibold ${tone}`}>{method}</span>
        <span className="font-mono text-sm text-parchment/90">{path}</span>
      </div>
      <p className="mt-3 text-sm text-parchment/70">{summary}</p>
      <div className="mt-3 space-y-2 text-sm text-parchment/70">{children}</div>
    </div>
  );
}

function FieldTable({ rows }: { rows: Array<[string, string, string]> }) {
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[32rem] border-collapse text-left text-xs">
        <thead>
          <tr className="border-b border-parchment/10 text-parchment/50">
            <th className="py-2 pr-4 font-medium">Field</th>
            <th className="py-2 pr-4 font-medium">Type</th>
            <th className="py-2 font-medium">Notes</th>
          </tr>
        </thead>
        <tbody className="text-parchment/75">
          {rows.map(([field, type, notes]) => (
            <tr key={field} className="border-b border-parchment/5 align-top">
              <td className="py-2 pr-4 font-mono text-parchment/90">{field}</td>
              <td className="py-2 pr-4 font-mono text-parchment/60">{type}</td>
              <td className="py-2">{notes}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const TOC = [
  ["overview", "Overview"],
  ["authentication", "Authentication"],
  ["responses", "Responses and errors"],
  ["rate-limits", "Rate limits"],
  ["me", "Identify the business"],
  ["messages", "Send a text"],
  ["flow-events", "Start an AiFlow from an event"],
  ["events", "Read recent events"],
  ["hooks", "Webhook subscriptions"],
  ["event-types", "Event types"]
] as const;

export default function ApiDocsPage() {
  return (
    <div className="min-h-screen bg-deep-ink text-parchment">
      <MarketingNav />
      <main className="mx-auto max-w-4xl px-6 pb-24 pt-6">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-signal-teal">Developers</p>
        <h1 className="mt-3 text-4xl font-bold tracking-tight sm:text-5xl">API documentation</h1>
        <p className="mt-5 text-base leading-7 text-parchment/70 sm:text-lg">
          The New Coworker public REST API lets an external system text a customer, hand a lead to an
          AiFlow, read recent activity, and subscribe to events. It is the same API our{" "}
          <Link href="/integrations" className="text-claw-green hover:underline">
            Zapier integration
          </Link>{" "}
          runs on, so anything Zapier can do, your own code can do.
        </p>

        <nav aria-label="On this page" className="mt-8 rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-5">
          <p className="text-xs font-semibold uppercase tracking-wider text-parchment/45">On this page</p>
          <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
            {TOC.map(([id, label]) => (
              <li key={id}>
                <a href={`#${id}`} className="text-parchment/70 transition-colors hover:text-claw-green">
                  {label}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="mt-12 space-y-12">
          <Section id="overview" title="Overview">
            <p>
              Every endpoint lives under one base URL and speaks JSON in both directions:
            </p>
            <Block>{API_BASE}</Block>
            <p>
              The API is available on the Standard plan and up. A key issued to a Starter business
              authenticates, so you can always call <Code>/me</Code> to see where you stand, but the
              gated endpoints answer <Code>403 FORBIDDEN</Code> with an upgrade message.
            </p>
          </Section>

          <Section id="authentication" title="Authentication">
            <p>
              Send your API key as a bearer token on every request. There is no session, no cookie, and no
              CSRF token involved.
            </p>
            <Block>{`Authorization: Bearer nck_your_key_here`}</Block>
            <p>
              Create and revoke keys in the dashboard under <Code>Integrations</Code>. Keys start with{" "}
              <Code>nck_</Code>, are scoped to the single business that created them, and are shown once at
              creation: we store only a hash, so a lost key is replaced rather than recovered. Every call
              stamps the key&apos;s last-used time, which the dashboard displays.
            </p>
            <p>
              A missing, unknown, or revoked key returns <Code>401 UNAUTHORIZED</Code>.
            </p>
          </Section>

          <Section id="responses" title="Responses and errors">
            <p>Successful responses wrap the payload in an envelope:</p>
            <Block>{`{ "ok": true, "data": { ... } }`}</Block>
            <p>Failures use the same envelope with a machine-readable code:</p>
            <Block>{`{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "Message can't be empty" } }`}</Block>
            <FieldTable
              rows={[
                ["UNAUTHORIZED", "401", "Missing, malformed, unknown, or revoked API key."],
                ["FORBIDDEN", "403", "The business is on a plan below Standard."],
                ["VALIDATION_ERROR", "400 / 413", "Body or query failed validation. 413 when a payload is too large."],
                ["NOT_FOUND", "404", "No such record for this business."],
                ["CONFLICT", "409 / 429", "429 when rate limited, 409 when a plan quota is exhausted."],
                ["DB_ERROR", "500", "Unexpected server-side failure. Safe to retry."]
              ]}
            />
          </Section>

          <Section id="rate-limits" title="Rate limits">
            <p>
              Limits are per business, not per key, and reset on a rolling 60 second window. Exceeding one
              returns <Code>429</Code> with code <Code>CONFLICT</Code>; retry after a short pause.
            </p>
            <FieldTable
              rows={[
                ["POST /messages", "60 / minute", "Plan SMS quotas apply on top and answer 409 when exhausted."],
                ["POST /flow-events", "120 / minute", "Payload capped at 64KB."]
              ]}
            />
          </Section>

          <Section id="me" title="Identify the business">
            <Endpoint
              method="GET"
              path="/api/public/v1/me"
              summary="Returns the business behind the API key. Use it to verify a key and to check whether the plan allows the gated endpoints."
            >
              <Block>{`curl ${API_BASE}/me \\
  -H "Authorization: Bearer nck_your_key_here"`}</Block>
              <Block>{`{
  "ok": true,
  "data": {
    "business_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
    "name": "Example Dental",
    "tier": "standard",
    "status": "online",
    "timezone": "America/Phoenix",
    "webhooks_enabled": true
  }
}`}</Block>
            </Endpoint>
          </Section>

          <Section id="messages" title="Send a text">
            <Endpoint
              method="POST"
              path="/api/public/v1/messages"
              summary="Sends an SMS from the business's own number. The message is metered, logged, and appears in the owner's thread view exactly like one sent from the dashboard."
            >
              <FieldTable
                rows={[
                  ["to", "string, required", "Recipient phone number. Accepts common formats and is normalized to E.164."],
                  ["text", "string, required", "Message body, 1 to 1600 characters."]
                ]}
              />
              <Block>{`curl -X POST ${API_BASE}/messages \\
  -H "Authorization: Bearer nck_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"to": "+15551234567", "text": "Your appointment is confirmed."}'`}</Block>
              <Block>{`{
  "ok": true,
  "data": {
    "message_id": "40017c1b-0000-4000-8000-000000000000",
    "log_id": "6f1e2d3c-0000-4000-8000-000000000000",
    "channel": "sms"
  }
}`}</Block>
              <p>
                Returns <Code>409 CONFLICT</Code> when the plan&apos;s monthly message allowance is used up,
                and <Code>429</Code> when the per-minute limit is hit.
              </p>
            </Endpoint>
          </Section>

          <Section id="flow-events" title="Start an AiFlow from an event">
            <Endpoint
              method="POST"
              path="/api/public/v1/flow-events"
              summary="Delivers an external event to the flow engine. Every enabled webhook-triggered AiFlow whose conditions match the payload gets a queued run. This is how outside lead sources reach a coworker without a phone call, email, or chat."
            >
              <FieldTable
                rows={[
                  ["data", "object, required", "The event payload as a flat JSON object of lead fields. 64KB maximum."],
                  ["source", "string, optional", "Where the event came from. Matched by a flow's from_matches condition. Up to 120 characters."],
                  ["event_id", "string, optional", "Your idempotency key, for example the upstream lead id. A redelivery with the same value never enqueues twice."]
                ]}
              />
              <Block>{`curl -X POST ${API_BASE}/flow-events \\
  -H "Authorization: Bearer nck_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{
        "source": "meta_lead_ads",
        "event_id": "lead_1234567890",
        "data": {
          "lead_name": "Jordan Rivera",
          "lead_phone": "+15551234567",
          "lead_email": "jordan@example.com"
        }
      }'`}</Block>
              <Block>{`{
  "ok": true,
  "data": { "enqueued": 1, "flows_evaluated": 4, "flows_matched": 1 }
}`}</Block>
              <p>
                A response with <Code>flows_matched</Code> above zero and <Code>enqueued</Code> at zero means
                the event was a duplicate that had already been handled, which is the expected answer to a
                safe retry.
              </p>
            </Endpoint>
          </Section>

          <Section id="events" title="Read recent events">
            <Endpoint
              method="GET"
              path="/api/public/v1/events?event={type}&limit={n}"
              summary="Returns recent events of one type, shaped exactly like the payloads the webhook dispatcher delivers. Use it to poll instead of subscribing, or to fetch samples while building an integration."
            >
              <FieldTable
                rows={[
                  ["event", "string, required", "One of the event types listed below."],
                  ["limit", "integer, optional", "1 to 25, defaults to 3. Newest first."]
                ]}
              />
              <Block>{`curl "${API_BASE}/events?event=sms.inbound&limit=3" \\
  -H "Authorization: Bearer nck_your_key_here"`}</Block>
              <Block>{`{
  "ok": true,
  "data": [
    {
      "event": "sms.inbound",
      "business_id": "3fa85f64-5717-4562-b3fc-2c963f66afa6",
      "id": "0f9c7a52-0000-4000-8000-000000000000",
      "occurred_at": "2026-08-04T15:04:05.000Z",
      "data": {
        "from": "+15551234567",
        "text": "Do you have anything Friday?",
        "channel": "sms"
      }
    }
  ]
}`}</Block>
              <p>
                Every payload carries <Code>event</Code>, <Code>business_id</Code>, <Code>id</Code>, and{" "}
                <Code>occurred_at</Code> at the top level, with the event-specific fields nested under{" "}
                <Code>data</Code>. For <Code>call.completed</Code>, <Code>occurred_at</Code> is when the call
                ended, not when it started.
              </p>
            </Endpoint>
          </Section>

          <Section id="hooks" title="Webhook subscriptions">
            <p>
              Subscribe an HTTPS endpoint of yours and we will POST each matching event to it as it happens.
              A subscription only delivers events that occur after it is created, so creating one never
              replays history.
            </p>
            <div className="space-y-4">
              <Endpoint
                method="POST"
                path="/api/public/v1/hooks"
                summary="Creates a subscription and returns it with 201."
              >
                <FieldTable
                  rows={[
                    ["event", "string, required", "One of the event types listed below."],
                    ["target_url", "string, required", "Your HTTPS endpoint. Plain HTTP is rejected. Up to 2048 characters."]
                  ]}
                />
                <Block>{`curl -X POST ${API_BASE}/hooks \\
  -H "Authorization: Bearer nck_your_key_here" \\
  -H "Content-Type: application/json" \\
  -d '{"event": "sms.inbound", "target_url": "https://example.com/hooks/nc"}'`}</Block>
                <Block>{`{
  "ok": true,
  "data": {
    "id": "a1b2c3d4-0000-4000-8000-000000000000",
    "event": "sms.inbound",
    "target_url": "https://example.com/hooks/nc",
    "created_at": "2026-08-04T15:04:05.000Z"
  }
}`}</Block>
              </Endpoint>

              <Endpoint
                method="GET"
                path="/api/public/v1/hooks"
                summary="Lists the business's active subscriptions."
              >
                <Block>{`curl ${API_BASE}/hooks \\
  -H "Authorization: Bearer nck_your_key_here"`}</Block>
              </Endpoint>

              <Endpoint
                method="DELETE"
                path="/api/public/v1/hooks/{id}"
                summary="Removes one subscription. A subscription that is already gone returns 404 NOT_FOUND, which integrations can safely treat as success."
              >
                <Block>{`curl -X DELETE ${API_BASE}/hooks/a1b2c3d4-0000-4000-8000-000000000000 \\
  -H "Authorization: Bearer nck_your_key_here"`}</Block>
              </Endpoint>
            </div>
          </Section>

          <Section id="event-types" title="Event types">
            <p>
              These are the values accepted by <Code>event</Code> on both the events endpoint and webhook
              subscriptions. A payload carries the same fields either way.
            </p>
            <FieldTable
              rows={[
                ["sms.inbound", "event", "A customer texted the business."],
                ["sms.outbound", "event", "The business, or its coworker, sent a text."],
                ["call.completed", "event", "A phone call finished, with its outcome and duration."],
                ["email.inbound", "event", "An email arrived in a connected or hosted mailbox."]
              ]}
            />
          </Section>
        </div>

        <div className="mt-16 rounded-2xl border border-parchment/10 bg-parchment/[0.03] p-6">
          <h2 className="text-lg font-semibold text-parchment">Questions</h2>
          <p className="mt-2 text-sm text-parchment/70">
            Prefer not to write code? The{" "}
            <Link href="/integrations" className="text-claw-green hover:underline">
              Zapier integration
            </Link>{" "}
            covers the same ground with no API key handling of your own. For anything else, reach us from
            the{" "}
            <Link href="/contact" className="text-claw-green hover:underline">
              contact page
            </Link>
            .
          </p>
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

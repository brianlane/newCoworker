import { describe, expect, it, vi } from "vitest";
import {
  collectMailboxConnectionRefs,
  validateMailboxConnectionSteps
} from "../src/lib/ai-flows/mailbox-steps";
import { parseAiFlowDefinition } from "../src/lib/ai-flows/schema";
import type { WorkspaceOAuthConnectionRow } from "../src/lib/db/workspace-oauth-connections";

/**
 * Write-time validation for mailbox bindings (send_email.fromConnectionId and
 * send_sms.quietHours.emailFromConnectionId): the KYP Ads incident of Jul 22
 * 2026 — a flow saved pointing at a mailbox connection id that didn't exist
 * for the business — failed at SEND time with the cryptic
 * `owner-mailbox send failed (connection_not_found)` and paged the owner.
 * These checks surface the same mistake at save time instead.
 */

const BIZ = "00000000-0000-0000-0000-000000000001";
const CONN_OUTLOOK = "11111111-1111-4111-8111-111111111111";
const CONN_ZOOM = "22222222-2222-4222-8222-222222222222";
const CONN_GONE = "33333333-3333-4333-8333-333333333333";

const connRow = (id: string, providerConfigKey: string): WorkspaceOAuthConnectionRow => ({
  id,
  business_id: BIZ,
  provider_config_key: providerConfigKey,
  connection_id: `nango-${id}`,
  metadata: {},
  created_at: "2026-07-22T00:00:00Z",
  updated_at: "2026-07-22T00:00:00Z"
});

const def = (steps: unknown[]) =>
  parseAiFlowDefinition({
    version: 1,
    trigger: { channel: "webhook", conditions: [] },
    steps: [
      // Produces the vars the send steps template, so the definitions here
      // pass the schema's use-before-produce semantic check.
      {
        id: "s_extract",
        type: "extract_text",
        fields: [
          { name: "lead_email", description: "email" },
          { name: "lead_phone", description: "phone" },
          { name: "x", description: "branch key" }
        ]
      },
      ...steps
    ]
  });

const emailStep = (over: Record<string, unknown> = {}) => ({
  id: "confirm_email",
  type: "send_email",
  to: "{{vars.lead_email}}",
  subject: "hello",
  body: "hi there",
  ...over
});

const smsQuietStep = ({ id, ...quietOver }: Record<string, unknown> = {}) => ({
  id: id ?? "nudge",
  type: "send_sms",
  to: "{{vars.lead_phone}}",
  body: "hi",
  quietHours: {
    timezone: "America/Toronto",
    noSendAfter: "21:00",
    resumeAt: "11:00",
    emailFallbackVar: "lead_email",
    ...quietOver
  }
});

describe("collectMailboxConnectionRefs", () => {
  it("collects send_email fromConnectionId and quiet-hours email fallback ids, including branch arms", () => {
    const definition = def([
      emailStep({ fromConnectionId: CONN_OUTLOOK }),
      smsQuietStep({ emailFromConnectionId: CONN_GONE }),
      {
        id: "fork",
        type: "branch",
        question: "Which arm?",
        branches: [
          {
            id: "arm_a",
            label: "A",
            condition: { var: "x", equals: "1" },
            steps: [emailStep({ id: "arm_email", fromConnectionId: CONN_ZOOM })]
          }
        ],
        else: [smsQuietStep({ id: "else_nudge", emailFromConnectionId: CONN_OUTLOOK })]
      }
    ]);
    expect(collectMailboxConnectionRefs(definition)).toEqual([
      { stepId: "confirm_email", connectionId: CONN_OUTLOOK, use: "send_email" },
      { stepId: "nudge", connectionId: CONN_GONE, use: "quiet_hours_email" },
      { stepId: "arm_email", connectionId: CONN_ZOOM, use: "send_email" },
      { stepId: "else_nudge", connectionId: CONN_OUTLOOK, use: "quiet_hours_email" }
    ]);
  });

  it("ignores steps without a mailbox binding", () => {
    const definition = def([emailStep(), smsQuietStep()]);
    expect(collectMailboxConnectionRefs(definition)).toEqual([]);
  });
});

describe("validateMailboxConnectionSteps", () => {
  it("returns no issues (and never reads the DB) when nothing binds a mailbox", async () => {
    const fetchConnections = vi.fn();
    const issues = await validateMailboxConnectionSteps(BIZ, def([emailStep()]), {
      fetchConnections
    });
    expect(issues).toEqual([]);
    expect(fetchConnections).not.toHaveBeenCalled();
  });

  it("passes when every binding resolves to an email connection of the business", async () => {
    const fetchConnections = vi.fn(async () => [connRow(CONN_OUTLOOK, "outlook")]);
    const issues = await validateMailboxConnectionSteps(
      BIZ,
      def([
        emailStep({ fromConnectionId: CONN_OUTLOOK }),
        smsQuietStep({ emailFromConnectionId: CONN_OUTLOOK })
      ]),
      { fetchConnections }
    );
    expect(issues).toEqual([]);
    expect(fetchConnections).toHaveBeenCalledWith(BIZ);
  });

  it("flags a binding whose connection does not exist for the business", async () => {
    const fetchConnections = vi.fn(async () => [connRow(CONN_OUTLOOK, "outlook")]);
    const issues = await validateMailboxConnectionSteps(
      BIZ,
      def([emailStep({ fromConnectionId: CONN_GONE })]),
      { fetchConnections }
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Step "confirm_email"');
    expect(issues[0]).toContain("no longer connected");
  });

  it("flags a binding that points at a non-email connection (e.g. Zoom)", async () => {
    const fetchConnections = vi.fn(async () => [connRow(CONN_ZOOM, "zoom")]);
    const issues = await validateMailboxConnectionSteps(
      BIZ,
      def([smsQuietStep({ emailFromConnectionId: CONN_ZOOM })]),
      { fetchConnections }
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]).toContain('Step "nudge"');
    expect(issues[0]).toContain("not an email mailbox");
  });

  it("reports every bad binding, not just the first", async () => {
    const fetchConnections = vi.fn(async () => [connRow(CONN_ZOOM, "zoom")]);
    const issues = await validateMailboxConnectionSteps(
      BIZ,
      def([
        emailStep({ fromConnectionId: CONN_GONE }),
        smsQuietStep({ emailFromConnectionId: CONN_ZOOM })
      ]),
      { fetchConnections }
    );
    expect(issues).toHaveLength(2);
  });
});

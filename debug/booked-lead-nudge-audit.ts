#!/usr/bin/env tsx
/**
 * "Are we still selling to people who already booked?"
 *
 * A lead drops out of a nudge ladder for exactly two reasons: they text
 * back, or a booking observer identifies them and fast-forwards the run.
 * Identification is by phone and email, so a lead who books under a
 * DIFFERENT email than their lead form captured, with no phone on the
 * booking, is invisible to it. Patricia Jones (KYP Ads, 2026-08-19) booked
 * as kissmediagroup@gmail.com against a lead record of paojones@hotmail.com
 * and was sold to for three days afterwards. Four of that tenant's 37
 * August bookings had the same mismatch.
 *
 * The name fallback in booking-goal-fire.ts closes the common case. This
 * script is the check that it is actually working, and the way a new gap
 * gets noticed on purpose rather than by a customer complaining.
 *
 * For every business with a Calendly connection it cross-references live
 * flow runs against upcoming bookings and reports anyone who has both. A
 * name-only hit is the interesting one: it means the fallback did not fire.
 *
 * Strictly READ-ONLY: no writes, no sends, no SSH.
 *
 * Usage:
 *   tsx debug/booked-lead-nudge-audit.ts
 *   tsx debug/booked-lead-nudge-audit.ts --business <uuid>
 *   tsx debug/booked-lead-nudge-audit.ts --json
 */
import { createClient } from "@supabase/supabase-js";
import { loadEnv } from "./_shared.ts";
import { decryptIntegrationSecret } from "../src/lib/integrations/secrets.ts";
import { normalizeLeadName } from "../src/lib/ai-flows/booking-goal-fire.ts";

loadEnv();

const LIVE_STATUSES = ["awaiting_reply", "queued", "running"];

type Finding = {
  business: string;
  businessId: string;
  runId: string;
  flowId: string;
  status: string;
  leadName: string;
  leadPhone: string;
  leadEmail: string;
  bookedEmail: string;
  bookingStart: string;
  matchedBy: "email" | "name";
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

async function calendlyInvitees(
  token: string
): Promise<Array<{ name: string; email: string; start: string; phone: string }>> {
  const meRes = await fetch("https://api.calendly.com/users/me", {
    headers: { Authorization: `Bearer ${token}` }
  });
  if (!meRes.ok) return [];
  const me = (await meRes.json()) as { resource?: { current_organization?: string } };
  const org = me.resource?.current_organization;
  if (!org) return [];
  const now = new Date().toISOString();
  const evRes = await fetch(
    `https://api.calendly.com/scheduled_events?organization=${encodeURIComponent(
      org
    )}&min_start_time=${now}&count=100&status=active`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!evRes.ok) return [];
  const events = (await evRes.json()) as { collection?: Array<{ uri: string; start_time: string }> };
  const out: Array<{ name: string; email: string; start: string; phone: string }> = [];
  for (const ev of events.collection ?? []) {
    const invRes = await fetch(`${ev.uri}/invitees?count=10`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    if (!invRes.ok) continue;
    const inv = (await invRes.json()) as {
      collection?: Array<{ name?: string; email?: string; text_reminder_number?: string }>;
    };
    for (const i of inv.collection ?? []) {
      out.push({
        name: String(i.name ?? ""),
        email: String(i.email ?? "").toLowerCase(),
        start: ev.start_time,
        phone: String(i.text_reminder_number ?? "")
      });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set");
  const sb = createClient(url, key, { auth: { persistSession: false } });

  const only = arg("business");
  let q = sb.from("calendly_connections").select("business_id, account_email, access_token_encrypted");
  if (only) q = q.eq("business_id", only);
  const { data: conns, error } = await q;
  if (error) throw new Error(error.message);

  const { data: biz } = await sb.from("businesses").select("id, name");
  const nameOf = new Map((biz ?? []).map((b) => [b.id as string, b.name as string]));

  const byBusiness = new Map<string, string[]>();
  for (const c of (conns ?? []) as Array<{ business_id: string; access_token_encrypted: string }>) {
    const token = decryptIntegrationSecret(c.access_token_encrypted);
    if (!token) continue;
    byBusiness.set(c.business_id, [...(byBusiness.get(c.business_id) ?? []), token]);
  }

  const findings: Finding[] = [];
  for (const [businessId, tokens] of byBusiness) {
    const invitees = (await Promise.all(tokens.map(calendlyInvitees))).flat();
    if (invitees.length === 0) continue;

    const { data: runs } = await sb
      .from("ai_flow_runs")
      .select("id, flow_id, status, context")
      .eq("business_id", businessId)
      .in("status", LIVE_STATUSES)
      .limit(500);

    for (const run of (runs ?? []) as Array<{
      id: string;
      flow_id: string;
      status: string;
      context?: { vars?: Record<string, unknown> };
    }>) {
      const vars = run.context?.vars ?? {};
      const leadEmail = String(vars.lead_email ?? "").toLowerCase();
      const leadName = String(vars.lead_name ?? "");
      const wanted = normalizeLeadName(leadName);
      const byEmail = leadEmail ? invitees.find((i) => i.email === leadEmail) : undefined;
      const byName = wanted
        ? invitees.find((i) => normalizeLeadName(i.name) === wanted)
        : undefined;
      const hit = byEmail ?? byName;
      if (!hit) continue;
      findings.push({
        business: nameOf.get(businessId) ?? businessId,
        businessId,
        runId: run.id,
        flowId: run.flow_id,
        status: run.status,
        leadName,
        leadPhone: String(vars.lead_phone ?? ""),
        leadEmail,
        bookedEmail: hit.email,
        bookingStart: hit.start,
        matchedBy: byEmail ? "email" : "name"
      });
    }
  }

  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(findings, null, 2));
    return;
  }

  const nameOnly = findings.filter((f) => f.matchedBy === "name");
  console.log(
    `Live runs whose lead already has an upcoming booking: ${findings.length} ` +
      `(${nameOnly.length} identified only by NAME)\n`
  );
  for (const f of findings) {
    console.log(
      `${f.matchedBy === "name" ? "NAME-ONLY" : "email    "}  ${f.business}  run ${f.runId.slice(
        0,
        8
      )} (${f.status}) flow ${f.flowId.slice(0, 8)}\n` +
        `           ${f.leadName} ${f.leadPhone}\n` +
        `           lead <${f.leadEmail || "-"}>  booked <${f.bookedEmail}>  starts ${f.bookingStart}`
    );
  }
  if (nameOnly.length > 0) {
    // A booking follow-up flow SHOULD have a live run for a booked person.
    // A nudge ladder should not, and a name-only hit means the fallback in
    // booking-goal-fire.ts did not identify them.
    console.log(
      "\nName-only hits mean the booking was not matched by phone or email. " +
        "Check the flow: a booking follow-up is expected here, a lead nudge ladder is not."
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

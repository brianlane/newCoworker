/**
 * Calendly needs_reauth against the REAL schema.
 *
 * A mocked query builder would pass every helper against columns that were
 * never created (docs/AUDIT-2026-08.md, Lesson 1). This file proves:
 *   - needs_reauth / last_healthy_at / reauth_email_* exist and round-trip
 *   - listActive filters the flagged row and keeps a healthy sibling
 *   - pause copy only appears when EVERY Calendly account is flagged
 *   - Reconnect writes the new PAT onto the SAME id and clears the flags
 *   - the reminder query (count < 2, last_sent older than 24h) is a real
 *     filter against those columns, not a mocked builder against a missing one
 */
import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

if (!process.env.INTEGRATIONS_ENCRYPTION_KEY && !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  process.env.SUPABASE_SERVICE_ROLE_KEY = process.env.ITEST_SERVICE_ROLE_KEY ?? "";
}

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}));
vi.mock("@/lib/db/system-logs", () => ({ recordSystemLog: vi.fn() }));

import { seedBusiness, serviceDb } from "./harness";
import {
  calendlyCalendarPauseState,
  listActiveCalendlyConnections,
  listPublicCalendlyConnections,
  saveCalendlyConnection
} from "@/lib/db/calendly-connections";
import {
  CALENDLY_CALENDAR_PAUSED_COPY,
  listCalendlyReauthBannerState,
  markCalendlyConnectionNeedsReauth,
  processCalendlyReauthReminders,
  stampCalendlyConnectionHealthy
} from "@/lib/calendly/reauth";
import { recordSystemLog } from "@/lib/db/system-logs";

const JAMES_URI = "https://api.calendly.com/users/james-itest";
const LIZ_URI = "https://api.calendly.com/users/liz-itest";

function dispatchOk() {
  return vi.fn(async () => ({
    results: [{ channel: "email" as const, status: "sent" as const, notificationId: "n1" }]
  }));
}

async function insertConnection(
  db: ReturnType<typeof serviceDb>,
  businessId: string,
  over: {
    user_uri: string;
    account_name: string;
    account_email: string;
    needs_reauth?: boolean;
    reauth_email_count?: number;
    reauth_email_last_sent_at?: string | null;
    last_healthy_at?: string | null;
  }
): Promise<string> {
  const id = randomUUID();
  const { error } = await db.from("calendly_connections").insert({
    id,
    business_id: businessId,
    access_token_encrypted: `itest-pat-${id.slice(0, 8)}`,
    account_name: over.account_name,
    account_email: over.account_email,
    user_uri: over.user_uri,
    is_active: true,
    needs_reauth: over.needs_reauth ?? false,
    reauth_email_count: over.reauth_email_count ?? 0,
    reauth_email_last_sent_at: over.reauth_email_last_sent_at ?? null,
    last_healthy_at: over.last_healthy_at ?? null
  });
  if (error) throw new Error(`insertConnection: ${error.message}`);
  return id;
}

describe("calendly_connections needs_reauth (real schema)", () => {
  const db = serviceDb();

  beforeEach(() => {
    vi.mocked(recordSystemLog).mockResolvedValue(undefined as never);
  });

  it("flips ONLY the rejected account, keeps the sibling active, pause copy waits for both", async () => {
    const businessId = await seedBusiness(db, "Calendly reauth sibling");
    const jamesId = await insertConnection(db, businessId, {
      user_uri: JAMES_URI,
      account_name: "James Lee",
      account_email: "james@kyp.test",
      last_healthy_at: "2026-09-16T12:01:00.000Z"
    });
    const lizId = await insertConnection(db, businessId, {
      user_uri: LIZ_URI,
      account_name: "Elizabeth Stone",
      account_email: "liz@lizdev.test",
      last_healthy_at: "2026-09-16T12:01:00.000Z"
    });

    const dispatch = dispatchOk();
    const flipped = await markCalendlyConnectionNeedsReauth(jamesId, {
      client: db as never,
      dispatch: dispatch as never,
      now: () => Date.parse("2026-09-17T02:11:00.000Z")
    });
    expect(flipped).toEqual({ flipped: true, emailed: true });
    expect(dispatch).toHaveBeenCalledTimes(1);

    const { data: james, error } = await db
      .from("calendly_connections")
      .select("needs_reauth,reauth_email_count,reauth_email_last_sent_at,is_active")
      .eq("id", jamesId)
      .single();
    if (error) throw new Error(error.message);
    expect(james.needs_reauth).toBe(true);
    expect(james.is_active).toBe(true);
    expect(james.reauth_email_count).toBe(1);
    expect(james.reauth_email_last_sent_at).toBeTruthy();

    const active = await listActiveCalendlyConnections(businessId, db as never);
    expect(active.map((r) => r.id)).toEqual([lizId]);

    const pauseWhileLizHealthy = await calendlyCalendarPauseState(businessId, db as never);
    expect(pauseWhileLizHealthy.pausedCopy).toBeNull();
    expect(pauseWhileLizHealthy.needingReauth.map((r) => r.id)).toEqual([jamesId]);

    const banners = await listCalendlyReauthBannerState(businessId, db as never);
    expect(banners).toHaveLength(1);
    expect(banners[0].id).toBe(jamesId);
    expect(banners[0].accountLabel).toBe("James Lee");
    expect(banners[0].reconnectPath).toContain(jamesId);

    await markCalendlyConnectionNeedsReauth(lizId, {
      client: db as never,
      dispatch: dispatchOk() as never
    });
    const pauseAllBroken = await calendlyCalendarPauseState(businessId, db as never);
    expect(pauseAllBroken.pausedCopy).toBe(CALENDLY_CALENDAR_PAUSED_COPY);
  });

  it("reconnect writes the new token onto the SAME row and clears banner/email state", async () => {
    const businessId = await seedBusiness(db, "Calendly reauth reconnect");
    const jamesId = await insertConnection(db, businessId, {
      user_uri: JAMES_URI,
      account_name: "James Lee",
      account_email: "james@kyp.test",
      needs_reauth: true,
      reauth_email_count: 2,
      reauth_email_last_sent_at: "2026-09-17T02:11:00.000Z"
    });

    const saved = await saveCalendlyConnection(
      {
        businessId,
        accessToken: "new-pat-after-reconnect",
        userUri: JAMES_URI,
        accountName: "James Lee",
        accountEmail: "james@kyp.test",
        connectionId: jamesId
      },
      db as never
    );
    expect(saved.created).toBe(false);
    expect(saved.connection.id).toBe(jamesId);
    expect(saved.connection.needs_reauth).toBe(false);
    expect(saved.connection.reauth_email_count).toBe(0);
    expect(saved.connection.reauth_email_last_sent_at).toBeNull();

    const active = await listActiveCalendlyConnections(businessId, db as never);
    expect(active).toHaveLength(1);
    expect(active[0].id).toBe(jamesId);
    expect(active[0].accessToken).toBe("new-pat-after-reconnect");

    expect(await listCalendlyReauthBannerState(businessId, db as never)).toEqual([]);
    expect((await calendlyCalendarPauseState(businessId, db as never)).pausedCopy).toBeNull();
  });

  it("does not stamp last_healthy_at on a flagged row; reminder query hits the real columns", async () => {
    const businessId = await seedBusiness(db, "Calendly reauth reminder");
    const now = Date.parse("2026-09-18T02:11:00.000Z");
    const jamesId = await insertConnection(db, businessId, {
      user_uri: JAMES_URI,
      account_name: "James Lee",
      account_email: "james@kyp.test",
      needs_reauth: true,
      reauth_email_count: 1,
      reauth_email_last_sent_at: new Date(now - 25 * 60 * 60 * 1000).toISOString(),
      last_healthy_at: "2026-09-16T12:01:00.000Z"
    });

    await stampCalendlyConnectionHealthy(jamesId, { client: db as never, now: () => now });
    const { data: stillFlagged, error } = await db
      .from("calendly_connections")
      .select("last_healthy_at,needs_reauth")
      .eq("id", jamesId)
      .single();
    if (error) throw new Error(error.message);
    expect(stillFlagged.needs_reauth).toBe(true);
    expect(Date.parse(stillFlagged.last_healthy_at as string)).toBe(
      Date.parse("2026-09-16T12:01:00.000Z")
    );

    const dispatch = dispatchOk();
    await processCalendlyReauthReminders({
      client: db as never,
      dispatch: dispatch as never,
      now: () => now
    });
    expect(dispatch).toHaveBeenCalled();

    const { data: after } = await db
      .from("calendly_connections")
      .select("reauth_email_count")
      .eq("id", jamesId)
      .single();
    expect(after?.reauth_email_count).toBe(2);

    // A later tick must not email THIS row a third time. Other tenants in
    // the shared itest DB may still be due, so we assert the row, not the
    // global emailed count.
    await processCalendlyReauthReminders({
      client: db as never,
      dispatch: dispatchOk() as never,
      now: () => now + 48 * 60 * 60 * 1000
    });
    const { data: still } = await db
      .from("calendly_connections")
      .select("reauth_email_count")
      .eq("id", jamesId)
      .single();
    expect(still?.reauth_email_count).toBe(2);

    const publicRows = await listPublicCalendlyConnections(businessId, db as never);
    expect(publicRows[0]?.needs_reauth).toBe(true);
  });
});

/**
 * Zoom + Google needs_reauth against the REAL schema.
 *
 * A mocked query builder would pass every helper against columns that were
 * never created (docs/AUDIT-2026-08.md, Lesson 1). This file proves:
 *   - needs_reauth / last_healthy_at / reauth_email_* exist and round-trip
 *   - flipping Zoom does not touch a Google sibling on the same business
 *   - flipping one Google mailbox leaves the other Google mailbox healthy
 *   - Reconnect writes the new grant onto the SAME id and clears the flags
 *   - the reminder query (count < 2, last_sent older than 24h) is a real
 *     filter against those columns
 *   - Calendly still uses calendly_connections / calendly_needs_reauth
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
  getActiveZoomConnection,
  upsertZoomConnection
} from "@/lib/db/zoom-connections";
import { listWorkspaceOAuthConnections } from "@/lib/db/workspace-oauth-connections";
import {
  listConnectionReauthBannerState,
  markConnectionNeedsReauth,
  processConnectionReauthReminders
} from "@/lib/connections/reauth";
import {
  CONNECTION_REAUTH_KIND,
  CONNECTION_REAUTH_REMINDER_MS,
  clearedReauthFields
} from "@/lib/connections/reauth-copy";
import { CALENDLY_REAUTH_KIND } from "@/lib/calendly/reauth-copy";
import { recordSystemLog } from "@/lib/db/system-logs";

function dispatchOk() {
  return vi.fn(async () => ({
    results: [{ channel: "email" as const, status: "sent" as const, notificationId: "n1" }]
  }));
}

async function insertZoom(
  db: ReturnType<typeof serviceDb>,
  businessId: string,
  over: {
    needs_reauth?: boolean;
    reauth_email_count?: number;
    reauth_email_last_sent_at?: string | null;
    last_healthy_at?: string | null;
    account_name?: string;
  } = {}
): Promise<string> {
  const id = randomUUID();
  const { error } = await db.from("zoom_connections").insert({
    id,
    business_id: businessId,
    access_token_encrypted: `itest-zoom-at-${id.slice(0, 8)}`,
    refresh_token_encrypted: `itest-zoom-rt-${id.slice(0, 8)}`,
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    account_name: over.account_name ?? "Acme Zoom",
    account_email: "zoom@acme.test",
    is_active: true,
    needs_reauth: over.needs_reauth ?? false,
    reauth_email_count: over.reauth_email_count ?? 0,
    reauth_email_last_sent_at: over.reauth_email_last_sent_at ?? null,
    last_healthy_at: over.last_healthy_at ?? "2026-09-16T12:01:00.000Z"
  });
  if (error) throw new Error(`insertZoom: ${error.message}`);
  return id;
}

async function insertGoogle(
  db: ReturnType<typeof serviceDb>,
  businessId: string,
  over: {
    email: string;
    name: string;
    needs_reauth?: boolean;
  }
): Promise<string> {
  const id = randomUUID();
  const { error } = await db.from("workspace_oauth_connections").insert({
    id,
    business_id: businessId,
    provider_config_key: "google",
    connection_id: `direct:${id}`,
    metadata: {
      provider_account_email: over.email,
      provider_account_display_name: over.name
    },
    transport: "direct",
    is_active: true,
    access_token_encrypted: `itest-google-at-${id.slice(0, 8)}`,
    refresh_token_encrypted: `itest-google-rt-${id.slice(0, 8)}`,
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    needs_reauth: over.needs_reauth ?? false,
    last_healthy_at: "2026-09-16T12:01:00.000Z"
  });
  if (error) throw new Error(`insertGoogle: ${error.message}`);
  return id;
}

describe("oauth connection needs_reauth (real schema)", () => {
  const db = serviceDb();

  beforeEach(() => {
    vi.mocked(recordSystemLog).mockResolvedValue(undefined as never);
  });

  it("keeps Calendly on its own kind so this PR cannot rewrite #1868", () => {
    expect(CALENDLY_REAUTH_KIND).toBe("calendly_needs_reauth");
    expect(CONNECTION_REAUTH_KIND).toBe("connection_needs_reauth");
    expect(CALENDLY_REAUTH_KIND).not.toBe(CONNECTION_REAUTH_KIND);
  });

  it("flips ONLY the rejected Zoom row and leaves a Google sibling healthy", async () => {
    const businessId = await seedBusiness(db, "OAuth reauth zoom+google");
    const zoomId = await insertZoom(db, businessId);
    const googleId = await insertGoogle(db, businessId, {
      email: "james@kyp.test",
      name: "James Lee"
    });

    const dispatch = dispatchOk();
    const flipped = await markConnectionNeedsReauth("zoom_connections", zoomId, {
      client: db as never,
      dispatch: dispatch as never,
      now: () => Date.parse("2026-09-17T02:11:00.000Z")
    });
    expect(flipped).toEqual({ flipped: true, emailed: true });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ kind: CONNECTION_REAUTH_KIND })
    );

    const { data: zoom, error } = await db
      .from("zoom_connections")
      .select("needs_reauth,reauth_email_count,is_active")
      .eq("id", zoomId)
      .single();
    if (error) throw new Error(error.message);
    expect(zoom.needs_reauth).toBe(true);
    expect(zoom.is_active).toBe(true);
    expect(zoom.reauth_email_count).toBe(1);

    const { data: google } = await db
      .from("workspace_oauth_connections")
      .select("needs_reauth")
      .eq("id", googleId)
      .single();
    expect(google?.needs_reauth).toBe(false);

    expect(await getActiveZoomConnection(businessId, db as never)).toBeNull();

    const banners = await listConnectionReauthBannerState(businessId, db as never);
    expect(banners).toHaveLength(1);
    expect(banners[0].provider).toBe("Zoom");
    expect(banners[0].reconnectPath).toContain(zoomId);
  });

  it("flips only one Google mailbox; the sibling stays Connected", async () => {
    const businessId = await seedBusiness(db, "OAuth reauth google siblings");
    const jamesId = await insertGoogle(db, businessId, {
      email: "james@kyp.test",
      name: "James Lee"
    });
    const lizId = await insertGoogle(db, businessId, {
      email: "liz@lizdev.test",
      name: "Elizabeth Stone"
    });

    await markConnectionNeedsReauth("workspace_oauth_connections", jamesId, {
      client: db as never,
      dispatch: dispatchOk() as never
    });

    const rows = await listWorkspaceOAuthConnections(businessId, db as never);
    const james = rows.find((r) => r.id === jamesId);
    const liz = rows.find((r) => r.id === lizId);
    expect(james?.needs_reauth).toBe(true);
    expect(liz?.needs_reauth).toBe(false);
    expect(liz?.is_active).toBe(true);

    const banners = await listConnectionReauthBannerState(businessId, db as never);
    expect(banners.map((b) => b.id)).toEqual([jamesId]);
    expect(banners[0].provider).toBe("Google");
  });

  it("reconnect upserts Zoom onto the SAME row and clears banner/email state", async () => {
    const businessId = await seedBusiness(db, "OAuth reauth zoom reconnect");
    const zoomId = await insertZoom(db, businessId, {
      needs_reauth: true,
      reauth_email_count: 2,
      reauth_email_last_sent_at: "2026-09-17T02:11:00.000Z"
    });

    const saved = await upsertZoomConnection(
      {
        businessId,
        accessToken: "new-access-after-reconnect",
        refreshToken: "new-refresh-after-reconnect",
        expiresAt: new Date(Date.now() + 3_600_000),
        accountName: "Acme Zoom",
        accountEmail: "zoom@acme.test",
        clientEnv: "production"
      },
      db as never
    );
    expect(saved.id).toBe(zoomId);
    expect(saved.needs_reauth).toBe(false);
    expect(saved.reauth_email_count).toBe(0);
    expect(saved.reauth_email_last_sent_at).toBeNull();
    expect(saved.last_healthy_at).toBeTruthy();

    const banners = await listConnectionReauthBannerState(businessId, db as never);
    expect(banners).toEqual([]);
    expect(clearedReauthFields("2026-09-18T00:00:00.000Z").needs_reauth).toBe(false);
  });

  it("emails once more after a day, then stops", async () => {
    const businessId = await seedBusiness(db, "OAuth reauth cadence");
    const now = Date.parse("2026-09-18T02:11:00.000Z");
    const zoomId = await insertZoom(db, businessId, {
      needs_reauth: true,
      reauth_email_count: 1,
      reauth_email_last_sent_at: new Date(now - CONNECTION_REAUTH_REMINDER_MS).toISOString()
    });

    const dispatch = dispatchOk();
    await processConnectionReauthReminders({
      client: db as never,
      dispatch: dispatch as never,
      now: () => now
    });
    expect(dispatch).toHaveBeenCalled();

    const { data: after } = await db
      .from("zoom_connections")
      .select("reauth_email_count")
      .eq("id", zoomId)
      .single();
    expect(after?.reauth_email_count).toBe(2);

    await processConnectionReauthReminders({
      client: db as never,
      dispatch: dispatchOk() as never,
      now: () => now + 48 * 60 * 60 * 1000
    });
    const { data: still } = await db
      .from("zoom_connections")
      .select("reauth_email_count")
      .eq("id", zoomId)
      .single();
    expect(still?.reauth_email_count).toBe(2);
  });
});

/**
 * Connections for the team-chat channels that live on the shared pipeline.
 *
 * Slack is NOT here. Its `slack_connections` row is wired into the OAuth
 * install, the callback, the management route, the uninstall webhook and the
 * integrations UI, and moving it buys nothing for a new channel. The channel
 * adapter owns connection loading, so Slack reads its own table behind the
 * same seam and this one serves everybody added since.
 *
 * Service-role only (RLS on, no policies), matching slack_connections.
 *
 * The credential is encrypted at rest with the same envelope every other
 * integration secret uses, and is NEVER selected by the public read below.
 * A dashboard needs to know that a connection exists and where its alerts
 * go; it never needs the bot token, and a route that cannot accidentally
 * serialise one cannot leak one.
 */

import { createSupabaseServiceClient } from "@/lib/supabase/server";
import { decryptIntegrationSecret, encryptIntegrationSecret } from "@/lib/integrations/secrets";
import { logger } from "@/lib/logger";
import type { CoworkerChannel } from "@/lib/db/coworker-chat";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** Everything except the secret. Safe to hand to a dashboard route. */
export type PublicCoworkerConnectionRow = {
  id: string;
  business_id: string;
  channel: CoworkerChannel;
  external_workspace_id: string;
  external_workspace_name: string | null;
  alert_target_id: string | null;
  alert_target_name: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

/** The same row with the decrypted credential, for the send paths. */
export type CoworkerConnectionRow = PublicCoworkerConnectionRow & {
  credential: string;
  webhookSecret: string | null;
};

const PUBLIC_COLUMNS =
  "id,business_id,channel,external_workspace_id,external_workspace_name," +
  "alert_target_id,alert_target_name,is_active,created_at,updated_at";

const FULL_COLUMNS = `${PUBLIC_COLUMNS},credentials_encrypted,webhook_secret`;

type StoredRow = PublicCoworkerConnectionRow & {
  credentials_encrypted: string;
  webhook_secret: string | null;
};

/**
 * An undecryptable credential is reported as EMPTY, not as a throw. The
 * column is NOT NULL, so this only happens when the encryption key rotated
 * out from under a stored row, and every caller already treats an empty
 * credential as "needs reconnect". Throwing instead would turn one tenant's
 * stale row into a failed worker pass for everybody in the batch.
 */
function hydrate(row: StoredRow): CoworkerConnectionRow {
  const { credentials_encrypted: enc, webhook_secret: secret, ...rest } = row;
  let credential = "";
  if (typeof enc === "string" && enc.length > 0) {
    try {
      // Returns null for an empty input, which the guard above already
      // excluded; coalesce anyway so a future signature change cannot
      // quietly put a null where every caller expects a string.
      credential = decryptIntegrationSecret(enc) ?? "";
    } catch (err) {
      logger.error("coworker connection: credential could not be decrypted", {
        businessId: rest.business_id,
        channel: rest.channel,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { ...rest, credential, webhookSecret: secret };
}

export class CoworkerWorkspaceAlreadyLinkedError extends Error {
  constructor(channel: string) {
    super(`That ${channel} account is already connected to a different business.`);
    this.name = "CoworkerWorkspaceAlreadyLinkedError";
  }
}

export async function getCoworkerConnection(
  businessId: string,
  channel: CoworkerChannel,
  client?: SupabaseClient
): Promise<CoworkerConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_connections")
    .select(FULL_COLUMNS)
    .eq("business_id", businessId)
    .eq("channel", channel)
    .maybeSingle();
  if (error) throw new Error(`getCoworkerConnection: ${error.message}`);
  return data ? hydrate(data as StoredRow) : null;
}

/**
 * Null unless the connection exists AND the owner has not paused it.
 *
 * Deliberately does NOT require a credential. Not every channel stores one:
 * Teams authenticates with our own Azure app credentials rather than a
 * per-tenant secret, so its row carries an empty string by design, and a
 * blanket "empty credential means dead" rule here would make Teams look
 * permanently disconnected. The channels that DO hold a secret check it
 * themselves, where "empty" means the specific thing they can act on
 * (needs reconnect).
 */
export async function getActiveCoworkerConnection(
  businessId: string,
  channel: CoworkerChannel,
  client?: SupabaseClient
): Promise<CoworkerConnectionRow | null> {
  const row = await getCoworkerConnection(businessId, channel, client);
  if (!row || !row.is_active) return null;
  return row;
}

/**
 * Route an inbound event to its business.
 *
 * This is the tenant boundary, so it is deliberately keyed on the
 * PROVIDER's own workspace id and nothing the sender can assert. An event
 * whose workspace is not bound here belongs to nobody and is dropped.
 */
export async function getCoworkerConnectionByWorkspaceForChannel(
  channel: CoworkerChannel,
  externalWorkspaceId: string,
  client?: SupabaseClient
): Promise<CoworkerConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_connections")
    .select(FULL_COLUMNS)
    .eq("channel", channel)
    .eq("external_workspace_id", externalWorkspaceId)
    .maybeSingle();
  if (error) throw new Error(`getCoworkerConnectionByWorkspace: ${error.message}`);
  return data ? hydrate(data as StoredRow) : null;
}

/** Existence and settings only; never the credential. */
export async function getPublicCoworkerConnection(
  businessId: string,
  channel: CoworkerChannel,
  client?: SupabaseClient
): Promise<PublicCoworkerConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_connections")
    .select(PUBLIC_COLUMNS)
    .eq("business_id", businessId)
    .eq("channel", channel)
    .maybeSingle();
  if (error) throw new Error(`getPublicCoworkerConnection: ${error.message}`);
  return (data as PublicCoworkerConnectionRow | null) ?? null;
}

export async function upsertCoworkerConnection(
  input: {
    businessId: string;
    channel: CoworkerChannel;
    externalWorkspaceId: string;
    externalWorkspaceName?: string | null;
    credential: string;
    webhookSecret?: string | null;
    installedByUserId?: string | null;
  },
  client?: SupabaseClient
): Promise<PublicCoworkerConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());

  // Refuse a workspace another business already owns, BEFORE writing.
  // Without this the unique index would still hold, but the error surfaces
  // as an opaque 23505 the connect route cannot explain to whoever is
  // standing at the settings page.
  const existing = await getCoworkerConnectionByWorkspaceForChannel(
    input.channel,
    input.externalWorkspaceId,
    db
  );
  if (existing && existing.business_id !== input.businessId) {
    throw new CoworkerWorkspaceAlreadyLinkedError(input.channel);
  }

  const { data, error } = await db
    .from("coworker_connections")
    .upsert(
      {
        business_id: input.businessId,
        channel: input.channel,
        external_workspace_id: input.externalWorkspaceId,
        external_workspace_name: input.externalWorkspaceName ?? null,
        credentials_encrypted: encryptIntegrationSecret(input.credential),
        webhook_secret: input.webhookSecret ?? null,
        installed_by_user_id: input.installedByUserId ?? null,
        // A reconnect un-pauses: the owner just proved they want it working.
        is_active: true,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,channel" }
    )
    .select(PUBLIC_COLUMNS)
    .single();
  if (error) throw new Error(`upsertCoworkerConnection: ${error.message}`);
  return data as unknown as PublicCoworkerConnectionRow;
}

/** Where alerts go. Stored only after a hello post proved it deliverable. */
export async function setCoworkerAlertTarget(
  businessId: string,
  channel: CoworkerChannel,
  target: { id: string; name: string | null },
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("coworker_connections")
    .update({
      alert_target_id: target.id,
      alert_target_name: target.name,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId)
    .eq("channel", channel);
  if (error) throw new Error(`setCoworkerAlertTarget: ${error.message}`);
}

/** Owner pause / resume. Keeps the credential so resuming needs no reconnect. */
export async function setCoworkerConnectionActive(
  businessId: string,
  channel: CoworkerChannel,
  isActive: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("coworker_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("business_id", businessId)
    .eq("channel", channel);
  if (error) throw new Error(`setCoworkerConnectionActive: ${error.message}`);
}

export async function deleteCoworkerConnection(
  businessId: string,
  channel: CoworkerChannel,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("coworker_connections")
    .delete()
    .eq("business_id", businessId)
    .eq("channel", channel);
  if (error) throw new Error(`deleteCoworkerConnection: ${error.message}`);
}

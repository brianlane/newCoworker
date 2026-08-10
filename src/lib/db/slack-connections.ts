/**
 * Per-business Slack workspace connections (`slack_connections`).
 *
 * One row per business holding the workspace identity and the bot token
 * (xoxb, non-expiring, no refresh), encrypted at rest via
 * `@/lib/integrations/secrets` (same crypto as zoom_connections). The
 * workspace is also unique in the other direction: `team_id` resolves
 * inbound webhook events to exactly one tenant.
 *
 * Service-role only: RLS is on with no policies. Decrypted tokens never
 * leave a server-side function; the dashboard gets
 * `toPublicSlackConnection` (has_bot_token flag, no ciphertext).
 */
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  decryptIntegrationSecret,
  encryptIntegrationSecret
} from "@/lib/integrations/secrets";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

type StoredSlackConnectionRow = {
  id: string;
  business_id: string;
  team_id: string;
  team_name: string | null;
  enterprise_id: string | null;
  bot_user_id: string;
  app_id: string;
  bot_token_encrypted: string;
  scopes: string;
  alert_channel_id: string | null;
  alert_channel_name: string | null;
  is_active: boolean;
  installed_by_user_id: string | null;
  created_at: string;
  updated_at: string;
};

/** Decrypted row, server-side use only (Web API calls). */
export type SlackConnectionRow = Omit<StoredSlackConnectionRow, "bot_token_encrypted"> & {
  botToken: string;
};

/** Dashboard-facing shape: no token material at all. */
export type PublicSlackConnectionRow = Omit<
  StoredSlackConnectionRow,
  "bot_token_encrypted"
> & {
  has_bot_token: boolean;
};

const ALL_COLUMNS =
  "id,business_id,team_id,team_name,enterprise_id,bot_user_id,app_id," +
  "bot_token_encrypted,scopes,alert_channel_id,alert_channel_name," +
  "is_active,installed_by_user_id,created_at,updated_at";

/** Raised when a workspace is already linked to a different business. */
export class SlackWorkspaceAlreadyLinkedError extends Error {
  constructor() {
    super("This Slack workspace is already connected to another business");
    this.name = "SlackWorkspaceAlreadyLinkedError";
  }
}

function toDecryptedRow(row: StoredSlackConnectionRow): SlackConnectionRow {
  const { bot_token_encrypted: enc, ...rest } = row;
  if (enc.length === 0) {
    // Deliberately wiped token (Slack-side uninstall): the row survives so
    // the dashboard shows "Needs reconnect", but there is no bearer.
    return { ...rest, botToken: "" };
  }
  const botToken = decryptIntegrationSecret(enc);
  if (botToken === null) {
    // NOT NULL column, so this only happens on an undecryptable stored
    // value; fail closed rather than calling Slack with an empty bearer.
    throw new Error("slack connection has no stored bot token");
  }
  return { ...rest, botToken };
}

export function toPublicSlackConnection(
  row: StoredSlackConnectionRow
): PublicSlackConnectionRow {
  const { bot_token_encrypted, ...rest } = row;
  return { ...rest, has_bot_token: bot_token_encrypted.length > 0 };
}

/** The business's connection with the token decrypted, or null. */
export async function getSlackConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<SlackConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("slack_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getSlackConnection: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredSlackConnectionRow);
}

/** Active connection with a usable token, the delivery-path gate. */
export async function getActiveSlackConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<SlackConnectionRow | null> {
  const row = await getSlackConnection(businessId, client);
  return row && row.is_active && row.botToken.length > 0 ? row : null;
}

/** Dashboard listing shape (no decrypt, masked). Null when not connected. */
export async function getPublicSlackConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<PublicSlackConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("slack_connections")
    .select(ALL_COLUMNS)
    .eq("business_id", businessId)
    .maybeSingle();
  if (error) throw new Error(`getPublicSlackConnection: ${error.message}`);
  if (!data) return null;
  return toPublicSlackConnection(data as unknown as StoredSlackConnectionRow);
}

/** Webhook routing: resolve the tenant behind a delivery's team_id. */
export async function getSlackConnectionByTeamId(
  teamId: string,
  client?: SupabaseClient
): Promise<SlackConnectionRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("slack_connections")
    .select(ALL_COLUMNS)
    .eq("team_id", teamId)
    .maybeSingle();
  if (error) throw new Error(`getSlackConnectionByTeamId: ${error.message}`);
  if (!data) return null;
  return toDecryptedRow(data as unknown as StoredSlackConnectionRow);
}

export type UpsertSlackConnectionInput = {
  businessId: string;
  teamId: string;
  teamName: string | null;
  enterpriseId: string | null;
  botUserId: string;
  appId: string;
  botToken: string;
  scopes: string;
  installedByUserId: string | null;
};

/**
 * Create or replace the business's single connection (connect / reconnect
 * flow). A reconnect always re-activates the row and replaces the token.
 * When the same workspace is already linked to a DIFFERENT business, the
 * team_id unique index refuses and this throws
 * {@link SlackWorkspaceAlreadyLinkedError} for the callback to surface.
 */
export async function upsertSlackConnection(
  input: UpsertSlackConnectionInput,
  client?: SupabaseClient
): Promise<PublicSlackConnectionRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const values = {
    team_id: input.teamId,
    team_name: input.teamName,
    enterprise_id: input.enterpriseId,
    bot_user_id: input.botUserId,
    app_id: input.appId,
    bot_token_encrypted: encryptIntegrationSecret(input.botToken),
    scopes: input.scopes,
    is_active: true,
    installed_by_user_id: input.installedByUserId
  };

  const { data: existing, error: readError } = await db
    .from("slack_connections")
    .select("id")
    .eq("business_id", input.businessId)
    .maybeSingle();
  if (readError) throw new Error(`upsertSlackConnection: ${readError.message}`);

  const isUniqueViolation = (message: string, code?: string) =>
    code === "23505" || /uq_slack_connections_team/.test(message);

  if (!existing) {
    const { data, error } = await db
      .from("slack_connections")
      .insert({ business_id: input.businessId, ...values })
      .select(ALL_COLUMNS)
      .single();
    if (error) {
      if (isUniqueViolation(error.message, (error as { code?: string }).code)) {
        throw new SlackWorkspaceAlreadyLinkedError();
      }
      throw new Error(`upsertSlackConnection: ${error.message}`);
    }
    return toPublicSlackConnection(data as unknown as StoredSlackConnectionRow);
  }

  const { data, error } = await db
    .from("slack_connections")
    .update({ ...values, updated_at: new Date().toISOString() })
    .eq("business_id", input.businessId)
    .select(ALL_COLUMNS)
    .single();
  if (error) {
    if (isUniqueViolation(error.message, (error as { code?: string }).code)) {
      throw new SlackWorkspaceAlreadyLinkedError();
    }
    throw new Error(`upsertSlackConnection: ${error.message}`);
  }
  return toPublicSlackConnection(data as unknown as StoredSlackConnectionRow);
}

/**
 * Store the owner's chosen alert channel. Written only after a successful
 * hello post proved the bot can deliver there (the PATCH route's job).
 */
export async function setSlackAlertChannel(
  businessId: string,
  channel: { id: string; name: string } | null,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("slack_connections")
    .update({
      alert_channel_id: channel?.id ?? null,
      alert_channel_name: channel?.name ?? null,
      updated_at: new Date().toISOString()
    })
    .eq("business_id", businessId);
  if (error) throw new Error(`setSlackAlertChannel: ${error.message}`);
}

/** Soft-disable / re-enable by the owner. */
export async function setSlackConnectionActive(
  businessId: string,
  isActive: boolean,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("slack_connections")
    .update({ is_active: isActive, updated_at: new Date().toISOString() })
    .eq("business_id", businessId);
  if (error) throw new Error(`setSlackConnectionActive: ${error.message}`);
}

export async function deleteSlackConnection(
  businessId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("slack_connections")
    .delete()
    .eq("business_id", businessId);
  if (error) throw new Error(`deleteSlackConnection: ${error.message}`);
}

/**
 * Slack-side uninstall (app_uninstalled / tokens_revoked webhooks): the bot
 * token is dead at Slack the moment the workspace removes the app, so wipe
 * it and flip the row inactive in one update, keyed by team_id (all these
 * deliveries carry). The row survives so the dashboard card shows "Needs
 * reconnect" rather than pretending the business never connected.
 */
export async function markSlackConnectionDeauthorizedByTeamId(
  teamId: string,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("slack_connections")
    .update({
      is_active: false,
      bot_token_encrypted: "",
      updated_at: new Date().toISOString()
    })
    .eq("team_id", teamId);
  if (error) throw new Error(`markSlackConnectionDeauthorizedByTeamId: ${error.message}`);
}

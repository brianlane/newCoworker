/**
 * Who a channel account belongs to, and the enrolment codes that establish
 * it.
 *
 * `resolveSurfaceSpeaker` answers owner / teammate / customer from a phone
 * number or an email address, and every channel before Telegram supplied
 * one of those: a verified Slack profile email, a Workspace address on
 * Google Chat, an Entra identity on Teams, and a WhatsApp psid that IS a
 * confirmed phone number. A Telegram `from.id` is an opaque integer and a
 * @username is self-chosen and re-assignable, so the binding has to be made
 * once, deliberately, and recorded.
 *
 * THE CODE IS STORED HASHED AND REDEEMED EXACTLY ONCE. A signed,
 * stateless code that is merely unexpired can be replayed by anyone who
 * sees it, and these travel through a chat window where forwarding and
 * screenshots are ordinary. Single use is what makes "whoever presented it
 * is the person who generated it" a claim worth anything.
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import type { CoworkerChannel } from "@/lib/db/coworker-chat";

type SupabaseClient = Awaited<ReturnType<typeof createSupabaseServiceClient>>;

/** How the binding was established. Not equally strong; see the header. */
export type CoworkerIdentityLinkMethod = "shared_contact" | "link_code";

export type CoworkerChannelIdentityRow = {
  id: string;
  business_id: string;
  channel: CoworkerChannel;
  external_user_id: string;
  employee_id: string | null;
  is_owner: boolean;
  verified_phone_e164: string | null;
  verified_email: string | null;
  linked_via: CoworkerIdentityLinkMethod;
};

/** Codes live long enough to switch apps and paste, and no longer. */
const LINK_CODE_TTL_MS = 15 * 60 * 1000;

/**
 * Unambiguous alphabet: no O/0, no I/1/L. These get read off one screen and
 * typed into another, sometimes from a photograph, and a code that cannot
 * be transcribed is a support ticket.
 */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 8;

/**
 * REJECTION SAMPLING, not modulo.
 *
 * 256 is not a multiple of the 31-letter alphabet: `byte % 31` maps nine of
 * the 256 byte values onto each of the first eight letters and eight onto
 * each of the rest, making those eight about 13% more likely. That is a
 * measurable dent in the search space of a code that grants staff access to
 * a business's coworker, for no gain. Draw again instead of folding the
 * remainder.
 */
function generateLinkCode(): string {
  const limit = Math.floor(256 / CODE_ALPHABET.length) * CODE_ALPHABET.length;
  let out = "";
  while (out.length < CODE_LENGTH) {
    for (const byte of randomBytes(CODE_LENGTH)) {
      if (byte >= limit) continue;
      out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (out.length === CODE_LENGTH) break;
    }
  }
  return out;
}

/** Normalised before hashing so case and spacing never decide a match. */
function hashLinkCode(code: string): string {
  return createHash("sha256").update(normalizeLinkCode(code)).digest("hex");
}

export function normalizeLinkCode(code: string): string {
  return code.trim().toUpperCase().replace(/[\s-]/g, "");
}

export async function createLinkCode(
  input: {
    businessId: string;
    channel: CoworkerChannel;
    /** Null employee with isOwner true enrols the owner. */
    employeeId: string | null;
    isOwner: boolean;
    createdByUserId: string | null;
    now?: number;
  },
  client?: SupabaseClient
): Promise<{ code: string; expiresAt: string }> {
  const db = client ?? (await createSupabaseServiceClient());
  const code = generateLinkCode();
  const expiresAt = new Date((input.now ?? Date.now()) + LINK_CODE_TTL_MS).toISOString();
  const { error } = await db.from("coworker_channel_link_codes").insert({
    business_id: input.businessId,
    channel: input.channel,
    code_hash: hashLinkCode(code),
    employee_id: input.employeeId,
    is_owner: input.isOwner,
    created_by_user_id: input.createdByUserId,
    expires_at: expiresAt
  });
  if (error) throw new Error(`createLinkCode: ${error.message}`);
  // The only time the plaintext exists. Nothing stores it.
  return { code, expiresAt };
}

export type RedeemLinkCodeResult =
  | { ok: true; identity: CoworkerChannelIdentityRow }
  | { ok: false; reason: "unknown" | "expired" | "already_redeemed" };

/**
 * Redeem a code and bind the presenting account.
 *
 * `unknown` covers a wrong code AND a code for another channel, on purpose:
 * telling someone which of those it was would let them enumerate live codes
 * one guess at a time.
 */
export async function redeemLinkCode(
  input: {
    channel: CoworkerChannel;
    code: string;
    externalUserId: string;
    verifiedPhoneE164?: string | null;
    now?: number;
  },
  client?: SupabaseClient
): Promise<RedeemLinkCodeResult> {
  const db = client ?? (await createSupabaseServiceClient());
  const nowMs = input.now ?? Date.now();

  const { data, error } = await db
    .from("coworker_channel_link_codes")
    .select("id, business_id, channel, employee_id, is_owner, expires_at, redeemed_at, code_hash")
    .eq("code_hash", hashLinkCode(input.code))
    .maybeSingle();
  if (error) throw new Error(`redeemLinkCode: ${error.message}`);

  const row = data as
    | {
        id: string;
        business_id: string;
        channel: string;
        employee_id: string | null;
        is_owner: boolean;
        expires_at: string;
        redeemed_at: string | null;
        code_hash: string;
      }
    | null;
  if (!row || row.channel !== input.channel) return { ok: false, reason: "unknown" };

  // The lookup above already matched on the hash, so this compares equal by
  // construction. It is here so the comparison that decides redemption is
  // constant time even if the lookup is ever loosened to a range scan.
  const presented = Buffer.from(hashLinkCode(input.code), "hex");
  const stored = Buffer.from(row.code_hash, "hex");
  if (presented.length !== stored.length || !timingSafeEqual(presented, stored)) {
    return { ok: false, reason: "unknown" };
  }

  if (row.redeemed_at !== null) return { ok: false, reason: "already_redeemed" };
  if (Date.parse(row.expires_at) <= nowMs) return { ok: false, reason: "expired" };

  // Claim the code FIRST, filtered on still-unredeemed, so two people
  // presenting the same code race onto one row and exactly one wins.
  const { data: claimed, error: claimError } = await db
    .from("coworker_channel_link_codes")
    .update({
      redeemed_at: new Date(nowMs).toISOString(),
      redeemed_external_user_id: input.externalUserId
    })
    .eq("id", row.id)
    .is("redeemed_at", null)
    .select("id");
  if (claimError) throw new Error(`redeemLinkCode: ${claimError.message}`);
  // A write matching zero rows is not an error in PostgREST, so the select
  // above is what tells us whether we actually won the race.
  if (!claimed || (claimed as unknown[]).length === 0) {
    return { ok: false, reason: "already_redeemed" };
  }

  const identity = await upsertChannelIdentity(
    {
      businessId: row.business_id,
      channel: input.channel,
      externalUserId: input.externalUserId,
      employeeId: row.employee_id,
      isOwner: row.is_owner,
      verifiedPhoneE164: input.verifiedPhoneE164 ?? null,
      linkedVia: "link_code"
    },
    db
  );
  return { ok: true, identity };
}

export async function upsertChannelIdentity(
  input: {
    businessId: string;
    channel: CoworkerChannel;
    externalUserId: string;
    employeeId: string | null;
    isOwner: boolean;
    verifiedPhoneE164?: string | null;
    verifiedEmail?: string | null;
    linkedVia: CoworkerIdentityLinkMethod;
    linkedByUserId?: string | null;
  },
  client?: SupabaseClient
): Promise<CoworkerChannelIdentityRow> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_channel_identities")
    .upsert(
      {
        business_id: input.businessId,
        channel: input.channel,
        external_user_id: input.externalUserId,
        employee_id: input.employeeId,
        is_owner: input.isOwner,
        verified_phone_e164: input.verifiedPhoneE164 ?? null,
        verified_email: input.verifiedEmail ?? null,
        linked_via: input.linkedVia,
        linked_by_user_id: input.linkedByUserId ?? null,
        updated_at: new Date().toISOString()
      },
      { onConflict: "business_id,channel,external_user_id" }
    )
    .select("*")
    .single();
  if (error) throw new Error(`upsertChannelIdentity: ${error.message}`);
  return data as CoworkerChannelIdentityRow;
}

/** The binding for one inbound account, or null when there is none. */
export async function findChannelIdentity(
  businessId: string,
  channel: CoworkerChannel,
  externalUserId: string,
  client?: SupabaseClient
): Promise<CoworkerChannelIdentityRow | null> {
  const db = client ?? (await createSupabaseServiceClient());
  const { data, error } = await db
    .from("coworker_channel_identities")
    .select("*")
    .eq("business_id", businessId)
    .eq("channel", channel)
    .eq("external_user_id", externalUserId)
    .maybeSingle();
  if (error) throw new Error(`findChannelIdentity: ${error.message}`);
  return (data as CoworkerChannelIdentityRow | null) ?? null;
}

/**
 * Forget every binding for one channel, which is what DISCONNECTING it has
 * to mean.
 *
 * Nothing cascades these: the foreign keys hang off the business and the
 * roster row, not off the connection. Without this, disconnecting Telegram
 * and later connecting a DIFFERENT bot would leave every previously bound
 * account still counted as staff on the new one, including anybody who has
 * since left. Disconnect should un-wire the channel, not just unplug it.
 */
export async function deleteChannelIdentities(
  businessId: string,
  channel: CoworkerChannel,
  client?: SupabaseClient
): Promise<void> {
  const db = client ?? (await createSupabaseServiceClient());
  const { error } = await db
    .from("coworker_channel_identities")
    .delete()
    .eq("business_id", businessId)
    .eq("channel", channel);
  if (error) throw new Error(`deleteChannelIdentities: ${error.message}`);
}

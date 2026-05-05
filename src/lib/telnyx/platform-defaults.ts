/**
 * Resolve the platform-level Telnyx defaults used when assigning a DID to a
 * business. Kept in its own file so API routes + the orchestrator share one
 * source of truth and tests can inspect the env → struct mapping without
 * exercising the full assign flow.
 *
 * Loud-on-missing semantics: TELNYX_CONNECTION_ID is the Call Control
 * Application id Telnyx routes inbound voice webhooks through. When it
 * was unset (early platform days), provisioning silently ordered numbers
 * with `connection_id: ""`, leaving the DID dangling — Telnyx had nowhere
 * to send call.initiated events, owners heard "the call could not be
 * completed", and the failure mode was invisible until someone tried to
 * call. assertPlatformTelnyxDefaults() is the canary: the orchestrator
 * MUST call it before placing a real number order so we surface the
 * config gap as an explicit error instead of an unwired DID.
 */

import type { PlatformTelnyxDefaults } from "@/lib/telnyx/assign-did";

export function readPlatformTelnyxDefaults(
  env: Record<string, string | undefined> = process.env
): PlatformTelnyxDefaults {
  return {
    connectionId: env.TELNYX_CONNECTION_ID ?? undefined,
    messagingProfileId: env.TELNYX_MESSAGING_PROFILE_ID ?? undefined,
    bridgeMediaWssOrigin: env.BRIDGE_MEDIA_WSS_ORIGIN ?? undefined
  };
}

export class MissingTelnyxDefaultsError extends Error {
  public readonly missing: ReadonlyArray<keyof PlatformTelnyxDefaults>;
  constructor(missing: Array<keyof PlatformTelnyxDefaults>) {
    super(
      `Telnyx platform defaults missing: ${missing.join(", ")}. Refusing to provision a DID that would route nowhere.`
    );
    this.name = "MissingTelnyxDefaultsError";
    this.missing = missing;
  }
}

/**
 * Assert that every platform-level Telnyx setting required for a DID
 * to actually carry calls is present. Throws MissingTelnyxDefaultsError
 * when one or more is missing/blank so callers fail loudly at the
 * orchestrator boundary instead of placing an order that costs money
 * AND silently strands the resulting number.
 *
 * connectionId      → Call Control Application id (voice webhook target)
 * messagingProfileId → Messaging Profile id (SMS routing)
 *
 * bridgeMediaWssOrigin is intentionally NOT required here: per-tenant
 * bridges can be stood up after DID assignment, and the Edge dispatcher
 * resolves the WSS origin off business_telnyx_settings at call time.
 * Refusing to assign a DID just because the bridge isn't online yet
 * would block the bootstrapping order.
 */
export function assertPlatformTelnyxDefaults(
  defaults: PlatformTelnyxDefaults
): void {
  const missing: Array<keyof PlatformTelnyxDefaults> = [];
  if (!defaults.connectionId || defaults.connectionId.trim().length === 0) {
    missing.push("connectionId");
  }
  if (!defaults.messagingProfileId || defaults.messagingProfileId.trim().length === 0) {
    missing.push("messagingProfileId");
  }
  if (missing.length > 0) {
    throw new MissingTelnyxDefaultsError(missing);
  }
}

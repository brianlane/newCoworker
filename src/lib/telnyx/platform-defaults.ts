/**
 * Resolve the platform-level Telnyx defaults used when assigning a DID to a
 * business. Kept in its own file so API routes + the orchestrator share one
 * source of truth and tests can inspect the env → struct mapping without
 * exercising the full assign flow.
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

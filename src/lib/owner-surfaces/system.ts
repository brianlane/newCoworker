/**
 * The per-turn system instruction for an owner-operator surface.
 *
 * owner-sms-turn and slack/worker each assembled this list themselves, in
 * the same order, from the same parts. The order is not cosmetic: the
 * persona is pinned FIRST so the very first thing the model reads is who it
 * is talking to. Without that, the per-tenant agent (whose persona is built
 * for inbound customer conversations) treats every message as a customer's
 * and answers the owner with the lead-intake script.
 */

import { mcpBridgeToolsPreamble } from "@/lib/dashboard-chat/mcp-bridge";
import { currentDateTimeLine } from "../../../supabase/functions/_shared/datetime_line";
import {
  EMAIL_TOOL_DISABLED_PREAMBLE,
  EMAIL_TOOL_ENABLED_PREAMBLE,
  OWNER_PREAMBLE
} from "./preambles";
import type { SurfaceSpeaker } from "./speaker";
import type { OwnerTurnSurface } from "./turn-surfaces";

export type OwnerSurfaceSystemArgs = {
  surface: OwnerTurnSurface;
  speaker: SurfaceSpeaker;
  /** How to refer to the speaker's channel identity: a number, a handle. */
  speakerRef: string;
  emailToolEnabled: boolean;
  timezone: string | null;
  integrationsLine?: string | null;
  bookingLinkLine?: string | null;
  businessContextBlock?: string | null;
  /** True when MCP-bridged tools were declared for this turn. */
  bridgeToolsDeclared: boolean;
  transcript?: string | null;
  now?: Date;
};

export function buildOwnerSurfaceSystem(args: OwnerSurfaceSystemArgs): string {
  const { surface, speaker } = args;
  const isOwner = speaker.kind === "owner";
  const transcript = (args.transcript ?? "").trim();
  // ALWAYS first. A teammate gets the surface's own team persona, never
  // OWNER MODE: falling back to the owner persona is exactly how a teammate
  // would end up holding owner powers. A teammate on a surface with no team
  // persona would otherwise be handed a prompt with NO persona block at
  // all, and the model would fill that in with its customer intake default.
  // Refuse loudly: that is a wiring bug, not a runtime condition.
  const persona = isOwner ? OWNER_PREAMBLE : surface.teamPreamble;
  if (persona === null) {
    throw new Error(`buildOwnerSurfaceSystem: ${surface.key} serves owners only`);
  }
  return [
    persona,
    surface.surfaceBlock,
    surface.speakerLine(speaker, args.speakerRef),
    // The EMAIL_SEND protocol is owner-only on these surfaces. The DISABLED
    // twin is as load-bearing as the enabled one: without it the model
    // invents tool-call syntax and claims the mail went out.
    ...(isOwner
      ? [args.emailToolEnabled ? EMAIL_TOOL_ENABLED_PREAMBLE : EMAIL_TOOL_DISABLED_PREAMBLE]
      : []),
    currentDateTimeLine(args.now ?? new Date(), args.timezone),
    args.integrationsLine ?? "",
    args.bookingLinkLine ?? "",
    args.businessContextBlock ?? "",
    // includeCreationTools is false on every one of these surfaces, so the
    // ladder must not advertise create_aiflow (Bugbot Medium, PR #1382).
    args.bridgeToolsDeclared ? mcpBridgeToolsPreamble({ creationToolsDeclared: false }) : "",
    transcript ? `${surface.transcriptLabel}\n${transcript}` : ""
  ]
    // Empty parts are dropped rather than joined, so an absent optional
    // block leaves no blank paragraph for the model to read meaning into.
    .filter((part) => part.length > 0)
    .join("\n\n");
}

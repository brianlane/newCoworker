/**
 * Classify WHO is marking a notification read.
 *
 * Split out of the route because it is the one piece of the notification-
 * actor change with any judgement in it, and because getting it backwards is
 * silent: a wrong answer here writes a plausible stamp that the
 * channel-liveness check will happily treat as proof the customer is alive.
 *
 * THE RULE. `user.isAdmin` is a platform-admin flag, and
 * `requireBusinessRole` lets the admin past every tenant gate, so an admin
 * session reading a tenant's notifications is US, not them. That stamp must
 * never count.
 *
 * THE EXCEPTION, and it is a real one. The platform admin owns an internal
 * tenant (New Coworker HQ), and `resolveViewAsContext` already models this
 * as `selfOwned`: the impersonated business's `owner_email` IS the admin's
 * own address, so the dashboard renders exactly as it would for the plain
 * owner. Stamping those reads `admin` would report our own tenant's
 * dashboard as unread by anybody, which is false. `selfOwned` is the
 * existing, tested answer to "is this person genuinely this business's
 * owner", so it is reused rather than re-derived from `owner_email` here.
 *
 * The direction of the remaining error matters and is chosen. An admin who
 * hits this route for a tenant they do NOT own without entering view-as
 * stamps `admin`, which can only ever make a tenant look LESS alive than it
 * is. Under-reporting produces a warn we investigate; over-reporting
 * produces a customer we never call.
 */

import type { AuthUser } from "@/lib/auth";
import { resolveViewAsContext } from "@/lib/admin/view-as";
import type { NotificationReadActor } from "@/lib/db/notifications";

export async function resolveNotificationReadActor(
  user: AuthUser,
  businessId: string
): Promise<NotificationReadActor> {
  if (!user.isAdmin) return "owner";
  const { viewAs } = await resolveViewAsContext(user);
  if (viewAs?.selfOwned && viewAs.businessId === businessId) return "owner";
  return "admin";
}

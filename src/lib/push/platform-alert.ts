/**
 * Web Push for the two PLATFORM alerts: the ones addressed to US, not to a
 * tenant.
 *
 * `alert_delivery_failed` ("this customer did not receive an urgent alert")
 * and `alert_audience_dark` ("no channel reaches this customer at all") both
 * mean somebody at HQ should act, and both have only ever landed in a
 * system-logs card on an admin page that a person has to remember to open.
 * This is the leg that puts them on an admin's phone instead.
 *
 * They go to the PLATFORM scope (`business_id IS NULL`), a set of devices
 * that belongs to no tenant. `deliverPush` skips its Standard-plus tier check
 * for that scope, because HQ has no plan to check.
 *
 * ## Why this takes channel lists and not a message
 *
 * The obvious signature is `(event, businessId, message)`, and it is the
 * wrong one. The natural thing to hand it at the `alert_delivery_failed` call
 * site is the alert's own summary, and on a HIPAA tenant that summary can
 * carry a patient identifier straight into a payload bound for a third-party
 * push vendor. The dispatcher's own push leg is careful about exactly this.
 *
 * Taking structured channel names makes that mistake unrepresentable rather
 * than merely discouraged: there is no parameter a summary could be passed
 * as. The body is composed here, out of a business name and a list of
 * channels, and nothing else.
 *
 * ## Never throws, and never reports itself
 *
 * It is called FROM the failure path. Raising `alert_delivery_failed` when a
 * platform push fails would be a loop, so a failure here is logged and
 * nothing more.
 */

import { getBusiness } from "@/lib/db/businesses";
import { logger } from "@/lib/logger";
import { deliverPush } from "@/lib/push/send";

export type PlatformAlertInput =
  | { event: "alert_delivery_failed"; businessId: string; failedChannels: string[] }
  | { event: "alert_audience_dark"; businessId: string; silentChannels: string[] };

const TITLES = {
  alert_delivery_failed: "Alert delivery failed",
  alert_audience_dark: "A customer has gone dark"
} as const;

/**
 * Compose the banner text. Business name plus channel names, nothing else.
 *
 * `getBusiness` swallows its own errors and returns null, so an unreadable
 * business row degrades the name to "A customer" rather than losing the
 * alert. Knowing WHICH customer is the nice-to-have here; knowing that one of
 * them is unreachable is the part that must survive.
 */
function bannerBody(input: PlatformAlertInput, name: string): string {
  return input.event === "alert_delivery_failed"
    ? `${name} did not receive an urgent alert. Failed on ${input.failedChannels.join(", ")}.`
    : `No alert channel is reaching ${name}. Silent: ${input.silentChannels.join(", ")}. Call them.`;
}

export async function pushPlatformAlert(input: PlatformAlertInput): Promise<void> {
  try {
    const business = await getBusiness(input.businessId);
    const result = await deliverPush({
      scope: { businessId: null },
      title: TITLES[input.event],
      body: bannerBody(input, business?.name ?? "A customer"),
      // The per-business admin page, which is where the System Log viewer
      // lives. Same rule as the tenant push leg: send the reader to where the
      // problem is, not to a generic dashboard to go hunting.
      url: `/admin/${input.businessId}`,
      /**
       * Collapse a burst into one banner.
       *
       * The liveness sweep judges every tenant in one pass, so a systemic
       * outage (our SMS carrier, say) turns every tenant dark on the same run
       * and would otherwise fire one banner per customer. Browsers degrade a
       * permission that gets repeatedly ignored, so a stampede does not just
       * annoy, it can cost the channel. One tag per event means the newest
       * banner replaces the last.
       */
      tag: `platform-${input.event}`
    });

    // `not_connected` is the ordinary state whenever no admin has installed
    // the app, which is not an error and must not be logged as one.
    if (!result.ok && result.reason !== "not_connected") {
      logger.warn("push.platformAlert: delivery failed", {
        event: input.event,
        businessId: input.businessId,
        reason: result.reason
      });
    }
  } catch (err) {
    logger.warn("push.platformAlert: threw", {
      event: input.event,
      businessId: input.businessId,
      error: err instanceof Error ? err.message : String(err)
    });
  }
}

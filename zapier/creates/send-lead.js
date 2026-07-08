"use strict";

/**
 * "Send Lead to Coworker" action — POST /api/public/v1/flow-events.
 *
 * The inbound bridge for lead sources Zapier can read but the coworker
 * can't reach directly (Meta/Facebook Lead Ads, Google Lead Forms, etc.):
 * the mapped lead fields become a webhook event that starts every enabled
 * webhook-triggered AiFlow whose conditions match. Idempotent per lead —
 * pass the source's lead id as Lead ID so a Zap replay never runs a flow
 * twice for the same lead.
 */

const { BASE_URL } = require("../base-url");

const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/api/public/v1/flow-events`,
    method: "POST",
    body: {
      source: bundle.inputData.source || "facebook_lead_ads",
      event_id: bundle.inputData.event_id || undefined,
      data: bundle.inputData.data || {}
    }
  });
  return response.data.data;
};

module.exports = {
  key: "send_lead",
  noun: "Lead",
  display: {
    label: "Send Lead to Coworker",
    description:
      "Sends a lead (or any event) to your coworker, starting your webhook-triggered AiFlows."
  },
  operation: {
    perform,
    inputFields: [
      {
        key: "data",
        label: "Lead Fields",
        dict: true,
        required: true,
        helpText:
          "The lead's details as name/value pairs — e.g. full_name, phone_number, email, " +
          "plus any custom form questions. Your AiFlow reads these exactly as entered."
      },
      {
        key: "event_id",
        label: "Lead ID",
        type: "string",
        required: false,
        helpText:
          "A unique id for this lead (map the trigger's Lead ID here). Prevents duplicate " +
          "flow runs if the Zap replays."
      },
      {
        key: "source",
        label: "Source",
        type: "string",
        required: false,
        default: "facebook_lead_ads",
        helpText:
          'Where the lead came from (e.g. "facebook_lead_ads"). AiFlows can filter on this ' +
          'with a "from matches" condition.'
      }
    ],
    sample: {
      enqueued: 1,
      flows_evaluated: 1
    }
  }
};

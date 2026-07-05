"use strict";

/**
 * "Send Text Message" action — POST /api/public/v1/messages.
 *
 * Sends through the tenant's own number via the same metered path as the
 * dashboard compose box, so monthly SMS caps apply and the message shows
 * up in the owner's conversation history (source 'api').
 */

const { BASE_URL } = require("../base-url");

const perform = async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/api/public/v1/messages`,
    method: "POST",
    body: {
      to: bundle.inputData.to,
      text: bundle.inputData.text
    }
  });
  return response.data.data;
};

module.exports = {
  key: "send_sms",
  noun: "Text Message",
  display: {
    label: "Send Text Message",
    description: "Sends an SMS from your coworker's phone number."
  },
  operation: {
    perform,
    inputFields: [
      {
        key: "to",
        label: "To",
        type: "string",
        required: true,
        helpText: "Recipient phone number, e.g. +16025551234 (US assumed without a country code)."
      },
      {
        key: "text",
        label: "Message",
        type: "text",
        required: true,
        helpText: "Message body (up to 1600 characters). Sent exactly as written."
      }
    ],
    sample: {
      message_id: "40385f88-0000-0000-0000-000000000001",
      log_id: "9e8d7c6b-0000-0000-0000-000000000006",
      channel: "sms"
    }
  }
};

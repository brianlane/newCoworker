"use strict";

/**
 * Custom (API key) authentication against the NewCoworker public API.
 *
 * The owner mints an `nck_…` key on /dashboard/integrations and pastes it
 * here. Every request carries `Authorization: Bearer <key>`; the test call
 * is GET /api/public/v1/me, whose business name doubles as the connection
 * label in the Zap editor.
 */

const { BASE_URL } = require("./base-url");

const test = async (z) => {
  const response = await z.request({ url: `${BASE_URL}/api/public/v1/me` });
  return response.data.data;
};

/** Bearer header on every outgoing request. */
const includeApiKey = (request, z, bundle) => {
  if (bundle.authData.api_key) {
    request.headers = request.headers || {};
    request.headers.Authorization = `Bearer ${bundle.authData.api_key}`;
  }
  return request;
};

module.exports = {
  config: {
    type: "custom",
    fields: [
      {
        key: "api_key",
        label: "API Key",
        required: true,
        type: "password",
        helpText:
          "Create an API key on your [Integrations page](https://www.newcoworker.com/dashboard/integrations) under **Zapier & API access**, then paste it here."
      }
    ],
    test,
    connectionLabel: "{{name}}"
  },
  befores: [includeApiKey],
  afters: []
};

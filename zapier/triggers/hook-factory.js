"use strict";

/**
 * Factory for the four REST-hook triggers (sms.inbound, sms.outbound,
 * call.completed, email.inbound). All four share identical mechanics —
 * subscribe/unsubscribe against /api/public/v1/hooks, samples from
 * /api/public/v1/events — and differ only in copy and sample payloads,
 * so one factory keeps them in lockstep with the server's payload shape.
 */

const { BASE_URL } = require("../base-url");

const subscribeHook = (event) => async (z, bundle) => {
  const response = await z.request({
    url: `${BASE_URL}/api/public/v1/hooks`,
    method: "POST",
    body: { event, target_url: bundle.targetUrl }
  });
  return response.data.data;
};

const unsubscribeHook = async (z, bundle) => {
  const hookId = bundle.subscribeData.id;
  const response = await z.request({
    url: `${BASE_URL}/api/public/v1/hooks/${hookId}`,
    method: "DELETE",
    skipThrowForStatus: true
  });
  // 404 = already gone (e.g. deactivated server-side) — fine for Zapier.
  if (response.status >= 400 && response.status !== 404) {
    response.throwForStatus();
  }
  return { deleted: true };
};

/** Inbound webhook delivery: the dispatcher POSTs one payload per request. */
const perform = async (z, bundle) => [bundle.cleanedRequest];

const performList = (event) => async (z) => {
  const response = await z.request({
    url: `${BASE_URL}/api/public/v1/events`,
    params: { event, limit: 3 }
  });
  return response.data.data;
};

/**
 * @param {object} spec
 * @param {string} spec.key         Zapier trigger key (e.g. "sms_inbound")
 * @param {string} spec.event       Server event type (e.g. "sms.inbound")
 * @param {string} spec.noun
 * @param {string} spec.label
 * @param {string} spec.description
 * @param {object} spec.sample      Sample payload matching buildWebhookPayload
 */
const makeHookTrigger = (spec) => ({
  key: spec.key,
  noun: spec.noun,
  display: {
    label: spec.label,
    description: spec.description
  },
  operation: {
    type: "hook",
    performSubscribe: subscribeHook(spec.event),
    performUnsubscribe: unsubscribeHook,
    perform,
    performList: performList(spec.event),
    sample: spec.sample
  }
});

module.exports = { makeHookTrigger };

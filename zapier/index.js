"use strict";

const { version } = require("./package.json");
const { version: platformVersion } = require("zapier-platform-core");
const authentication = require("./authentication");
const triggers = require("./triggers");
const sendSms = require("./creates/send-sms");
const sendLead = require("./creates/send-lead");

module.exports = {
  version,
  platformVersion,
  // Never let the platform "clean" input data (drop empty strings / unknown
  // keys) before our API sees it: the API returns its own validation errors,
  // and predictability beats silent munging on every surface (publishing
  // check D028). Global so triggers and creates cannot drift apart.
  flags: { cleanInputData: false },
  authentication: authentication.config,
  beforeRequest: [...authentication.befores],
  afterResponse: [...authentication.afters],
  triggers: {
    [triggers.smsInbound.key]: triggers.smsInbound,
    [triggers.smsOutbound.key]: triggers.smsOutbound,
    [triggers.callCompleted.key]: triggers.callCompleted,
    [triggers.emailInbound.key]: triggers.emailInbound
  },
  creates: {
    [sendSms.key]: sendSms,
    [sendLead.key]: sendLead
  },
  searches: {},
  resources: {}
};

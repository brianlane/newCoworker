"use strict";

const { version } = require("./package.json");
const { version: platformVersion } = require("zapier-platform-core");
const authentication = require("./authentication");
const triggers = require("./triggers");
const sendSms = require("./creates/send-sms");

module.exports = {
  version,
  platformVersion,
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
    [sendSms.key]: sendSms
  },
  searches: {},
  resources: {}
};

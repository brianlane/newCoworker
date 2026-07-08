"use strict";

/**
 * Structural checks on the app definition (node --test; no Zapier login
 * needed). `zapier validate` does the full schema pass at deploy time —
 * these tests catch the cheap mistakes early: a trigger key drifting from
 * its object key, a sample payload losing the fields the editor maps.
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const app = require("../index.js");

test("app exposes the four hook triggers and the two creates", () => {
  assert.deepEqual(Object.keys(app.triggers).sort(), [
    "call_completed",
    "email_inbound",
    "sms_inbound",
    "sms_outbound"
  ]);
  assert.deepEqual(Object.keys(app.creates).sort(), ["send_lead", "send_sms"]);
});

test("trigger object keys match their definition keys", () => {
  for (const [key, trigger] of Object.entries(app.triggers)) {
    assert.equal(trigger.key, key);
  }
});

test("every trigger is a REST hook with subscribe/unsubscribe/list", () => {
  for (const trigger of Object.values(app.triggers)) {
    assert.equal(trigger.operation.type, "hook");
    assert.equal(typeof trigger.operation.performSubscribe, "function");
    assert.equal(typeof trigger.operation.performUnsubscribe, "function");
    assert.equal(typeof trigger.operation.performList, "function");
    assert.equal(typeof trigger.operation.perform, "function");
  }
});

test("samples carry the dispatcher payload envelope", () => {
  for (const [key, trigger] of Object.entries(app.triggers)) {
    const sample = trigger.operation.sample;
    for (const field of ["event", "business_id", "id", "occurred_at", "data"]) {
      assert.ok(field in sample, `${key} sample missing ${field}`);
    }
    // The event type is the dotted form of the trigger key.
    assert.equal(sample.event, key.replace("_", "."));
  }
});

test("send_sms requires to + text", () => {
  const fields = app.creates.send_sms.operation.inputFields;
  assert.deepEqual(
    fields.map((f) => f.key),
    ["to", "text"]
  );
  assert.ok(fields.every((f) => f.required));
});

test("send_lead requires the lead-fields dict; id/source stay optional", () => {
  const fields = app.creates.send_lead.operation.inputFields;
  assert.deepEqual(
    fields.map((f) => f.key),
    ["data", "event_id", "source"]
  );
  const data = fields.find((f) => f.key === "data");
  assert.equal(data.dict, true);
  assert.equal(data.required, true);
  assert.ok(fields.filter((f) => f.key !== "data").every((f) => !f.required));
  // The editor maps flow starts by these response fields; keep them stable.
  const sample = app.creates.send_lead.operation.sample;
  assert.ok("enqueued" in sample && "flows_evaluated" in sample);
});

test("authentication is custom with an api_key password field", () => {
  assert.equal(app.authentication.type, "custom");
  assert.equal(app.authentication.fields[0].key, "api_key");
  assert.equal(app.authentication.fields[0].type, "password");
});

"use strict";

/**
 * Public API origin. Override with the BASE_URL Zapier environment variable
 * (`zapier env:set 1.0.0 BASE_URL=https://staging.example.com`) when testing
 * against a preview deployment.
 */
module.exports = {
  BASE_URL: process.env.BASE_URL || "https://www.newcoworker.com"
};

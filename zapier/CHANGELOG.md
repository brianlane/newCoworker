# Changelog

## 1.0.1

Directory-readiness cleanup: the whole app now opts out of platform input
cleaning via the global flags.cleanInputData (publishing check D028 flagged
the four triggers and Send Lead; Send Text Message already opted out
per-operation, now covered by the same single flag), and
zapier-platform-core is bumped 19.0.0 to 19.1.0 (D027). No behavior change
for existing Zaps: the API already receives and validates raw input on the
only action users call today.

## 1.0.0

Initial release of the New Coworker integration: instant triggers for inbound
SMS, outbound SMS, completed calls, and inbound email, plus the Send Text
Message and Send Lead to Coworker actions.

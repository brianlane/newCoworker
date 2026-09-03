/**
 * Phrases only a recording says. Lockstep copy of MACHINE_PHRASES /
 * looksMachineGenerated in supabase/functions/_shared/call_integrity.ts
 * (the bridge cannot import Deno `_shared`). Pinned by
 * tests/voice-bridge-machine-phrases-lockstep.test.ts.
 *
 * Used as one of the two pieces of evidence that may arm a bridge-side
 * beep speak: Telnyx `machine_detected` alone is provisional under iOS
 * screening, so a tone in the Goertzel band is not enough.
 */
export const MACHINE_PHRASES = [
  "press one",
  "press 1",
  "press two",
  "press pound",
  "press star",
  "leave a message",
  "at the beep",
  "after the tone",
  "record your message",
  "re-record",
  "voicemail",
  "is not available",
  "please hold",
  "your call is important"
];

export function looksMachineGenerated(text: string): boolean {
  const t = text.toLowerCase();
  return MACHINE_PHRASES.some((p) => t.includes(p));
}

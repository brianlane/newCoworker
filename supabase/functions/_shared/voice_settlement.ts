/**
 * Settlement skip for a call that never connected.
 *
 * Telnyx still sends call.hangup after a mid-ring abandon (code 90018).
 * Writing a voice_settlements row for that is wrong: inbound already
 * released the reservation, finalize used to refuse `reservation_released`,
 * and the health cron then paged a stuck settlement that could never close.
 */

export type SettlementReservation = {
  ws_connected_at?: string | null;
  answer_issued_at?: string | null;
};

/** True when no answer was issued and no media websocket ever attached. */
export function isNeverAnsweredReservation(
  resv: SettlementReservation | null | undefined
): boolean {
  if (!resv) return false;
  return resv.ws_connected_at == null && resv.answer_issued_at == null;
}

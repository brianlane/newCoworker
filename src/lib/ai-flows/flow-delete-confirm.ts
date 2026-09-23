/**
 * The AiFlows trash icon used to delete on one click. BA Fitness
 * (2026-09-23) did that and did not remember it. The button asks first.
 */

function flowDeleteConfirmMessage(name: string): string {
  return `Delete "${name}"? It stops running and leaves this list. This cannot be undone from here.`;
}

/** True only when the owner accepts the confirm. A cancel deletes nothing. */
export function ownerAllowsFlowDelete(
  name: string,
  confirm: (message: string) => boolean
): boolean {
  return confirm(flowDeleteConfirmMessage(name));
}

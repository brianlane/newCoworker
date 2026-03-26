export type HeartbeatState = {
  failures: number;
  restarted: boolean;
  escalate: boolean;
};

export function nextHeartbeatState(currentFailures: number, healthy: boolean): HeartbeatState {
  if (healthy) {
    return { failures: 0, restarted: false, escalate: false };
  }

  const failures = currentFailures + 1;
  const restarted = failures === 3;
  const escalate = failures > 3;
  return { failures, restarted, escalate };
}

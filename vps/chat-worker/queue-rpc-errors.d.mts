// Type declarations for queue-rpc-errors.mjs (plain-ESM worker module). The
// worker itself runs the .mjs directly under node; these declarations exist so
// the TypeScript test suite (and `tsc --noEmit`) can import the helpers with
// types. Keep in sync with queue-rpc-errors.mjs.

/**
 * The subset of a postgrest-js response the classifier reads. Matches what
 * `supabase.rpc()` resolves to on failure.
 */
export type QueueRpcResult = {
  error?: { message?: string; code?: string | null } | string | null;
  status?: number;
  statusText?: string;
} | null | undefined;

export const QUEUE_RPC_RETRY_MS: number;

export const QUEUE_RPC_ERROR_AFTER: number;

export function isTransientRpcError(message: unknown): boolean;

export function describeQueueRpcError(result: QueueRpcResult): string;

export function classifyQueueRpcFailure(result: QueueRpcResult): "transient" | "defect";

export function createQueueRpcFailureTracker(opts?: { errorAfter?: number }): {
  record(
    event: string,
    result: QueueRpcResult,
    opts?: { nonTransientLevel?: string }
  ): {
    level: string;
    event: string;
    data: { error: string; consecutiveFailures?: number };
  };
  clear(event: string): void;
};

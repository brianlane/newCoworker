export function compareVersions(a: string, b: string): number;

export function classifyWatch(input: {
  lockedVersion: string | null;
  registryVersion: string;
  minRelease: string;
}): "waiting" | "ready" | "stale";

export function lockedVersionFor(
  dir: string,
  packageName: string,
  root?: string
): string | null;

export type WatchEntry = {
  package: string;
  dir: string;
  minRelease: string;
  advisory: string;
  reason: string;
};

export type WatchRow = WatchEntry & {
  status: "waiting" | "ready" | "stale";
  lockedVersion: string | null;
  registryVersion: string;
};

export function describeWatch(
  entry: WatchEntry,
  versions: { lockedVersion: string | null; registryVersion: string }
): WatchRow;

export function formatWatchReport(rows: WatchRow[]): string;

export function readRegistryVersion(packageName: string): string;

export function evaluateWatch(
  entries: WatchEntry[],
  readRegistry?: (packageName: string) => string,
  root?: string
): WatchRow[];

export function exitCodeFor(rows: WatchRow[]): 0 | 1 | 2;

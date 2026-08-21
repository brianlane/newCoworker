import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIN_METRIC_SAMPLES,
  hasEnoughSamples,
  meanLoadPerCore,
  minMemoryAvailableFraction,
  parseHostMetrics,
  peakLoadPerCore,
  type VpsHostMetrics
} from "@/lib/vps/host-metrics";

const SAMPLE: VpsHostMetrics = {
  cpuCount: 2,
  load1Max: 2.9,
  load1Mean: 1.31,
  memAvailableMinMib: 2001,
  memTotalMib: 7940,
  swapUsedMaxMib: 200,
  samples: 30
};

describe("parseHostMetrics", () => {
  it("accepts a complete aggregate", () => {
    expect(parseHostMetrics({ ...SAMPLE })).toEqual(SAMPLE);
  });

  it("coerces numeric strings, since this arrives as JSON from a shell script", () => {
    const parsed = parseHostMetrics({
      cpuCount: "2",
      load1Max: "2.9",
      load1Mean: "1.31",
      memAvailableMinMib: "2001",
      memTotalMib: "7940",
      swapUsedMaxMib: "200",
      samples: "30"
    });
    expect(parsed).toEqual(SAMPLE);
  });

  it.each([
    ["cpuCount"],
    ["load1Max"],
    ["load1Mean"],
    ["memAvailableMinMib"],
    ["memTotalMib"],
    ["swapUsedMaxMib"],
    ["samples"]
  ])("rejects the whole object when %s is missing", (field) => {
    const partial: Record<string, unknown> = { ...SAMPLE };
    delete partial[field];
    expect(parseHostMetrics(partial)).toBeNull();
  });

  it("rejects non-finite values", () => {
    expect(parseHostMetrics({ ...SAMPLE, load1Max: "not-a-number" })).toBeNull();
    expect(parseHostMetrics({ ...SAMPLE, load1Max: Number.NaN })).toBeNull();
    expect(parseHostMetrics({ ...SAMPLE, memTotalMib: Number.POSITIVE_INFINITY })).toBeNull();
  });

  it("rejects values that would make a ratio meaningless", () => {
    // Zero cores would make every load-per-core infinite.
    expect(parseHostMetrics({ ...SAMPLE, cpuCount: 0 })).toBeNull();
    // Zero total memory would make every headroom percentage NaN.
    expect(parseHostMetrics({ ...SAMPLE, memTotalMib: 0 })).toBeNull();
    // A zero-sample aggregate describes nothing.
    expect(parseHostMetrics({ ...SAMPLE, samples: 0 })).toBeNull();
  });

  it("rejects non-objects", () => {
    expect(parseHostMetrics(null)).toBeNull();
    expect(parseHostMetrics(undefined)).toBeNull();
    expect(parseHostMetrics("{}")).toBeNull();
    expect(parseHostMetrics(42)).toBeNull();
  });
});

describe("derived ratios", () => {
  it("normalizes load by core count, so sizes compare", () => {
    expect(peakLoadPerCore(SAMPLE)).toBeCloseTo(1.45, 5);
    expect(meanLoadPerCore(SAMPLE)).toBeCloseTo(0.655, 5);
    // The same raw load on a bigger box is not the same pressure.
    expect(peakLoadPerCore({ ...SAMPLE, cpuCount: 8 })).toBeCloseTo(0.3625, 5);
  });

  it("reports the worst memory headroom as a fraction", () => {
    expect(minMemoryAvailableFraction(SAMPLE)).toBeCloseTo(2001 / 7940, 6);
  });

  it("gates on sample coverage", () => {
    expect(hasEnoughSamples(SAMPLE)).toBe(true);
    expect(hasEnoughSamples({ ...SAMPLE, samples: MIN_METRIC_SAMPLES })).toBe(true);
    expect(hasEnoughSamples({ ...SAMPLE, samples: MIN_METRIC_SAMPLES - 1 })).toBe(false);
    expect(hasEnoughSamples({ ...SAMPLE, samples: 3 }, 2)).toBe(true);
  });
});

/**
 * The box builds this JSON in awk and the platform parses it in TypeScript,
 * so the two field lists are a contract with no compiler between them. A
 * rename on either side would not error: `parseHostMetrics` would reject
 * every report as malformed and the advisor would see "no data" forever,
 * which looks exactly like a quiet box. Pin the names to each other.
 */
describe("heartbeat.sh and parseHostMetrics agree on field names", () => {
  const heartbeat = readFileSync(
    join(__dirname, "..", "vps", "scripts", "heartbeat.sh"),
    "utf8"
  );

  it("emits exactly the fields the parser requires", () => {
    const printf = /printf "\{(\\".*?)\}"/.exec(heartbeat);
    expect(printf, "metrics printf not found in heartbeat.sh").not.toBeNull();
    const emitted = [...(printf as RegExpExecArray)[1].matchAll(/\\"([A-Za-z0-9]+)\\":/g)].map(
      (m) => m[1]
    );
    expect(emitted.sort()).toEqual(Object.keys(SAMPLE).sort());
  });

  it("samples on every tick, not only when it reports", () => {
    // The sampler must sit OUTSIDE report_posture, which is throttled to one
    // run an hour: sampling inside it would collapse the aggregate back to
    // the single instantaneous reading this exists to replace.
    const samplerCall = heartbeat.indexOf("sample_host_metrics || true");
    const reportFn = heartbeat.indexOf("report_posture() {");
    expect(samplerCall).toBeGreaterThan(-1);
    expect(samplerCall).toBeLessThan(reportFn);
  });

  it("reports an empty object for a readable-but-untuned Ollama process", () => {
    // grep finding no OLLAMA_/OMP_ vars must not swallow the whole field: a
    // completely untuned live process is the most broken state there is, and
    // omitting `ollamaEnv` would make it indistinguishable from a box too
    // old to report one. The `|| true` after grep is what guarantees the
    // object is still emitted, and the braces are added outside it.
    const heartbeatSrc = readFileSync(
      join(__dirname, "..", "vps", "scripts", "heartbeat.sh"),
      "utf8"
    );
    expect(heartbeatSrc).toMatch(/ollama_env_json="\{\$\(printf/);
    expect(heartbeatSrc).toMatch(/grep -E '\^\(OLLAMA_\|OMP_\)\[A-Z0-9_\]\+='/);
    // The read is guarded separately from the transform, so an UNREADABLE
    // environ still omits the field entirely.
    expect(heartbeatSrc).toContain('if environ_raw="$(tr');
  });

  it("truncates the sample file when it aggregates, not when the POST succeeds", () => {
    // Truncating on send would make a box with a failing POST re-report a
    // widening window every hour, each retry looking like a longer period of
    // sustained load.
    const truncate = heartbeat.indexOf(': > "$METRIC_SAMPLES_FILE"');
    const post = heartbeat.indexOf("/api/vps/posture");
    expect(truncate).toBeGreaterThan(-1);
    expect(truncate).toBeLessThan(post);
  });
});

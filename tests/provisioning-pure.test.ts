import { describe, it, expect, vi } from "vitest";

import {
  describeAttachError,
  describeProvisioningError,
  formatTendlcAttachProgress,
  runWithSshConnectRetry
} from "@/lib/provisioning/orchestrate";

/**
 * Pure-helper unit tests pulled out of `tests/provisioning.test.ts` so they
 * don't have to drag along that file's heavyweight `vi.mock(...)` graph
 * (auth, businesses, configs, telnyx, email, etc.). Each helper here is a
 * leaf function — `describeProvisioningError`, `runWithSshConnectRetry`,
 * `describeAttachError`, `formatTendlcAttachProgress` — so this file just
 * imports from `@/lib/provisioning/orchestrate` and asserts on outputs.
 *
 * Splitting these out lets vitest run them in their own worker in parallel
 * with the integration-style orchestrator tests, so a regression in either
 * file no longer gates the other and the suite stays shardable.
 */
describe("provisioning/orchestrate pure helpers", () => {
  describe("describeProvisioningError", () => {
    it("extracts endpoint/status/body from a HostingerApiError-shaped error", () => {
      class FakeHostingerApiError extends Error {
        readonly endpoint = "/api/vps/v1/virtual-machines";
        readonly status = 422;
        readonly body = { errors: { data_center_id: ["invalid"] } };
        constructor() {
          super("Hostinger API HTTP 422");
          this.name = "HostingerApiError";
        }
      }
      const detail = describeProvisioningError(new FakeHostingerApiError());
      expect(detail).toEqual({
        message: "Hostinger API HTTP 422",
        endpoint: "/api/vps/v1/virtual-machines",
        status: 422,
        body: { errors: { data_center_id: ["invalid"] } }
      });
    });

    it("returns just `message` for a plain Error", () => {
      const detail = describeProvisioningError(new Error("nope"));
      expect(detail).toEqual({ message: "nope" });
    });

    it("stringifies non-Error throws", () => {
      expect(describeProvisioningError("a string")).toEqual({ message: "a string" });
      expect(describeProvisioningError(42)).toEqual({ message: "42" });
      expect(describeProvisioningError(null)).toEqual({ message: "null" });
    });

    it("ignores spurious endpoint/status fields when the error name doesn't match", () => {
      // Defense in depth: another error type with similarly-named
      // properties shouldn't masquerade as a HostingerApiError. We only
      // surface endpoint/status/body when `err.name === "HostingerApiError"`.
      class WrongName extends Error {
        readonly endpoint = "/api/x";
        readonly status = 500;
        constructor() {
          super("not hostinger");
          this.name = "SomeOtherError";
        }
      }
      const detail = describeProvisioningError(new WrongName());
      expect(detail).toEqual({ message: "not hostinger" });
    });

    it("ignores non-string endpoint and non-number status fields even when name matches", () => {
      class MalformedHostingerError extends Error {
        readonly endpoint = 123 as unknown as string;
        readonly status = "403" as unknown as number;
        readonly body = { ok: false };
        constructor() {
          super("malformed");
          this.name = "HostingerApiError";
        }
      }
      const detail = describeProvisioningError(new MalformedHostingerError());
      expect(detail).toEqual({
        message: "malformed",
        endpoint: undefined,
        status: undefined,
        body: { ok: false }
      });
    });
  });

  describe("runWithSshConnectRetry", () => {
    it("returns the first attempt's value when it succeeds", async () => {
      const fn = vi.fn().mockResolvedValueOnce("hello");
      const sleep = vi.fn();
      const out = await runWithSshConnectRetry(fn, { sleep });
      expect(out).toBe("hello");
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });

    it("respects custom maxAttempts and baseDelayMs", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("connection refused"));
      const sleep = vi.fn().mockResolvedValue(undefined);
      await expect(
        runWithSshConnectRetry(fn, { maxAttempts: 3, baseDelayMs: 100, sleep })
      ).rejects.toThrow(/connection refused/);
      expect(fn).toHaveBeenCalledTimes(3);
      // Two sleeps for three attempts; linear backoff 100, 200.
      expect(sleep).toHaveBeenNthCalledWith(1, 100);
      expect(sleep).toHaveBeenNthCalledWith(2, 200);
    });

    it("propagates a non-connect error without retrying", async () => {
      const boom = new Error("explicit non-connect failure");
      const fn = vi.fn().mockRejectedValue(boom);
      const sleep = vi.fn();
      await expect(runWithSshConnectRetry(fn, { sleep })).rejects.toBe(boom);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    });
  });

  describe("describeAttachError", () => {
    it("returns Error.message for thrown Error instances", () => {
      expect(describeAttachError(new Error("boom"))).toBe("boom");
    });

    it("falls back to String(...) for non-Error values (string thrown)", () => {
      expect(describeAttachError("rpc replica timeout")).toBe(
        "rpc replica timeout"
      );
    });

    it("falls back to String(...) for non-Error values (object thrown)", () => {
      // Defence against libraries that throw plain objects.
      expect(describeAttachError({ code: 503 })).toBe("[object Object]");
    });
  });

  describe("formatTendlcAttachProgress", () => {
    it("registered: clears the thinking status so the progress UI advances", () => {
      const out = formatTendlcAttachProgress(
        { kind: "registered" },
        "+15550001111"
      );
      expect(out).toEqual({
        message: "SMS 10DLC registered (+15550001111)",
        status: undefined
      });
    });

    it("pending: keeps thinking status, surfaces the carrier reason verbatim", () => {
      const out = formatTendlcAttachProgress(
        { kind: "pending", reason: "campaign_status:VERIFIED" },
        "+15550002222"
      );
      expect(out.message).toBe(
        "SMS 10DLC queued (carrier vetting): campaign_status:VERIFIED"
      );
      expect(out.status).toBe("thinking");
    });

    it("rejected: keeps thinking, includes the retry-via-worker hint", () => {
      const out = formatTendlcAttachProgress(
        { kind: "rejected", reason: "10dlc/422 brand_unverified" },
        "+15550003333"
      );
      expect(out.message).toBe(
        "SMS 10DLC rejected: 10dlc/422 brand_unverified. Retrying via worker."
      );
      expect(out.status).toBe("thinking");
    });

    it("error (transient): keeps thinking, distinguishes 'transient failure' wording from rejected", () => {
      const out = formatTendlcAttachProgress(
        { kind: "error", reason: "getCampaign_failed: ETIMEDOUT" },
        "+15550004444"
      );
      expect(out.message).toBe(
        "SMS 10DLC transient failure: getCampaign_failed: ETIMEDOUT. Retrying via worker."
      );
      expect(out.status).toBe("thinking");
    });

    it("falls back to 'unknown' reason when the outcome shape is missing it", () => {
      // Defence against future TendlcAttachOutcome variants that forget
      // to populate `reason` — the progress copy must not render 'undefined'.
      const out = formatTendlcAttachProgress(
        { kind: "pending" },
        "+15550005555"
      );
      expect(out.message).toBe("SMS 10DLC queued (carrier vetting): unknown");
    });
  });
});

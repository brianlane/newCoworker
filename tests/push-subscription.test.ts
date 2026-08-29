import { describe, expect, it } from "vitest";
import { deviceLabelFromUserAgent, pushSubscriptionSchema } from "@/lib/push/subscription";

/**
 * The host allowlist is module-private and wired into the schema's refine, so
 * it is exercised the way production does: by parsing a subscription. That
 * also proves the guard is actually CONNECTED, which a direct call on the
 * predicate cannot show.
 */
function endpointAccepted(endpoint: string): boolean {
  return pushSubscriptionSchema.safeParse({
    endpoint,
    keys: { p256dh: "pub", auth: "auth" }
  }).success;
}

describe("push/subscription: push service endpoint allowlist", () => {
  /**
   * This is an SSRF guard. `endpoint` comes from the client and the server
   * then POSTs to it, so every case below is an access-control test, not
   * input tidiness.
   */
  it.each([
    ["Chrome / FCM", "https://fcm.googleapis.com/fcm/send/abc123"],
    ["Firefox", "https://updates.push.services.mozilla.com/wpush/v2/abc"],
    ["Firefox autopush shard", "https://autopush.push.services.mozilla.com/wpush/v2/abc"],
    ["Safari", "https://web.push.apple.com/QABC123"],
    ["Apple shard", "https://api.push.apple.com/QABC123"],
    ["Edge / WNS", "https://db5p.notify.windows.com/w/?token=abc"]
  ])("accepts a real %s endpoint", (_name, endpoint) => {
    expect(endpointAccepted(endpoint)).toBe(true);
  });

  it("rejects a host that merely starts with an allowlisted one", () => {
    // The dot-anchored suffix check is what makes this fail. A bare
    // `includes`/`startsWith` allowlist accepts it, and it is the single most
    // likely way this guard gets weakened later.
    expect(endpointAccepted("https://fcm.googleapis.com.evil.test/send/x")).toBe(false);
  });

  it("rejects an internal address", () => {
    expect(endpointAccepted("https://169.254.169.254/latest/meta-data/")).toBe(false);
    expect(endpointAccepted("https://localhost/send")).toBe(false);
    expect(endpointAccepted("https://10.0.0.1/send")).toBe(false);
  });

  it("rejects plaintext http even to an allowlisted host", () => {
    expect(endpointAccepted("http://fcm.googleapis.com/fcm/send/abc")).toBe(false);
  });

  it("rejects credentials smuggled in the authority", () => {
    // The hostname here is evil.test; the allowlisted string is only userinfo.
    expect(endpointAccepted("https://fcm.googleapis.com@evil.test/send/x")).toBe(false);
  });

  it("rejects an unparseable endpoint", () => {
    expect(endpointAccepted("not a url")).toBe(false);
  });

  it("rejects an over-long endpoint", () => {
    expect(
      endpointAccepted(`https://fcm.googleapis.com/fcm/send/${"a".repeat(2100)}`)
    ).toBe(false);
  });

  it("matches the allowlisted host case-insensitively", () => {
    expect(endpointAccepted("https://FCM.GoogleAPIs.com/fcm/send/abc")).toBe(true);
  });
});

describe("push/subscription: pushSubscriptionSchema", () => {
  const valid = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    keys: { p256dh: "BPublicKey", auth: "AuthSecret" }
  };

  it("accepts a browser subscription", () => {
    expect(pushSubscriptionSchema.parse(valid).endpoint).toBe(valid.endpoint);
  });

  it("accepts the expirationTime browsers send", () => {
    expect(pushSubscriptionSchema.parse({ ...valid, expirationTime: null }).endpoint).toBe(
      valid.endpoint
    );
  });

  /** The guard is wired into the schema, not just available beside it. */
  it("rejects a disallowed endpoint at parse time", () => {
    const result = pushSubscriptionSchema.safeParse({
      ...valid,
      endpoint: "https://169.254.169.254/x"
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing key", () => {
    expect(
      pushSubscriptionSchema.safeParse({ ...valid, keys: { p256dh: "x" } }).success
    ).toBe(false);
  });
});

describe("push/subscription: deviceLabelFromUserAgent", () => {
  it.each([
    [
      "iPhone Safari",
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"
    ],
    [
      "Android Chrome",
      "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/126.0.0.0 Mobile Safari/537.36"
    ],
    [
      "Chrome on Mac",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36"
    ],
    [
      "Edge on Windows",
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0"
    ],
    [
      "Firefox on Linux",
      "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0"
    ],
    [
      "iPad Safari",
      "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1"
    ]
  ])("labels %s", (expected, ua) => {
    expect(deviceLabelFromUserAgent(ua)).toBe(expected);
  });

  it("falls back when there is no user agent", () => {
    expect(deviceLabelFromUserAgent(null)).toBe("Unknown device");
    expect(deviceLabelFromUserAgent("   ")).toBe("Unknown device");
    expect(deviceLabelFromUserAgent(undefined)).toBe("Unknown device");
  });

  it("degrades to a generic label for an unrecognised agent", () => {
    expect(deviceLabelFromUserAgent("SomeBot/1.0")).toBe("Browser");
  });
});

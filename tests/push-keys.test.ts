import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicVapidKey, vapidKeysFromEnv } from "@/lib/push/keys";
import { urlBase64ToUint8Array } from "@/lib/push/vapid";

const ENV_KEYS = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of ENV_KEYS) saved[key] = process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>) {
  const base = {
    VAPID_PUBLIC_KEY: "BPublicKeyBase64Url",
    VAPID_PRIVATE_KEY: "PrivateKeyBase64Url",
    VAPID_SUBJECT: "mailto:alerts@newcoworker.com"
  };
  for (const [key, value] of Object.entries({ ...base, ...over })) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe("push/keys: vapidKeysFromEnv", () => {
  it("resolves all three when they are set", () => {
    setEnv({});
    expect(vapidKeysFromEnv()).toEqual({
      publicKey: "BPublicKeyBase64Url",
      privateKey: "PrivateKeyBase64Url",
      subject: "mailto:alerts@newcoworker.com"
    });
  });

  it("accepts an https contact URI, which RFC 8292 also allows", () => {
    setEnv({ VAPID_SUBJECT: "https://newcoworker.com/contact" });
    expect(vapidKeysFromEnv()?.subject).toBe("https://newcoworker.com/contact");
  });

  /**
   * All three or nothing. A half-configured environment must read as
   * unconfigured, so a preview refuses to mint subscriptions rather than
   * minting ones that can never be delivered to.
   */
  it.each(ENV_KEYS)("returns null when %s is missing", (missing) => {
    setEnv({ [missing]: undefined });
    expect(vapidKeysFromEnv()).toBeNull();
  });

  it.each(ENV_KEYS)("returns null when %s is blank", (blank) => {
    setEnv({ [blank]: "   " });
    expect(vapidKeysFromEnv()).toBeNull();
  });

  it("rejects a subject that is neither mailto: nor https:", () => {
    // web-push refuses this at send time, which would turn a config typo into
    // a per-dispatch failure instead of a visible misconfiguration.
    setEnv({ VAPID_SUBJECT: "alerts@newcoworker.com" });
    expect(vapidKeysFromEnv()).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    setEnv({ VAPID_PUBLIC_KEY: "  BPublicKeyBase64Url  " });
    expect(vapidKeysFromEnv()?.publicKey).toBe("BPublicKeyBase64Url");
  });
});

describe("push/keys: publicVapidKey", () => {
  it("returns just the public half", () => {
    setEnv({});
    expect(publicVapidKey()).toBe("BPublicKeyBase64Url");
  });

  it("returns null when unconfigured, so the route can answer 503", () => {
    setEnv({ VAPID_PRIVATE_KEY: undefined });
    expect(publicVapidKey()).toBeNull();
  });
});

describe("push/vapid: urlBase64ToUint8Array", () => {
  it("decodes base64url to the original bytes", () => {
    // "Hello" in base64url.
    expect(Array.from(urlBase64ToUint8Array("SGVsbG8"))).toEqual([72, 101, 108, 108, 111]);
  });

  it("restores stripped padding", () => {
    // Length 6 needs two '=' to reach a multiple of four.
    expect(Array.from(urlBase64ToUint8Array("SGVsbG8h"))).toEqual([72, 101, 108, 108, 111, 33]);
  });

  it("maps the base64url alphabet back to standard base64", () => {
    // 0xFB 0xFF encodes as "+/8" in base64 and "-_8" in base64url; decoding
    // the base64url form without the replace step throws or yields garbage.
    expect(Array.from(urlBase64ToUint8Array("-_8"))).toEqual([251, 255]);
  });

  it("produces a real ArrayBuffer, which is what applicationServerKey requires", () => {
    // Not just a type concern: a SharedArrayBuffer-backed view is rejected as
    // a BufferSource at runtime in some engines.
    expect(urlBase64ToUint8Array("SGVsbG8").buffer).toBeInstanceOf(ArrayBuffer);
  });

  it("handles an empty string", () => {
    expect(urlBase64ToUint8Array("").length).toBe(0);
  });
});

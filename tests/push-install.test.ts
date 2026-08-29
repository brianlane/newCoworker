import { describe, expect, it } from "vitest";
import { installCoachState, type InstallCoachInput } from "@/lib/push/install";

/**
 * The whole opt-in UI is a render of this function, so these cases are the
 * feature's real behaviour spec.
 */

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPHONE_15 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.6 Mobile/15E148 Safari/604.1";
const IPHONE_16_4 =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.4 Mobile/15E148 Safari/604.1";
/** iPadOS 13+ reports this. There is no iPad token anywhere in it. */
const IPADOS =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const MAC_CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const ANDROID_CHROME =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36";
const INSTAGRAM_WEBVIEW =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Instagram 300.0.0.0.0";

function input(over: Partial<InstallCoachInput> = {}): InstallCoachInput {
  return {
    userAgent: MAC_CHROME,
    maxTouchPoints: 0,
    standalone: false,
    hasPushManager: true,
    permission: "default",
    subscribed: false,
    ...over
  };
}

describe("push/install: installCoachState", () => {
  it("reports an existing subscription before anything else", () => {
    expect(installCoachState(input({ subscribed: true }))).toBe("enabled");
  });

  it("offers the prompt on a capable desktop browser", () => {
    expect(installCoachState(input())).toBe("prompt");
  });

  it("offers the prompt on Android Chrome without any install step", () => {
    expect(installCoachState(input({ userAgent: ANDROID_CHROME }))).toBe("prompt");
  });

  /**
   * THE REGRESSION THIS FILE EXISTS FOR.
   *
   * Outside a Home Screen app, iOS Safari does not expose PushManager, so an
   * implementation that feature-detects BEFORE checking standalone reports
   * "unsupported" and hides the install coaching on exactly the devices that
   * need it. The owner is never told the one thing that would make push work,
   * and the bug is invisible to anyone testing on a desktop.
   */
  it("coaches an iPhone to install even though PushManager is absent there", () => {
    expect(
      installCoachState(
        input({ userAgent: IPHONE, standalone: false, hasPushManager: false })
      )
    ).toBe("needs_ios_install");
  });

  it("coaches an iPhone to install even when PushManager happens to be present", () => {
    expect(installCoachState(input({ userAgent: IPHONE, standalone: false }))).toBe(
      "needs_ios_install"
    );
  });

  it("prompts inside an installed iOS web app", () => {
    expect(installCoachState(input({ userAgent: IPHONE, standalone: true }))).toBe("prompt");
  });

  /**
   * iPadOS sends a desktop Macintosh UA. Touch points are the only thing
   * separating it from a real Mac, and without that clause every iPad owner
   * falls through to the desktop path and silently never gets an alert.
   */
  it("treats a touch-capable Macintosh UA as iPadOS", () => {
    expect(installCoachState(input({ userAgent: IPADOS, maxTouchPoints: 5 }))).toBe(
      "needs_ios_install"
    );
  });

  it("treats a Macintosh UA with no touch points as a real Mac", () => {
    expect(installCoachState(input({ userAgent: IPADOS, maxTouchPoints: 0 }))).toBe("prompt");
  });

  it("sends an in-app webview to a real browser instead of describing a Share menu", () => {
    expect(installCoachState(input({ userAgent: INSTAGRAM_WEBVIEW }))).toBe("needs_browser");
  });

  it("calls iOS below 16.4 unsupported rather than sending them to install", () => {
    expect(installCoachState(input({ userAgent: IPHONE_15 }))).toBe("unsupported");
  });

  it("treats iOS 16.4 itself as capable, since that is the version that shipped push", () => {
    expect(installCoachState(input({ userAgent: IPHONE_16_4 }))).toBe("needs_ios_install");
  });

  it("treats an unreadable iOS version as capable, because the unreadable case is iPadOS", () => {
    // A coach shown to someone on 15 is a mild annoyance; a coach hidden from
    // someone on 17 is a lost install.
    expect(installCoachState(input({ userAgent: IPADOS, maxTouchPoints: 5 }))).toBe(
      "needs_ios_install"
    );
  });

  it("reports unsupported when the browser has no PushManager at all", () => {
    expect(installCoachState(input({ hasPushManager: false }))).toBe("unsupported");
  });

  it("reports blocked when permission was denied", () => {
    expect(installCoachState(input({ permission: "denied" }))).toBe("blocked");
  });

  it("prompts when permission was already granted but nothing is subscribed", () => {
    // Granting permission and registering a subscription are two steps; a
    // browser that has the first without the second must be offered the second.
    expect(installCoachState(input({ permission: "granted" }))).toBe("prompt");
  });
});

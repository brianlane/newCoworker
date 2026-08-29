/**
 * "Can this browser receive push, and if not, what does the person do next?"
 *
 * Pure, and it is the ENTIRE decision surface for the opt-in UI. The
 * component reads a handful of browser globals, passes them in as plain
 * values, and renders whatever comes back. That split is what keeps the
 * decision under the lib coverage gate (no jsdom needed) and keeps the
 * component render-only, the same shape as
 * src/lib/hipaa/session-timeout.ts and HipaaIdleLogout.
 */

export type InstallCoachState =
  /** A live subscription already exists for this browser. */
  | "enabled"
  /** Push works here and permission has not been asked for yet. */
  | "prompt"
  /** iOS, but not launched from the Home Screen. Push cannot work until it is. */
  | "needs_ios_install"
  /** An in-app webview (Instagram, Gmail, WeChat): no install, no push. */
  | "needs_browser"
  /** Permission was denied. Cannot be re-prompted from script. */
  | "blocked"
  /** This browser cannot do Web Push at all. */
  | "unsupported";

export type InstallCoachInput = {
  userAgent: string;
  /** `navigator.maxTouchPoints`. Load-bearing for iPadOS; see below. */
  maxTouchPoints: number;
  /** display-mode standalone, or the legacy iOS `navigator.standalone`. */
  standalone: boolean;
  /** `"PushManager" in window`. */
  hasPushManager: boolean;
  permission: "default" | "granted" | "denied";
  /** A live `pushManager.getSubscription()` was found for this browser. */
  subscribed: boolean;
};

/**
 * iPadOS 13 and later report a DESKTOP Macintosh user agent, with no iPad
 * token anywhere in it. The only thing separating an iPad from a real Mac in
 * script is that the iPad reports touch points. Without the second clause
 * every iPad owner falls through to the desktop path, is told push is
 * unsupported, and silently never receives an alert.
 */
function isIosLike(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  return userAgent.includes("Macintosh") && maxTouchPoints > 1;
}

/**
 * In-app webviews render pages inside another app (Instagram, Facebook,
 * Gmail, LINE, WeChat). They have no Add to Home Screen and no push, so
 * coaching someone here to find a Share menu item that does not exist is
 * worse than saying nothing.
 */
function isInAppBrowser(userAgent: string): boolean {
  return /FBAN|FBAV|Instagram|Line\/|MicroMessenger|GSA\//.test(userAgent);
}

/**
 * iOS version, when the user agent admits it. Returns null for the
 * Macintosh-shaped iPadOS UA, which carries no OS version at all.
 */
function iosVersion(userAgent: string): { major: number; minor: number } | null {
  const match = /OS (\d+)_(\d+)/.exec(userAgent);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/** Safari shipped Web Push for installed web apps in iOS 16.4. */
function iosCanEverPush(userAgent: string): boolean {
  const version = iosVersion(userAgent);
  // Unknown reads as capable on purpose: the unreadable case is iPadOS, and
  // a coach shown to someone on iOS 15 is a mild annoyance while a coach
  // hidden from someone on 17 is a lost install.
  if (!version) return true;
  if (version.major > 16) return true;
  return version.major === 16 && version.minor >= 4;
}

/**
 * Is this worth interrupting someone on the dashboard for?
 *
 * TWO conditions, and the standalone one is the important half: the banner
 * appears ONLY inside the installed app, never in a browser tab.
 *
 * In a tab it was worse than useless. On iOS the only state a tab can produce
 * is `needs_ios_install`, which has nothing to tap, so the banner rendered
 * three lines of Share-menu instructions above a lone "Not now" and read as a
 * broken control. On desktop it offered a real button, but push in a tab dies
 * with the tab's site data and is not the surface this feature is for.
 *
 * That leaves exactly one state worth an interruption: `prompt`, inside the
 * app, where a single tap finishes the job. `needs_ios_install` is now
 * unreachable here by construction, because being standalone IS being
 * installed.
 *
 * The settings card still explains every state, including the install steps
 * and the ones nobody can act on. Someone who goes LOOKING deserves the whole
 * picture; a banner that interrupts has to be actionable or silent.
 */
export function shouldOfferPushBanner(state: InstallCoachState, standalone: boolean): boolean {
  return standalone && state === "prompt";
}

export function installCoachState(input: InstallCoachInput): InstallCoachState {
  if (input.subscribed) return "enabled";

  if (isInAppBrowser(input.userAgent)) return "needs_browser";

  const ios = isIosLike(input.userAgent, input.maxTouchPoints);

  if (ios) {
    if (!iosCanEverPush(input.userAgent)) return "unsupported";
    /**
     * THE ORDERING HERE IS THE WHOLE POINT, and getting it backwards is the
     * single most common way an iOS PWA push feature ships broken.
     *
     * Outside a Home Screen app, iOS Safari does not expose PushManager at
     * all. So a feature-detect-first implementation asks `hasPushManager`,
     * gets false, concludes "this browser cannot do push", and hides the
     * install coaching on precisely the devices that require it. The owner
     * is never told the one thing that would make it work, and the feature
     * looks finished to everyone testing on a desktop.
     *
     * The install check therefore runs BEFORE any capability check.
     */
    if (!input.standalone) return "needs_ios_install";
  }

  if (!input.hasPushManager) return "unsupported";
  if (input.permission === "denied") return "blocked";
  return "prompt";
}

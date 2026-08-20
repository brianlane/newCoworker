import type { AbstractIntlMessages } from "next-intl";

/**
 * Route-to-namespace mapping for client-side i18n messages.
 *
 * Why this exists: the root layout used to hand the ENTIRE message catalog to
 * `NextIntlClientProvider`, which serializes it into an inline script on every
 * page. Measured on the production 404 (Aug 3 2026): 165KB of a 183KB page was
 * that one script, all nine namespaces shipped to render three strings. The
 * catalog is only needed client-side by components calling `useTranslations`,
 * and those form a small, statically-knowable set.
 *
 * So each section of the app now has a provider that carries only what its
 * client components actually consume. Server components are unaffected:
 * `getTranslations` reads from the request config, never from the provider.
 *
 * The contract, enforced by `tests/i18n-client-messages.test.ts`: for every
 * route, every client component reachable from it (walking the import graph)
 * must have its `useTranslations` namespace covered by the providers wrapping
 * that route. Adding a `useTranslations` call with a new namespace, or
 * importing a translated client component into a new section, fails that test
 * until the mapping here is updated. That turns "silently broken at runtime"
 * into "red in CI".
 *
 * When editing, prefer the narrowest path that covers the usage: listing
 * "dashboard" instead of "dashboard.nav" would quietly reinflate every
 * dashboard page by 34KB.
 *
 * Cross-section entries are deliberate, not mistakes:
 * - dashboard ships `marketing.orderSummary` because billing renders
 *   MembershipPackAddOns via PlanCard -> ChangePlanSelector,
 * - onboard ships `auth` because the success page renders password setup.
 */

/**
 * Namespaces every page needs: `errorPage` because the root error boundary can
 * replace any page's content while keeping the root provider's context, and
 * `common` because LanguageSwitcher renders in both marketing nav and
 * dashboard settings. Together they are ~465 bytes.
 */
export const GLOBAL_CLIENT_MESSAGE_PATHS = ["common", "errorPage"] as const;

/**
 * Per-section providers. `appDir` is relative to `src/app` and names the
 * directory whose `layout.tsx` renders the provider; `paths` are the message
 * subtrees that provider adds on top of the global set. The guard test reads
 * this structure directly, so renaming a directory without updating it fails
 * in CI rather than at runtime.
 */
export const SECTION_CLIENT_MESSAGES = {
  marketing: {
    appDir: "(marketing)",
    paths: [
      "marketing.nav",
      "marketing.footer",
      "marketing.contactPage",
      "marketing.planCards"
    ]
  },
  auth: {
    appDir: "(auth)",
    paths: ["auth"]
  },
  onboard: {
    appDir: "onboard",
    paths: [
      "auth",
      "marketing.nav",
      "marketing.onboard",
      "marketing.orderSummary",
      "marketing.planCards",
      "marketing.questionnaire"
    ]
  },
  dashboard: {
    appDir: "dashboard",
    paths: [
      "dashboard.activityBadge",
      "dashboard.activityFilters",
      "dashboard.billing.autoReload",
      "dashboard.billing.prioritySupport",
      "dashboard.bookings",
      "dashboard.bulk",
      "dashboard.companion",
      "dashboard.contacts",
      "dashboard.deals",
      "dashboard.employeeAvailability",
      "dashboard.fubImport",
      "dashboard.humanHandoff",
      "dashboard.integrationsGoogleMeet",
      "dashboard.integrationsMcp",
      "dashboard.integrationsSlack",
      "dashboard.integrationsWorkspace",
      "dashboard.integrationsZoom",
      "dashboard.leadAssignment",
      "dashboard.leadClaim",
      "dashboard.nav",
      "dashboard.notes",
      "dashboard.pages",
      "dashboard.phoneDeliverability",
      "dashboard.planCard",
      "dashboard.prospecting",
      "dashboard.segments.actions",
      "dashboard.settings",
      "dashboard.smsComposer",
      "dashboard.tasksData",
      "dashboard.termsGate",
      "dashboard.idleLogout",
      "dashboard.trackedLinks",
      "marketing.orderSummary"
    ]
  },
  admin: {
    appDir: "admin/(protected)",
    // SafeModeToggle renders on the admin business page too, so its
    // deliverability warning namespace ships with the admin section.
    paths: ["admin", "dashboard.phoneDeliverability"]
  }
} as const;

type MessageTree = AbstractIntlMessages;

/**
 * Deep-picks dot-separated paths out of a message tree, preserving nesting so
 * the result is a valid (partial) catalog for `NextIntlClientProvider`.
 * Unknown paths are skipped silently on purpose: the guard test asserts every
 * configured path exists in both catalogs, so a miss here means the test suite
 * was not run, and crashing a live page over it would invert the priorities.
 */
export function pickMessages(
  messages: MessageTree,
  paths: readonly string[]
): MessageTree {
  const result: Record<string, unknown> = {};
  for (const path of paths) {
    const keys = path.split(".");
    let source: unknown = messages;
    for (const key of keys) {
      if (typeof source !== "object" || source === null) {
        source = undefined;
        break;
      }
      source = (source as Record<string, unknown>)[key];
    }
    if (source === undefined) continue;

    let target = result;
    for (const key of keys.slice(0, -1)) {
      const existing = target[key];
      if (typeof existing === "object" && existing !== null) {
        target = existing as Record<string, unknown>;
      } else {
        const next: Record<string, unknown> = {};
        target[key] = next;
        target = next;
      }
    }
    target[keys[keys.length - 1]] = source;
  }
  return result as MessageTree;
}

/** The global subset plus one section's additions, ready for a provider. */
export function sectionClientMessages(
  messages: MessageTree,
  section: keyof typeof SECTION_CLIENT_MESSAGES
): MessageTree {
  return pickMessages(messages, [
    ...GLOBAL_CLIENT_MESSAGE_PATHS,
    ...SECTION_CLIENT_MESSAGES[section].paths
  ]);
}
